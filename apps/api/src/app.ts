import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Database, verifyPassword } from './db.js';
import { FleetService, type Actor } from './service.js';
import {
  Message,
  Problem,
  uuid,
  destination,
  tokenHash,
} from '../../../packages/core/src/domain.js';

interface Session {
  actor: Actor;
  csrf: string;
  expiresAt: Date;
}
export interface AppOptions {
  db: Database;
  demo?: boolean;
  demoRole?: 'viewer' | 'admin';
  secureCookies?: boolean;
  origin?: string;
  serveWeb?: boolean;
  logging?: boolean;
}
export async function createApp(options: AppOptions) {
  const { db } = options,
    service = new FleetService(db);
  const origin = options.origin ?? 'http://127.0.0.1:3080';
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    logger: options.logging
      ? {
          level: 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
        }
      : false,
    requestTimeout: 10000,
    connectionTimeout: 10000,
  });
  const metrics = new Registry();
  const etaGauges = Object.fromEntries(
    [
      ['predictions', 'predictions', 'Dispatch predictions in the most recent 500'],
      ['labeled', 'labeled', 'Completed predictions with usable receipt-based labels'],
      [
        'reconciled_excluded',
        'reconciled_excluded',
        'Reconciled completions excluded from error metrics',
      ],
      ['mae_seconds', 'mae_seconds', 'Mean absolute error against observed completion receipts'],
      [
        'baseline_mae_seconds',
        'baseline_mae_seconds',
        'Distance/speed baseline mean absolute error',
      ],
      [
        'interval_coverage',
        'interval_coverage',
        'Empirical interval coverage against completion receipts',
      ],
    ].map(([key, name, help]) => [
      key!,
      new Gauge({
        name: `fleetdeck_eta_recent_${name}`,
        help: help!,
        labelNames: ['source', 'model_version'],
        registers: [metrics],
      }),
    ]),
  );
  const admitted = new Counter({
    name: 'fleetdeck_admitted_total',
    help: 'New durable message admissions',
    registers: [metrics],
  });
  const duplicate = new Counter({
    name: 'fleetdeck_duplicate_total',
    help: 'Unchanged retried message identities',
    registers: [metrics],
  });
  const requestDuration = new Histogram({
    name: 'fleetdeck_request_duration_seconds',
    help: 'HTTP request time',
    labelNames: ['method', 'route', 'status'],
    registers: [metrics],
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: options.secureCookies ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 3000, timeWindow: '1 minute' });
  const starts = new WeakMap<FastifyRequest, bigint>();
  app.addHook('onRequest', async (req) => {
    starts.set(req, process.hrtime.bigint());
  });
  app.addHook('onResponse', async (req, reply) => {
    const start = starts.get(req);
    if (start)
      requestDuration
        .labels(req.method, req.routeOptions.url ?? 'unmatched', String(reply.statusCode))
        .observe(Number(process.hrtime.bigint() - start) / 1e9);
  });
  async function session(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const row = (
      await db.pool.query<{
        id: string;
        name: string;
        role: Actor['role'];
        csrf: string;
        expires_at: Date;
      }>(
        'SELECT u.id,u.name,u.role,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',
        [tokenHash(token), db.now()],
      )
    ).rows[0];
    return row
      ? {
          actor: { id: row.id, name: row.name, role: row.role },
          csrf: row.csrf,
          expiresAt: row.expires_at,
        }
      : null;
  }
  function checkOrigin(req: FastifyRequest): void {
    if (req.headers.origin && req.headers.origin !== origin)
      throw new Problem(403, 'origin_rejected', 'This origin is not allowed.');
  }
  async function operator(
    req: FastifyRequest,
    write = false,
    admin = false,
    allowViewer = false,
  ): Promise<Actor> {
    const s = await session(req.cookies.fd_session);
    if (!s) throw new Problem(401, 'unauthenticated', 'Sign in to open the control room.');
    if (write) {
      checkOrigin(req);
      const supplied = req.headers['x-csrf-token'];
      if (
        typeof supplied !== 'string' ||
        !/^[a-f0-9]{48}$/.test(supplied) ||
        supplied.length !== s.csrf.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(s.csrf))
      )
        throw new Problem(403, 'csrf_rejected', 'Your session changed. Refresh and try again.');
      if (s.actor.role === 'viewer' && !allowViewer)
        throw new Problem(403, 'read_only', 'This demo account is read only.');
    }
    if (admin && s.actor.role !== 'admin')
      throw new Problem(403, 'forbidden', 'Administrator access is required.');
    return s.actor;
  }
  async function gateway(req: FastifyRequest): Promise<string> {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer '))
      throw new Problem(401, 'invalid_gateway_key', 'A gateway key is required.');
    const key = value.slice(7);
    if (key.length < 24 || key.length > 256)
      throw new Problem(401, 'invalid_gateway_key', 'Invalid gateway key.');
    const row = (
      await db.pool.query<{ site_id: string }>(
        'SELECT site_id FROM ingest_keys WHERE key_hash=$1',
        [tokenHash(key)],
      )
    ).rows[0];
    if (!row) throw new Problem(401, 'invalid_gateway_key', 'Invalid gateway key.');
    return row.site_id;
  }
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(422)
        .type('application/problem+json')
        .send({
          type: 'about:blank',
          title: 'Invalid request',
          status: 422,
          code: 'validation_failed',
          detail: 'Check the supplied fields.',
          requestId: req.id,
          fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
    if (error instanceof Problem) {
      if (error.status === 503) reply.header('Retry-After', '5');
      return reply.code(error.status).type('application/problem+json').send({
        type: 'about:blank',
        title: error.code,
        status: error.status,
        code: error.code,
        detail: error.message,
        current: error.current,
        requestId: req.id,
      });
    }
    const code = (error as { code?: string }).code;
    if (code === '23505')
      return reply.code(409).send({
        code: 'concurrent_conflict',
        detail: 'Another request reserved this resource. Refresh and try again.',
        requestId: req.id,
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        code: 'invalid_request',
        detail:
          status === 429
            ? 'Too many requests. Please retry shortly.'
            : 'The request could not be accepted.',
        requestId: req.id,
      });
    req.log.error({ err: error, requestId: req.id }, 'Request failed');
    return reply.code(500).send({
      code: 'internal_error',
      detail: 'The request failed. Retry with the same idempotency key.',
      requestId: req.id,
    });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    const applied = await db.pool.query("SELECT 1 FROM schema_migrations WHERE version='004'");
    if (!applied.rowCount)
      throw new Problem(
        503,
        'schema_not_ready',
        'Apply database migrations before serving traffic.',
      );
    return { status: 'ready' };
  });
  app.get('/v1/me', async (req) => {
    const s = await session(req.cookies.fd_session);
    if (!s) throw new Problem(401, 'unauthenticated', 'Sign in to continue.');
    return { user: s.actor, csrf: s.csrf, demo: !!options.demo };
  });
  const Login = z
    .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
    .strict();
  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      checkOrigin(req);
      const body = Login.parse(req.body);
      const user = (
        await db.pool.query<Actor & { password_hash: string }>(
          'SELECT id,name,role,password_hash FROM users WHERE email=$1',
          [body.email.toLowerCase()],
        )
      ).rows[0];
      if (!user || !verifyPassword(body.password, user.password_hash))
        throw new Problem(401, 'invalid_credentials', 'Email or password was not recognized.');
      await createSession(user, req, reply);
      return { ok: true };
    },
  );
  async function createSession(
    user: Actor,
    req: FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void> {
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(24).toString('hex');
    await db.transaction(async (tx) => {
      if (req.cookies.fd_session)
        await tx.query('DELETE FROM sessions WHERE token_hash=$1', [
          tokenHash(req.cookies.fd_session),
        ]);
      await tx.query(
        'INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)',
        [tokenHash(token), user.id, csrf, new Date(db.now().getTime() + 8 * 3600000)],
      );
    });
    reply.setCookie('fd_session', token, {
      httpOnly: true,
      secure: !!options.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 3600,
    });
  }
  app.post(
    '/v1/auth/demo',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      checkOrigin(req);
      if (!options.demo) throw new Problem(404, 'not_found', 'Not found.');
      const role = options.demoRole ?? 'viewer';
      const user = (
        await db.pool.query<Actor>('SELECT id,name,role FROM users WHERE email=$1', [
          role === 'admin' ? 'demo@fleetdeck.local' : 'viewer@fleetdeck.local',
        ])
      ).rows[0];
      if (!user) throw new Problem(503, 'not_seeded', 'The demo has not been seeded.');
      await createSession(user, req, reply);
      return { ok: true };
    },
  );
  app.post('/v1/auth/logout', async (req, reply) => {
    await operator(req, true, false, true);
    await db.pool.query('DELETE FROM sessions WHERE token_hash=$1', [
      tokenHash(req.cookies.fd_session ?? ''),
    ]);
    reply.clearCookie('fd_session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/state', async (req, reply) => {
    await operator(req);
    reply.header('Cache-Control', 'no-store');
    return service.state();
  });
  app.get('/v1/eta', async (req, reply) => {
    await operator(req);
    const query = z.object({ vehicleId: uuid, destination }).strict().parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return service.previewEta(query.vehicleId, query.destination);
  });
  app.get('/v1/eta/monitoring', async (req, reply) => {
    const actor = await operator(req);
    if (actor.role !== 'admin')
      throw new Problem(403, 'forbidden', 'Administrator access required.');
    reply.header('Cache-Control', 'no-store');
    return service.etaMonitoring();
  });
  for (const kind of ['vehicle', 'incident', 'mission'] as const)
    app.get(`/v1/${kind}s/:id`, async (req) => {
      await operator(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      return service.detail(kind, id);
    });
  app.post('/v1/missions', async (req, reply) => {
    const actor = await operator(req, true);
    const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    const body = z.object({ vehicleId: uuid, destination }).strict().parse(req.body);
    const response = await service.dispatch(actor, key, body);
    reply.code(201);
    return response;
  });
  app.post('/v1/missions/:id/cancel', async (req) => {
    const actor = await operator(req, true);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    await service.cancel(actor, id, version);
    return { ok: true };
  });
  app.post('/v1/incidents/:id/actions', async (req) => {
    const actor = await operator(req, true);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        action: z.enum(['acknowledge', 'assign', 'resolve']),
        version: z.number().int().positive(),
        note: z.string().trim().min(1).max(1000).optional(),
      })
      .strict()
      .parse(req.body);
    await service.incidentAction(actor, id, body);
    return { ok: true };
  });
  app.post('/v1/ingest/sessions', async (req) => {
    const site = await gateway(req);
    const body = z.object({ vehicleId: uuid, bootId: uuid }).strict().parse(req.body);
    return service.registerBoot(site, body.vehicleId, body.bootId);
  });
  app.post('/v1/ingest/telemetry', async (req, reply) => {
    const site = await gateway(req);
    const { messages } = z
      .object({ messages: z.array(Message).min(1).max(500) })
      .strict()
      .parse(req.body);
    const result = await service.ingest(site, messages);
    admitted.inc(result.accepted);
    duplicate.inc(result.duplicates);
    return reply.code(202).send(result);
  });
  app.get('/v1/gateway/vehicles', async (req) => {
    const site = await gateway(req);
    return {
      vehicles: (
        await db.pool.query(
          'SELECT id,name,x,y,battery FROM vehicles WHERE site_id=$1 ORDER BY name',
          [site],
        )
      ).rows,
      scenarios: options.demo
        ? (
            await db.pool.query(
              'SELECT d.* FROM demo_scenarios d JOIN vehicles v ON v.id=d.vehicle_id WHERE v.site_id=$1 AND expires_at>$2',
              [site, db.now()],
            )
          ).rows
        : [],
    };
  });
  app.get('/v1/gateway/vehicles/:id/commands', async (req) => {
    const site = await gateway(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { commands: await service.commands(site, id) };
  });
  app.post('/v1/sim/scenario', async (req) => {
    const actor = await operator(req, true, true);
    if (!options.demo) throw new Problem(404, 'not_found', 'Not found.');
    const body = z
      .object({
        vehicleId: uuid,
        kind: z.enum(['normal', 'offline', 'battery_low', 'stuck', 'lost_ack']),
      })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const v = await tx.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE', [body.vehicleId]);
      if (!v.rowCount) throw new Problem(404, 'vehicle_not_found', 'Vehicle not found.');
      await tx.query(
        'INSERT INTO demo_scenarios(vehicle_id,kind,expires_at) VALUES($1,$2,$3) ON CONFLICT(vehicle_id) DO UPDATE SET kind=EXCLUDED.kind,expires_at=EXCLUDED.expires_at',
        [body.vehicleId, body.kind, new Date(db.now().getTime() + 120000)],
      );
      await tx.query(
        'INSERT INTO audit_log(actor_id,action,subject_id,at,data) VALUES($1,$2,$3,$4,$5)',
        [actor.id, 'simulator.scenario', body.vehicleId, db.now(), { kind: body.kind }],
      );
    });
    return { ok: true };
  });
  app.get('/metrics', async (req, reply) => {
    await operator(req, false, true);
    const monitoring = await service.etaMonitoring();
    for (const gauge of Object.values(etaGauges)) gauge.reset();
    for (const row of monitoring.recent) {
      for (const [key, gauge] of Object.entries(etaGauges)) {
        if (row[key] !== null && Number.isFinite(Number(row[key])))
          gauge.labels(row.source, row.model_version ?? 'none').set(Number(row[key]));
      }
    }
    return reply.type(metrics.contentType).send(await metrics.metrics());
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      if (req.url !== '/v1/ws' || req.headers.origin !== origin) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const cookies = app.parseCookie(req.headers.cookie ?? '');
      const s = await session(cookies.fd_session);
      if (!s || ws.clients.size >= 200) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      ws.handleUpgrade(req, socket, head, (client) => {
        client.send(JSON.stringify({ t: 'ready', expiresAt: s.expiresAt }));
        client.on('error', () => client.terminate());
        client.on('message', () => client.close(1008, 'Subscriptions are server managed.'));
        const expiry = setTimeout(
          () => client.close(1008, 'Session expired'),
          Math.max(0, s.expiresAt.getTime() - db.now().getTime()),
        );
        expiry.unref();
        client.once('close', () => clearTimeout(expiry));
      });
    })().catch(() => socket.destroy());
  });
  let dirty = true;
  const listener = await db.pool.connect();
  listener.on('notification', () => {
    dirty = true;
  });
  listener.on('error', () => {
    app.log.warn('Notification connection unavailable; clients use periodic reconciliation.');
  });
  await listener.query('LISTEN fleet_changed');
  const flush = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    for (const client of ws.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 64 * 1024) {
        client.close(1013, 'Resynchronize');
        continue;
      }
      client.send('{"t":"invalidate"}');
    }
  }, 250);
  flush.unref();
  app.addHook('onClose', async () => {
    clearInterval(flush);
    for (const client of ws.clients) client.terminate();
    ws.close();
    await listener.query('UNLISTEN *').catch(() => {});
    listener.release();
  });
  if (options.serveWeb !== false && existsSync(resolve('apps/web/dist'))) {
    await app.register(staticFiles, { root: resolve('apps/web/dist'), prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/v1/')
        ? reply.code(404).send({ code: 'not_found' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
