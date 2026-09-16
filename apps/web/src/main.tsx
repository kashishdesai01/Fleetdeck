import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Battery,
  Bell,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Crosshair,
  ExternalLink,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  MapPin,
  Navigation,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  FleetState,
  Vehicle,
  Incident,
  Mission,
  User,
  TimelineEvent,
  EtaPrediction,
} from './types';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';

type Page = 'overview' | 'fleet' | 'incidents' | 'missions' | 'activity';
type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'incident'; id: string }
  | { kind: 'mission'; id: string }
  | null;
const activeMission = (m: Mission) =>
  ['assigned', 'in_progress', 'uncertain', 'canceling'].includes(m.state);
const readable = (s: string) => s.replaceAll('_', ' ').replaceAll('.', ' · ');
function age(at: string | null, now = Date.now()): string {
  if (!at) return 'No observation';
  const delta = Math.floor((now - Date.parse(at)) / 1000);
  if (delta < -5) return `Clock +${-delta}s`;
  const s = Math.max(0, delta);
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : `${Math.floor(s / 3600)}h ago`;
}
function shortTime(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function badge(v: Vehicle): string {
  return !v.online ? 'offline' : v.battery < 20 ? 'low battery' : v.status;
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [csrf, setCsrf] = useState('');
  const [data, setData] = useState<FleetState | null>(null),
    [page, setPage] = useState<Page>('overview');
  const [selection, setSelection] = useState<Selection>(null),
    [dispatchOpen, setDispatchOpen] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [connected, setConnected] = useState(false),
    [demo, setDemo] = useState(false),
    [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [now, setNow] = useState(Date.now()),
    [mutating, setMutating] = useState(false);
  const [destination, setDestination] = useState('shipping'),
    [dispatchVehicle, setDispatchVehicle] = useState('');
  const [loginEmail, setLoginEmail] = useState(''),
    [loginPassword, setLoginPassword] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolving, setResolving] = useState(false);
  const mounted = useRef(true),
    generation = useRef(0),
    inFlight = useRef(false),
    pending = useRef(false),
    lastUpdated = useRef(Date.now());
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        pending.current = false;
        const gen = ++generation.current;
        const res = await fetch('/v1/state', {
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) {
          setUser(null);
          setData(null);
          break;
        }
        if (!res.ok) throw new Error('The control room could not synchronize.');
        const value = (await res.json()) as FleetState;
        if (mounted.current && gen === generation.current) {
          setData(value);
          setError('');
          lastUpdated.current = Date.now();
        }
      } while (pending.current && mounted.current);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Unable to synchronize.');
    } finally {
      inFlight.current = false;
    }
  }, []);
  const identify = useCallback(async () => {
    const res = await fetch('/v1/me');
    if (res.ok) {
      const s = (await res.json()) as { user: User; csrf: string; demo: boolean };
      setUser(s.user);
      setCsrf(s.csrf);
      setDemo(s.demo);
      await refresh();
    }
    setLoading(false);
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    void identify().catch(() => {
      setLoading(false);
      setError('The server is unavailable.');
    });
    return () => {
      mounted.current = false;
    };
  }, [identify]);
  useEffect(() => {
    if (!user) return;
    let disposed = false,
      ws: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (disposed) return;
      ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`,
      );
      ws.onopen = () => {
        if (!disposed) setConnected(true);
      };
      ws.onmessage = () => {
        if (!disposed) void refresh();
      }; // Ready confirms subscription before the authoritative snapshot.
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        if (!disposed) {
          setConnected(false);
          retry = setTimeout(open, 2500);
        }
      };
    };
    open();
    const poll = setInterval(() => void refresh(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      disposed = true;
      clearInterval(poll);
      clearInterval(tick);
      if (retry) clearTimeout(retry);
      ws?.close();
      window.removeEventListener('focus', focus);
    };
  }, [user, refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    setTimeline([]);
    setConfirmCancel(false);
    if (!selection) return;
    const controller = new AbortController();
    void fetch(`/v1/${selection.kind}s/${selection.id}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((v: { events?: TimelineEvent[] }) => setTimeline(v.events ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [
    selection,
    data?.incidents.find((i) => i.id === selection?.id)?.version,
    data?.missions.find((m) => m.id === selection?.id)?.version,
  ]);
  useEffect(() => {
    if (!selection) return;
    setResolving(false);
    setResolutionNote('');
    const previous = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>('.drawer');
    const selector = 'button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]';
    panel?.querySelector<HTMLElement>(selector)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSelection(null);
      }
      if (event.key !== 'Tab' || !panel) return;
      const elements = [...panel.querySelectorAll<HTMLElement>(selector)];
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [selection]);
  const write = async (
    path: string,
    body: unknown,
    success: string,
    key?: string,
  ): Promise<boolean> => {
    setMutating(true);
    setError('');
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      const value = (await res.json()) as { detail?: string };
      if (!res.ok) throw new Error(value.detail ?? 'The action could not be completed.');
      setNotice(success);
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action failed.');
      await refresh();
      return false;
    } finally {
      setMutating(false);
    }
  };
  const login = async (isDemo: boolean) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(isDemo ? '/v1/auth/demo' : '/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isDemo ? {} : { email: loginEmail, password: loginPassword }),
      });
      const body = (await res.json()) as { detail?: string };
      if (!res.ok) throw new Error(body.detail ?? 'Unable to sign in.');
      await identify();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally {
      setLoading(false);
    }
  };
  const openDispatch = (vehicle?: Vehicle) => {
    setDispatchVehicle(vehicle?.id ?? '');
    setDispatchOpen(true);
  };
  if (!user)
    return (
      <main className="login">
        <div className="login-art">
          <div className="login-grid" />
          <div className="login-wordmark">
            <Logo />
            fleetdeck
          </div>
          <div className="login-copy">
            <span className="eyebrow">EVERY VEHICLE. EVERY DECISION.</span>
            <h1>
              Clarity on the
              <br />
              operating floor.
            </h1>
            <p>
              Live visibility. Accountable dispatch.
              <br />A calmer way to run your fleet.
            </p>
          </div>
          <span className="login-foot">FLEET OPERATIONS / NORTHSTAR CAMPUS</span>
        </div>
        <section className="login-form">
          <div>
            <span className="eyebrow">OPERATIONS WORKSPACE</span>
            <h2>Welcome to Fleetdeck</h2>
            <p>
              One place to see what’s moving,
              <br />
              what needs attention, and what’s next.
            </p>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="primary wide" onClick={() => void login(true)} disabled={loading}>
              {loading ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <>
                  Explore the demo <ArrowRight size={17} />
                </>
              )}
            </button>
            <span className="login-divider">or sign in to your workspace</span>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login(false);
              }}
            >
              <label>
                Work email
                <input
                  type="email"
                  autoComplete="username"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  placeholder="you@company.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                />
              </label>
              <button className="secondary wide" disabled={loading}>
                Sign in
              </button>
            </form>
            <small>
              <ShieldCheck size={14} /> Synthetic vehicles. Real workflow semantics.
            </small>
          </div>
        </section>
      </main>
    );
  if (!data)
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <h2>Opening the control room</h2>
        {error && (
          <div role="alert">
            {error}
            <button onClick={() => void refresh()}>Try again</button>
          </div>
        )}
      </main>
    );
  const vehicles = data.vehicles.filter((v) => v.name.toLowerCase().includes(search.toLowerCase()));
  const open = data.incidents.filter((i) => i.state !== 'resolved');
  const incidents = data.incidents.filter(
    (i) =>
      (filter === 'all' || i.state === filter) &&
      (i.vehicle_name + ' ' + i.title).toLowerCase().includes(search.toLowerCase()),
  );
  const active = data.missions.filter(activeMission),
    online = data.vehicles.filter((v) => v.online).length,
    moving = data.vehicles.filter((v) => v.status === 'moving' || v.status === 'working').length;
  const chosenVehicle =
    selection?.kind === 'vehicle' ? data.vehicles.find((v) => v.id === selection.id) : undefined;
  const chosenIncident =
    selection?.kind === 'incident' ? data.incidents.find((i) => i.id === selection.id) : undefined;
  const chosenMission =
    selection?.kind === 'mission' ? data.missions.find((m) => m.id === selection.id) : undefined;
  const writable = user.role !== 'viewer';
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('overview');
          }}
        >
          <Logo />
          fleetdeck
          <span className="wordmark-dot" />
        </a>
        <button className="workspace">
          <span className="workspace-icon">
            <Box size={18} />
          </span>
          <span>
            <strong>Northstar</strong>
            <small>Distribution campus</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {(
            [
              { key: 'overview', label: 'Overview', icon: LayoutDashboard },
              { key: 'fleet', label: 'Fleet', icon: Truck },
              { key: 'incidents', label: 'Incidents', icon: Bell },
              { key: 'missions', label: 'Missions', icon: Navigation },
              { key: 'activity', label: 'Activity log', icon: Activity },
            ] as const
          ).map((n) => (
            <button
              key={n.key}
              aria-label={n.label}
              title={n.label}
              className={page === n.key ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setPage(n.key);
                setSearch('');
                setFilter('all');
                setSelection(null);
              }}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.key === 'incidents' && open.length > 0 && <b>{open.length}</b>}
              {n.key === 'fleet' && <small>{data.vehicles.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="environment">
            <span className="pulse" />
            <div>
              <strong>{demo ? 'Simulation environment' : 'Operations environment'}</strong>
              <small>{demo ? 'Synthetic fleet · live pipeline' : 'Single-site workspace'}</small>
            </div>
          </div>
          <button
            className="help"
            onClick={() =>
              setNotice(
                'Runbook: inspect freshness, acknowledge the incident, investigate the vehicle, then reconcile or cancel its mission.',
              )
            }
          >
            <CircleHelp size={17} />
            Operator guide
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <div className="avatar">
              {user.name
                .split(' ')
                .map((n) => n[0])
                .join('')}
            </div>
            <span>
              <strong>{user.name}</strong>
              <small>{user.role === 'viewer' ? 'Read-only observer' : 'Fleet operator'}</small>
            </span>
            <button
              aria-label="Sign out"
              onClick={() => {
                void fetch('/v1/auth/logout', {
                  method: 'POST',
                  headers: { 'X-CSRF-Token': csrf },
                }).then(() => {
                  setUser(null);
                  setData(null);
                });
              }}
            >
              <ExternalLink size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            <span className="breadcrumb">Workspace</span>
            <ChevronRight size={13} />
            <strong>{readable(page).replace(/^./, (c) => c.toUpperCase())}</strong>
          </span>
          <div className="topbar-right">
            <span className={connected ? 'live-label' : 'live-label reconnecting'}>
              <span className="pulse" />
              {connected ? 'Live updates' : 'Reconnecting'}
            </span>
            <span className="topbar-divider" />
            <span className="date">
              {new Date(now).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <button
              className="icon-button"
              aria-label="Refresh state"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">NORTHSTAR / OPERATIONS</div>
              <h1>
                {
                  {
                    overview: 'Fleet overview',
                    fleet: 'Your fleet',
                    incidents: 'Incident workspace',
                    missions: 'Mission control',
                    activity: 'Activity log',
                  }[page]
                }
              </h1>
              <p>
                {
                  {
                    overview: 'The whole floor, in focus. Here’s what’s happening right now.',
                    fleet: 'Every vehicle, its current state, and the context behind it.',
                    incidents: 'Focus on the exceptions. Keep every decision accountable.',
                    missions: 'Assign with confidence. Keep uncertain outcomes visible.',
                    activity: 'A durable record of operator actions and system transitions.',
                  }[page]
                }
              </p>
            </div>
            <div className="heading-actions">
              <span className="site-status">
                <span className="pulse" />
                {online === data.vehicles.length
                  ? 'All systems connected'
                  : `${online} of ${data.vehicles.length} connected`}
              </span>
              <button className="primary" onClick={() => openDispatch()} disabled={!writable}>
                <Plus size={16} />
                Create mission
              </button>
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {now - lastUpdated.current > 10000 && (
            <div className="error" role="status">
              This view has not synchronized recently. Confirm freshness before acting.
            </div>
          )}
          {(page === 'overview' || page === 'fleet') && (
            <div className="kpis">
              <Kpi
                label="Total vehicles"
                value={data.vehicles.length}
                icon={<Truck size={18} />}
                detail={`${online} connected to the gateway`}
                hint="Registered fleet"
              />
              <Kpi
                label="In operation"
                value={moving}
                icon={<Navigation size={18} />}
                detail={moving ? 'Vehicles moving or working' : 'Ready for the next assignment'}
                hint="Live status"
              />
              <Kpi
                label="Needs attention"
                value={open.length}
                icon={<Bell size={18} />}
                detail={
                  open.length
                    ? `${open.filter((i) => i.severity === 'critical').length} critical · ${open.filter((i) => i.severity === 'warning').length} warning`
                    : 'No open incidents'
                }
                hint="Open incidents"
                warning={open.length > 0}
              />
              <Kpi
                label="Active missions"
                value={active.length}
                icon={<Crosshair size={18} />}
                detail={
                  active.some((m) => m.state === 'uncertain')
                    ? 'Uncertain outcomes hold reservations'
                    : 'Assigned, running, or awaiting confirmation'
                }
                hint="Reserved vehicles"
              />
            </div>
          )}
          {page === 'overview' && (
            <>
              <div className="overview-grid">
                <section className="panel map-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Live site map <span className="tag">SITE 01</span>
                      </h2>
                      <p>Vehicle positions across the operating floor</p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Open fleet view"
                      onClick={() => setPage('fleet')}
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </div>
                  <SiteMap
                    vehicles={data.vehicles}
                    nodes={data.nodes}
                    incidents={open}
                    selectedId={chosenVehicle?.id}
                    onSelect={(id) => setSelection({ kind: 'vehicle', id })}
                  />
                  <div className="map-footer">
                    <div>
                      <Legend color="green" label="Ready" />
                      <Legend color="blue" label="In operation" />
                      <Legend color="amber" label="Attention" />
                      <Legend color="gray" label="Offline" />
                    </div>
                    <span>
                      <Radio size={12} />
                      Positions refresh live
                    </span>
                  </div>
                </section>
                <section className="panel attention">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Needs attention <span className="count">{open.length}</span>
                      </h2>
                      <p>Exceptions that need a human</p>
                    </div>
                    <span className="attention-dot" />
                  </div>
                  <div className="attention-list">
                    {open.length === 0 ? (
                      <div className="all-clear">
                        <span>
                          <Check size={27} />
                        </span>
                        <h3>A clear operating floor</h3>
                        <p>
                          No open incidents. We’re watching for lost contact, low battery, and
                          stalled movement.
                        </p>
                        <small>Continuous monitoring is active</small>
                      </div>
                    ) : (
                      open
                        .slice(0, 5)
                        .sort((a, b) =>
                          a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1,
                        )
                        .map((i) => (
                          <button
                            className="attention-item"
                            key={i.id}
                            onClick={() => setSelection({ kind: 'incident', id: i.id })}
                          >
                            <span className={`incident-symbol ${i.severity}`}>
                              {i.type === 'offline' ? (
                                <WifiOff size={17} />
                              ) : i.type === 'battery_low' ? (
                                <Battery size={17} />
                              ) : (
                                <Bell size={17} />
                              )}
                            </span>
                            <span>
                              <strong>{i.title}</strong>
                              <small>
                                {i.vehicle_name} · {age(i.opened_at, now)}
                              </small>
                              <span className={`pill ${i.severity}`}>
                                {i.condition_active ? readable(i.state) : 'Recovered · review'}
                              </span>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))
                    )}
                  </div>
                  <button className="panel-link" onClick={() => setPage('incidents')}>
                    View all incidents
                    <ArrowRight size={14} />
                  </button>
                </section>
              </div>
              <div className="section-heading">
                <div>
                  <h2>
                    Fleet at a glance <span>{data.vehicles.length} vehicles</span>
                  </h2>
                </div>
                <button className="text-button" onClick={() => setPage('fleet')}>
                  View fleet
                  <ArrowRight size={14} />
                </button>
              </div>
              <FleetTable
                vehicles={data.vehicles.slice(0, 6)}
                missions={active}
                onSelect={(id) => setSelection({ kind: 'vehicle', id })}
                now={now}
              />
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Recent activity</h2>
                      <p>Every change has a trail</p>
                    </div>
                    <button className="text-button" onClick={() => setPage('activity')}>
                      View log
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <ActivityList rows={data.audit.slice(0, 3)} />
                </section>
                <section className="pipeline-card">
                  <div className="pipeline-icon">
                    <ShieldCheck size={24} />
                  </div>
                  <div>
                    <span className="eyebrow">TRUST THE STATE</span>
                    <h3>Accepted. Recorded. Accountable.</h3>
                    <p>
                      {data.health.admitted.toLocaleString()} observations durably admitted.
                      <br />
                      {data.health.pending} waiting to apply. Every command outcome stays explicit.
                    </p>
                    <span>
                      <span className="pulse" />
                      PostgreSQL is the source of truth
                    </span>
                  </div>
                </section>
              </div>
            </>
          )}
          {page === 'fleet' && (
            <section className="panel">
              <Toolbar search={search} onSearch={setSearch} placeholder="Search vehicles…" />
              <FleetTable
                vehicles={vehicles}
                missions={active}
                onSelect={(id) => setSelection({ kind: 'vehicle', id })}
                now={now}
              />
            </section>
          )}
          {page === 'incidents' && (
            <section className="panel">
              <div className="tabs-toolbar">
                <div className="tabs">
                  {['all', 'open', 'acknowledged', 'resolved'].map((f) => (
                    <button
                      className={filter === f ? 'selected' : ''}
                      key={f}
                      onClick={() => setFilter(f)}
                    >
                      {readable(f)}
                    </button>
                  ))}
                </div>
                <Toolbar search={search} onSearch={setSearch} placeholder="Search incidents…" />
              </div>
              {incidents.length === 0 ? (
                <Empty
                  title="Nothing needs attention here"
                  text="Incidents appear when a monitored condition fires. Try a scenario from a vehicle’s detail panel."
                />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Incident</th>
                        <th>Vehicle</th>
                        <th>Priority</th>
                        <th>Status</th>
                        <th>Owner</th>
                        <th>Detected</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {incidents.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <button
                              className="row-link"
                              onClick={() => setSelection({ kind: 'incident', id: i.id })}
                            >
                              {i.title}
                            </button>
                            <small className="cell-sub">
                              {i.condition_active ? 'Condition active' : 'Condition recovered'}
                            </small>
                          </td>
                          <td>{i.vehicle_name}</td>
                          <td>
                            <span className={`pill ${i.severity}`}>{i.severity}</span>
                          </td>
                          <td>
                            <span className={`pill ${i.state}`}>{readable(i.state)}</span>
                          </td>
                          <td>{i.assignee ?? 'Unassigned'}</td>
                          <td>{age(i.opened_at, now)}</td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`Open incident for ${i.vehicle_name}`}
                              onClick={() => setSelection({ kind: 'incident', id: i.id })}
                            >
                              <ChevronRight size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {page === 'missions' && (
            <>
              <div className="mission-summary">
                <span>
                  <span className="pulse" />
                  {active.length} active reservations
                </span>
                <p>
                  A command timeout holds the reservation until the vehicle confirms its outcome.
                </p>
              </div>
              <div className="eta-banner">
                <Activity size={17} />
                <p>
                  <strong>
                    {data.eta.enabled && data.eta.available && data.eta.promoted
                      ? 'Learned ETA estimates'
                      : 'Baseline ETA estimates'}
                  </strong>{' '}
                  · Predictions are made at dispatch using synthetic training data. Unexpected stops
                  can exceed the range.
                </p>
              </div>
              <div className="mission-board">
                {[
                  ['Assigned', ['assigned']],
                  ['In progress', ['in_progress']],
                  ['Needs reconciliation', ['uncertain', 'canceling']],
                  ['Finished', ['completed', 'canceled', 'failed']],
                ].map(([label, states]) => {
                  const missions = data.missions.filter((m) =>
                    (states as string[]).includes(m.state),
                  );
                  return (
                    <section className="mission-column" key={label as string}>
                      <h2>
                        {label as string}
                        <span>{missions.length}</span>
                      </h2>
                      {missions.map((m) => (
                        <button
                          className={`mission-card ${m.state === 'uncertain' ? 'uncertain' : ''}`}
                          key={m.id}
                          onClick={() => setSelection({ kind: 'mission', id: m.id })}
                        >
                          <div>
                            <span className="mission-id">MSN-{m.id.slice(0, 6).toUpperCase()}</span>
                            <ArrowUpRight size={14} />
                          </div>
                          <h3>
                            {data.nodes.find((n) => n.id === m.destination)?.label ?? m.destination}
                          </h3>
                          <p>
                            <Truck size={14} />
                            {m.vehicle_name}
                            <ArrowRight size={12} />
                            <MapPin size={13} />
                            {readable(m.destination)}
                          </p>
                          <footer>
                            <span className={`pill ${m.state}`}>{readable(m.state)}</span>
                            <small>{shortTime(m.created_at)}</small>
                          </footer>
                          {m.eta && (
                            <EtaView
                              prediction={m.eta}
                              compact
                              active={activeMission(m)}
                              suspended={['uncertain', 'canceling'].includes(m.state)}
                            />
                          )}
                        </button>
                      ))}
                      {missions.length === 0 && <div className="board-empty">No missions</div>}
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {page === 'activity' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Audit trail</h2>
                  <p>Operator actions and system transitions, committed with their state changes</p>
                </div>
                <span className="tag">LAST 40 EVENTS</span>
              </div>
              <ActivityList rows={data.audit} />
            </section>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} />
              Monitoring and dispatch · Not a safety system
            </span>
            <span>
              {data.site.name} <span className="footer-dot">·</span> Synced{' '}
              {age(new Date(lastUpdated.current).toISOString(), now)}
            </span>
          </footer>
        </main>
      </div>
      {selection && (
        <div className="drawer-shade" onClick={() => setSelection(null)}>
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={chosenVehicle?.name ?? chosenIncident?.title ?? 'Mission details'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <span className="eyebrow">{selection.kind.toUpperCase()} WORKSPACE</span>
              <button
                className="icon-button"
                aria-label="Close details"
                onClick={() => setSelection(null)}
              >
                <X size={20} />
              </button>
            </div>
            {chosenVehicle && (
              <>
                <div className="drawer-title">
                  <div className="vehicle-icon large">
                    <Truck size={26} />
                  </div>
                  <div>
                    <h2>{chosenVehicle.name}</h2>
                    <p>{chosenVehicle.model} · Northstar campus</p>
                  </div>
                </div>
                <span className={`pill ${badge(chosenVehicle).replace(' ', '-')}`}>
                  {readable(badge(chosenVehicle))}
                </span>
                <div className="detail-grid">
                  <Detail label="Battery" value={`${chosenVehicle.battery.toFixed(1)}%`} />
                  <Detail label="Speed" value={`${chosenVehicle.speed.toFixed(1)} units/s`} />
                  <Detail label="Last contact" value={age(chosenVehicle.contact_at, now)} />
                  <Detail label="Last observation" value={age(chosenVehicle.observed_at, now)} />
                  <Detail
                    label="First received"
                    value={age(chosenVehicle.snapshot_received_at, now)}
                  />
                  <Detail label="Applied" value={age(chosenVehicle.processed_at, now)} />
                  <Detail label="Applied revision" value={chosenVehicle.revision} />
                  <Detail
                    label="Position"
                    value={`${Math.round(chosenVehicle.x)}, ${Math.round(chosenVehicle.y)} m`}
                  />
                </div>
                <div className="info-box">
                  <ShieldCheck size={17} />
                  <p>
                    Contact confirms the link. Observation time describes the reading. A connected
                    vehicle can still have stale telemetry.
                  </p>
                </div>
                <h3 className="drawer-section-title">Mission reservation</h3>
                {active
                  .filter((m) => m.vehicle_id === chosenVehicle.id)
                  .map((m) => (
                    <button
                      className="linked-card"
                      key={m.id}
                      onClick={() => setSelection({ kind: 'mission', id: m.id })}
                    >
                      <Navigation size={18} />
                      <span>
                        <strong>{readable(m.destination)}</strong>
                        <small>{readable(m.state)}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                {!active.some((m) => m.vehicle_id === chosenVehicle.id) && (
                  <button
                    className="primary wide"
                    onClick={() => openDispatch(chosenVehicle)}
                    disabled={!writable}
                  >
                    <Plus size={15} />
                    Create a mission
                  </button>
                )}
                <h3 className="drawer-section-title">Incidents</h3>
                {open
                  .filter((i) => i.vehicle_id === chosenVehicle.id)
                  .map((i) => (
                    <button
                      className="linked-card"
                      key={i.id}
                      onClick={() => setSelection({ kind: 'incident', id: i.id })}
                    >
                      <Bell size={17} />
                      <span>
                        <strong>{i.title}</strong>
                        <small>{readable(i.state)}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                {!open.some((i) => i.vehicle_id === chosenVehicle.id) && (
                  <p className="muted">No open incidents for this vehicle.</p>
                )}
                {demo && user.role === 'admin' && (
                  <>
                    <h3 className="drawer-section-title">
                      Scenario lab <span className="tag">SIMULATED</span>
                    </h3>
                    <p className="muted">
                      Inject a failure into this vehicle. Scenarios expire after two minutes.
                    </p>
                    <div className="scenario-grid">
                      {[
                        { kind: 'offline', label: 'Lose contact', icon: WifiOff },
                        { kind: 'battery_low', label: 'Drain battery', icon: Battery },
                        { kind: 'stuck', label: 'Block movement', icon: Pause },
                        { kind: 'lost_ack', label: 'Lose command reports', icon: Radio },
                        { kind: 'normal', label: 'Restore normal', icon: Play },
                      ].map((s) => (
                        <button
                          disabled={mutating}
                          key={s.kind}
                          onClick={() =>
                            void write(
                              '/v1/sim/scenario',
                              { vehicleId: chosenVehicle.id, kind: s.kind },
                              s.kind === 'normal'
                                ? 'Normal operation restored.'
                                : 'Scenario active. Watch the incident and mission timelines.',
                            )
                          }
                        >
                          <s.icon size={16} />
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <p className="tiny muted">
                      Stalled movement requires an active mission. To demonstrate uncertainty, lose
                      reports before dispatching.
                    </p>
                  </>
                )}
              </>
            )}
            {chosenIncident && (
              <>
                <span className={`pill ${chosenIncident.severity}`}>{chosenIncident.severity}</span>
                <h2 className="drawer-main-title">{chosenIncident.title}</h2>
                <button
                  className="text-button"
                  onClick={() => setSelection({ kind: 'vehicle', id: chosenIncident.vehicle_id })}
                >
                  <Truck size={15} />
                  {chosenIncident.vehicle_name}
                  <ArrowUpRight size={14} />
                </button>
                <div className="detail-grid">
                  <Detail label="State" value={readable(chosenIncident.state)} />
                  <Detail
                    label="Condition"
                    value={chosenIncident.condition_active ? 'Active' : 'Recovered'}
                  />
                  <Detail label="Assignee" value={chosenIncident.assignee ?? 'Unassigned'} />
                  <Detail label="Detected" value={age(chosenIncident.opened_at, now)} />
                </div>
                <div className="action-row">
                  <button
                    className="primary"
                    disabled={mutating || !writable || chosenIncident.state !== 'open'}
                    onClick={() =>
                      void write(
                        `/v1/incidents/${chosenIncident.id}/actions`,
                        { action: 'acknowledge', version: chosenIncident.version },
                        'Incident acknowledged.',
                      )
                    }
                  >
                    <Check size={15} />
                    Acknowledge
                  </button>
                  <button
                    className="secondary"
                    disabled={mutating || !writable || chosenIncident.state === 'resolved'}
                    onClick={() =>
                      void write(
                        `/v1/incidents/${chosenIncident.id}/actions`,
                        { action: 'assign', version: chosenIncident.version },
                        'Incident assigned to you.',
                      )
                    }
                  >
                    Assign to me
                  </button>
                </div>
                <button
                  className="secondary wide"
                  disabled={
                    mutating ||
                    !writable ||
                    chosenIncident.condition_active ||
                    chosenIncident.state === 'resolved'
                  }
                  onClick={() => setResolving(true)}
                >
                  Resolve with a note
                </button>
                {resolving && (
                  <form
                    className="resolution-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void write(
                        `/v1/incidents/${chosenIncident.id}/actions`,
                        {
                          action: 'resolve',
                          version: chosenIncident.version,
                          note: resolutionNote,
                        },
                        'Incident resolved.',
                      ).then((ok) => {
                        if (ok) setResolving(false);
                      });
                    }}
                  >
                    <label>
                      Resolution note
                      <textarea
                        autoFocus
                        required
                        minLength={1}
                        maxLength={1000}
                        value={resolutionNote}
                        onChange={(e) => setResolutionNote(e.target.value)}
                        placeholder="What did you verify?"
                      />
                    </label>
                    <div className="action-row">
                      <button className="primary" disabled={mutating || !resolutionNote.trim()}>
                        Confirm resolution
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setResolving(false)}
                      >
                        Keep investigating
                      </button>
                    </div>
                  </form>
                )}
                {chosenIncident.condition_active && (
                  <p className="tiny muted">
                    An active condition stays visible. Recovery enables resolution.
                  </p>
                )}
                <div className="runbook">
                  <div>
                    <ShieldCheck size={17} />
                    <strong>Investigation brief</strong>
                    <span className="tag">RUNBOOK</span>
                  </div>
                  <p>{chosenIncident.note.summary}</p>
                  <h4>Recorded evidence</h4>
                  <ul>
                    {chosenIncident.note.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <h4>Suggested investigation</h4>
                  <ol>
                    {chosenIncident.note.actions.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ol>
                  <small>Deterministic guidance · An operator decides what happens next.</small>
                </div>
                <Timeline events={timeline} />
              </>
            )}
            {chosenMission && (
              <>
                <span className={`pill ${chosenMission.state}`}>
                  {readable(chosenMission.state)}
                </span>
                <h2 className="drawer-main-title">Move to {readable(chosenMission.destination)}</h2>
                <button
                  className="text-button"
                  onClick={() => setSelection({ kind: 'vehicle', id: chosenMission.vehicle_id })}
                >
                  <Truck size={15} />
                  {chosenMission.vehicle_name}
                  <ArrowUpRight size={14} />
                </button>
                <div className="detail-grid">
                  <Detail label="Mission" value={`MSN-${chosenMission.id.slice(0, 6)}`} />
                  <Detail label="Version" value={String(chosenMission.version)} />
                  <Detail label="Created" value={shortTime(chosenMission.created_at)} />
                  <Detail label="Attempt" value={chosenMission.current_attempt_id.slice(0, 8)} />
                </div>
                {chosenMission.eta && (
                  <EtaView
                    prediction={chosenMission.eta}
                    active={activeMission(chosenMission)}
                    suspended={['uncertain', 'canceling'].includes(chosenMission.state)}
                  />
                )}
                {chosenMission.eta_observed_seconds !== null && (
                  <p className="eta-observed">
                    Observed completion report: {Math.round(chosenMission.eta_observed_seconds)}s
                    after dispatch
                    {chosenMission.eta_reconciled
                      ? ' · Reconciled outcome; excluded from normal ETA error metrics.'
                      : ''}
                  </p>
                )}
                {['uncertain', 'canceling'].includes(chosenMission.state) && (
                  <div className="info-box warning-box">
                    <Radio size={18} />
                    <p>
                      The reservation is held. This vehicle may still be executing. Restore contact
                      and await terminal evidence before assigning new work.
                    </p>
                  </div>
                )}
                {activeMission(chosenMission) && (
                  <>
                    {confirmCancel ? (
                      <div className="confirm-box">
                        <h3>Request cancellation?</h3>
                        <p>
                          This sends a cancellation request. The vehicle remains reserved until it
                          confirms a terminal outcome.
                        </p>
                        <button
                          className="danger"
                          disabled={mutating}
                          onClick={() =>
                            void write(
                              `/v1/missions/${chosenMission.id}/cancel`,
                              { version: chosenMission.version },
                              'Cancellation requested. Reservation remains held.',
                            ).then((ok) => {
                              if (ok) setConfirmCancel(false);
                            })
                          }
                        >
                          Confirm cancellation request
                        </button>
                        <button className="text-button" onClick={() => setConfirmCancel(false)}>
                          Keep mission
                        </button>
                      </div>
                    ) : (
                      <button
                        className="secondary wide"
                        disabled={!writable || mutating}
                        onClick={() => setConfirmCancel(true)}
                      >
                        Request cancellation
                      </button>
                    )}
                  </>
                )}
                <Timeline events={timeline} />
              </>
            )}
          </section>
        </div>
      )}
      {dispatchOpen && (
        <div className="modal-shade">
          <DispatchDialog
            data={data}
            vehicleId={dispatchVehicle}
            setVehicleId={setDispatchVehicle}
            destination={destination}
            setDestination={setDestination}
            busy={mutating}
            onClose={() => setDispatchOpen(false)}
            onSubmit={async (key) => {
              if (
                await write(
                  '/v1/missions',
                  { vehicleId: dispatchVehicle, destination },
                  'Mission dispatched. Awaiting the vehicle’s response.',
                  key,
                )
              ) {
                setDispatchOpen(false);
                setSelection(null);
                setPage('missions');
              }
            }}
          />
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
          </span>
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function Logo() {
  return (
    <svg viewBox="0 0 30 30" width="28" height="28" aria-hidden="true">
      <path d="M3 6h24v6H10v5h13v6H10v5H3z" fill="currentColor" />
      <path d="M19 17h8v6h-8z" fill="currentColor" opacity=".45" />
    </svg>
  );
}
function Kpi({
  label,
  value,
  icon,
  detail,
  hint,
  warning = false,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  detail: string;
  hint: string;
  warning?: boolean;
}) {
  return (
    <section className={`kpi ${warning ? 'kpi-warning' : ''}`}>
      <div>
        <span>{label}</span>
        <span className="kpi-icon">{icon}</span>
      </div>
      <div className="kpi-value">
        {value}
        <small>{hint}</small>
      </div>
      <p>
        <span className={warning ? 'mini-dot amber' : 'mini-dot'} />
        {detail}
      </p>
    </section>
  );
}
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend">
      <i className={color} />
      {label}
    </span>
  );
}
function Toolbar({
  search,
  onSearch,
  placeholder,
}: {
  search: string;
  onSearch: (s: string) => void;
  placeholder: string;
}) {
  return (
    <div className="toolbar">
      <label className="search">
        <Search size={15} />
        <input
          aria-label={placeholder}
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
      <span className="toolbar-hint">
        <ListFilter size={15} />
        Live state
      </span>
    </div>
  );
}
function FleetTable({
  vehicles,
  missions,
  onSelect,
  now,
}: {
  vehicles: Vehicle[];
  missions: Mission[];
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <div className="table-wrap fleet-table">
      <table>
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Status</th>
            <th>Battery</th>
            <th>Mission</th>
            <th>Last observation</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vehicles.map((v) => {
            const m = missions.find((m) => m.vehicle_id === v.id);
            const status = badge(v);
            return (
              <tr key={v.id}>
                <td>
                  <button className="vehicle-name" onClick={() => onSelect(v.id)}>
                    <span className="vehicle-icon">
                      <Truck size={17} />
                    </span>
                    <span>
                      <strong>{v.name}</strong>
                      <small>{v.model}</small>
                    </span>
                  </button>
                </td>
                <td>
                  <span className={`pill ${status.replace(' ', '-')}`}>
                    <i />
                    {readable(status)}
                  </span>
                </td>
                <td>
                  <span className={`battery ${v.battery < 20 ? 'low' : ''}`}>
                    <span className="battery-outline">
                      <i style={{ width: `${v.battery}%` }} />
                    </span>
                    {Math.round(v.battery)}%
                  </span>
                </td>
                <td>
                  {m ? (
                    <span className="mission-destination">
                      <ArrowUpRight size={13} />
                      {readable(m.destination)}
                    </span>
                  ) : (
                    <span className="muted">Available for assignment</span>
                  )}
                </td>
                <td>
                  <span
                    className={
                      v.observed_at && Math.abs(now - Date.parse(v.observed_at)) > 10000
                        ? 'stale'
                        : ''
                    }
                  >
                    {age(v.observed_at, now)}
                  </span>
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`Inspect ${v.name}`}
                    onClick={() => onSelect(v.id)}
                  >
                    <ChevronRight size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {vehicles.length === 0 && (
        <Empty title="No matching vehicles" text="Try another vehicle name." />
      )}
    </div>
  );
}
function SiteMap({
  vehicles,
  nodes,
  incidents,
  selectedId,
  onSelect,
}: {
  vehicles: Vehicle[];
  nodes: FleetState['nodes'];
  incidents: Incident[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="site-map">
      <div className="map-coordinate">
        <Crosshair size={12} />
        LOCAL FRAME / MAP UNITS
      </div>
      <svg
        viewBox="0 0 1000 580"
        role="group"
        aria-label="Site map showing six operating zones and current vehicle positions"
      >
        <defs>
          <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".7" fill="#c6cec9" />
          </pattern>
          <pattern
            id="restricted"
            width="9"
            height="9"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" x2="0" y1="0" y2="9" stroke="#d9cdb1" strokeWidth="2" />
          </pattern>
        </defs>
        <rect width="1000" height="580" fill="url(#dots)" />
        {nodes.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x - 90}
              y={n.y - 76}
              width="180"
              height="152"
              rx="7"
              fill={n.kind === 'charger' ? '#e2ece3' : '#e7e9e4'}
              stroke={n.kind === 'charger' ? '#c2d5c5' : '#d0d5ce'}
              strokeDasharray="5 4"
            />
            <rect
              x={n.x - 67}
              y={n.y - 50}
              width="134"
              height="100"
              rx="3"
              fill="#f4f4ef"
              stroke="#d6dad3"
            />
            {[0, 1, 2, 3].map((i) => (
              <rect
                key={i}
                x={n.x - 54 + i * 30}
                y={n.y - 37}
                width="18"
                height="74"
                rx="2"
                fill={n.kind === 'charger' ? '#d0dfd1' : '#dde1d9'}
              />
            ))}
            <text
              x={n.x}
              y={n.y + 96}
              textAnchor="middle"
              fill="#7c857d"
              fontSize="13"
              fontWeight="500"
            >
              {n.label.toUpperCase()}
            </text>
          </g>
        ))}
        <path d="M50 285H950M310 65V510M670 65V510" fill="none" stroke="#d8ded6" strokeWidth="44" />
        <path d="M50 285H950M310 65V510M670 65V510" fill="none" stroke="#eff1eb" strokeWidth="40" />
        <path
          d="M50 285H950M310 65V510M670 65V510"
          fill="none"
          stroke="#cbd1c8"
          strokeWidth="1"
          strokeDasharray="8 12"
        />
        <rect
          x="737"
          y="265"
          width="122"
          height="40"
          rx="3"
          fill="url(#restricted)"
          opacity=".65"
        />
        <text x="798" y="290" textAnchor="middle" fill="#a18a62" fontSize="10">
          CROSSING
        </text>
        {vehicles.map((v) => {
          const attention = incidents.some((i) => i.vehicle_id === v.id);
          const color = !v.online
            ? '#8e9692'
            : attention
              ? '#bd873d'
              : v.status === 'moving' || v.status === 'working'
                ? '#567aa2'
                : '#507f64';
          return (
            <g
              key={v.id}
              className="map-vehicle"
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${v.name}, ${badge(v)}`}
              onClick={() => onSelect(v.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(v.id);
                }
              }}
              transform={`translate(${v.x},${v.y})`}
            >
              <title>
                {v.name} · {badge(v)}
              </title>
              {(attention || selectedId === v.id) && <circle r="23" fill={color} opacity=".13" />}
              <circle r="15" fill="white" stroke={color} strokeWidth="2" />
              <rect x="-8" y="-6" width="16" height="12" rx="3" fill={color} />
              <path d="M-4 -3h8v3h-8z" fill="white" opacity=".85" />
              <circle cx="-5" cy="7" r="2" fill={color} />
              <circle cx="5" cy="7" r="2" fill={color} />
              {!v.online && <path d="M-10 -10L10 10" stroke={color} strokeWidth="2" />}
              <text y="31" textAnchor="middle" fontSize="11" fill="#52605a">
                {v.name.replace('AMR-', '')}
              </text>
            </g>
          );
        })}
        <g transform="translate(946 487)">
          <circle r="21" fill="#fafbf7" stroke="#d5dad3" />
          <path d="M0 -12L5 7 0 4 -5 7z" fill="#667a6c" />
          <text y="38" textAnchor="middle" fontSize="10" fill="#8b958d">
            N
          </text>
        </g>
      </svg>
      <span className="map-scale">
        0 <i /> 50 m
      </span>
    </div>
  );
}
function ActivityList({ rows }: { rows: FleetState['audit'] }) {
  if (!rows.length)
    return (
      <Empty
        title="A clean slate"
        text="Operator actions and mission transitions will appear here."
      />
    );
  return (
    <div className="activity-list">
      {rows.map((a) => (
        <div key={a.id}>
          <span className="activity-icon">
            {a.action.includes('mission') ? (
              <Navigation size={14} />
            ) : a.action.includes('incident') ? (
              <Bell size={14} />
            ) : (
              <SlidersHorizontal size={14} />
            )}
          </span>
          <span>
            <strong>{readable(a.action).replace(/^./, (c) => c.toUpperCase())}</strong>
            <small>
              {a.actor} · {a.subject_id.slice(0, 8)}
            </small>
          </span>
          <time>{shortTime(a.at)}</time>
        </div>
      ))}
    </div>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <Box size={24} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <>
      <h3 className="drawer-section-title">Timeline</h3>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id}>
            <span />
            <div>
              <strong>{readable(e.kind)}</strong>
              <small>
                {e.actor} · {shortTime(e.at)}
              </small>
              {typeof e.data.note === 'string' && <p>{e.data.note}</p>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
function DispatchDialog({
  data,
  vehicleId,
  setVehicleId,
  destination,
  setDestination,
  busy,
  onClose,
  onSubmit,
}: {
  data: FleetState;
  vehicleId: string;
  setVehicleId: (s: string) => void;
  destination: string;
  setDestination: (s: string) => void;
  busy: boolean;
  onClose: () => void;
  onSubmit: (key: string) => Promise<void>;
}) {
  const key = useRef(crypto.randomUUID()),
    lastBody = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<{ key: string; prediction: EtaPrediction } | null>(null);
  const previewKey = `${vehicleId}/${destination}`;
  useEffect(() => {
    if (!vehicleId) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/v1/eta?${new URLSearchParams({ vehicleId, destination })}`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('ETA unavailable.');
        const prediction = (await response.json()) as EtaPrediction;
        if (!disposed) setPreview({ key: previewKey, prediction });
      } catch {
        if (!disposed) setPreview(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [vehicleId, destination, previewKey]);
  useEffect(() => {
    dialog.current?.showModal();
    const el = dialog.current;
    return () => el?.close();
  }, []);
  const now = Date.now();
  const eligible = (v: Vehicle) =>
    v.online &&
    v.status === 'idle' &&
    v.battery >= 25 &&
    !!v.observed_at &&
    now - Date.parse(v.observed_at) <= 10000 &&
    now - Date.parse(v.observed_at) >= -5000 &&
    !!v.snapshot_received_at &&
    now - Date.parse(v.snapshot_received_at) <= 10000 &&
    now - Date.parse(v.snapshot_received_at) >= -1000 &&
    !!v.contact_at &&
    now - Date.parse(v.contact_at) <= 15000 &&
    !data.missions.some((m) => m.vehicle_id === v.id && activeMission(m)) &&
    !data.incidents.some(
      (i) => i.vehicle_id === v.id && i.severity === 'critical' && i.state !== 'resolved',
    );
  return (
    <dialog
      ref={dialog}
      className="dispatch-modal"
      aria-labelledby="dispatch-title"
      onCancel={onClose}
    >
      <div className="modal-heading">
        <span className="eyebrow">MANUAL DISPATCH</span>
        <button className="icon-button" aria-label="Close mission dialog" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <span className="modal-icon">
        <Navigation size={24} />
      </span>
      <h2 id="dispatch-title">Create a mission</h2>
      <p>
        Choose a vehicle and a destination. Its reservation stays held until the vehicle confirms
        the outcome.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = JSON.stringify({ vehicleId, destination });
          if (lastBody.current && lastBody.current !== body) key.current = crypto.randomUUID();
          lastBody.current = body;
          void onSubmit(key.current);
        }}
      >
        <label>
          Vehicle
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
            <option value="">Choose an available vehicle</option>
            {data.vehicles.map((v) => (
              <option key={v.id} value={v.id} disabled={!eligible(v)}>
                {v.name} · {Math.round(v.battery)}%{!eligible(v) ? ' · unavailable' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination
          <select value={destination} onChange={(e) => setDestination(e.target.value)}>
            {data.nodes.map((n) => (
              <option value={n.id} key={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <div aria-live="polite">
          {preview?.key === previewKey ? (
            <EtaView prediction={preview.prediction} />
          ) : vehicleId ? (
            <p className="eta-loading">
              ETA preview unavailable or loading. Dispatch remains available.
            </p>
          ) : null}
        </div>
        <div className="info-box">
          <ShieldCheck size={17} />
          <p>
            Eligibility is checked again when you dispatch. Duplicate submissions use the same
            request identity.
          </p>
        </div>
        <button
          className="primary wide"
          disabled={
            busy || !vehicleId || !data.vehicles.some((v) => v.id === vehicleId && eligible(v))
          }
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <>
              <Navigation size={16} />
              Dispatch mission
            </>
          )}
        </button>
      </form>
    </dialog>
  );
}
function EtaView({
  prediction,
  compact = false,
  suspended = false,
  active = false,
}: {
  prediction: EtaPrediction;
  compact?: boolean;
  suspended?: boolean;
  active?: boolean;
}) {
  if (suspended)
    return <div className="eta-estimate eta-muted">ETA suspended · awaiting reconciliation</div>;
  if (prediction.seconds === null)
    return (
      <div className="eta-estimate eta-muted">ETA unavailable · {readable(prediction.reason)}</div>
    );
  return (
    <div className={`eta-estimate ${compact ? 'eta-compact' : ''}`}>
      <span className="eta-label">
        {prediction.source === 'model' ? 'ML' : 'Baseline'} · Dispatch estimate
      </span>
      <strong>
        {Math.round(prediction.seconds)}s
        {prediction.lowerSeconds !== null && prediction.upperSeconds !== null && (
          <span className="eta-range">
            {' '}
            · {Math.floor(prediction.lowerSeconds)}–{Math.ceil(prediction.upperSeconds)}s range
          </span>
        )}
      </strong>
      {active &&
        prediction.upperSeconds !== null &&
        Date.now() - Date.parse(prediction.predictedAt) > prediction.upperSeconds * 1000 && (
          <small>Dispatch range elapsed · awaiting completion evidence</small>
        )}
      {!compact && (
        <small>
          {prediction.source === 'model'
            ? `${prediction.modelVersion} · 90% target coverage per synthetic run; no guarantee under unexpected conditions.`
            : `Distance ÷ nominal speed · ${readable(prediction.reason)} · no calibrated range.`}{' '}
          Advisory only; includes expected gateway reporting delay for model estimates.
        </small>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
