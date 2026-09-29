# HTTP and live API

All mutation bodies are strict JSON; unknown fields are rejected. Validation failures return 422; invalid authentication 401; authorization/CSRF/origin failures 403; stale versions and resource conflicts 409. Errors carry a stable `code`, human `detail`, and request ID. Overload returns 503 with `Retry-After`.

| Method  | Path                                          | Principal / behavior                                           |
| ------- | --------------------------------------------- | -------------------------------------------------------------- |
| POST    | `/v1/auth/login`                              | Email/password; rotates session cookie                         |
| POST    | `/v1/auth/demo`                               | Explicit demo mode only; viewer by default                     |
| POST    | `/v1/auth/logout`                             | Session + CSRF, including viewers                              |
| GET     | `/v1/me`                                      | Current user and session CSRF token                            |
| GET     | `/v1/state`                                   | Session; authoritative bounded site snapshot                   |
| GET     | `/v1/eta?vehicleId=UUID&destination=shipping` | Session; dispatch-duration preview, no reservation             |
| GET     | `/v1/eta/monitoring`                          | Admin; recent prediction, error and coverage metrics           |
| GET     | `/v1/vehicles/:id`                            | Session; latest 60 raw inbox messages and outcomes             |
| GET     | `/v1/incidents/:id`                           | Session; incident timeline                                     |
| GET     | `/v1/missions/:id`                            | Session; mission timeline and commands                         |
| POST    | `/v1/incidents/:id/actions`                   | Operator + CSRF; `{action, version, note?}`                    |
| POST    | `/v1/missions`                                | Operator + CSRF + Idempotency-Key; `{vehicleId, destination}`  |
| POST    | `/v1/missions/:id/cancel`                     | Operator + CSRF; `{version}`                                   |
| POST    | `/v1/ingest/sessions`                         | Gateway key; `{vehicleId, bootId}`                             |
| POST    | `/v1/ingest/telemetry`                        | Gateway key; `{messages: [...]}`, maximum 500 / 1 MB           |
| GET     | `/v1/gateway/vehicles`                        | Gateway key; only authorized site's vehicle/configuration data |
| GET     | `/v1/gateway/vehicles/:id/commands`           | Gateway key; only authorized site's vehicle commands           |
| POST    | `/v1/sim/scenario`                            | Demo admin + CSRF; `{vehicleId, kind}`                         |
| GET     | `/metrics`                                    | Admin; Prometheus HTTP and admission metrics                   |
| GET     | `/healthz`                                    | Process health                                                 |
| GET     | `/readyz`                                     | Database/schema readiness                                      |
| UPGRADE | `/v1/ws`                                      | Session + exact Origin; ready and coalesced invalidate hints   |

Operator mutations use `X-CSRF-Token` from `/v1/me`. `Idempotency-Key` is 8–128 characters, scoped by actor and operation. Reuse with a changed body returns 422. Dispatch requires an idle, unreserved vehicle, current contact, fresh telemetry, at least 25% battery, and no unresolved critical incident.

Dispatch responses and state mission rows include immutable `eta` predictions, with `source` (`model`, `baseline`, `unavailable`), features, duration, model version and checksum. Only model predictions carry calibrated bounds. Completed mission rows additionally expose receipt-based `eta_observed_seconds` and `eta_reconciled` monitoring labels. See [ETA contracts](eta.md).

Gateway authentication is `Authorization: Bearer <INGEST_KEY>`. Snapshot shape:

```json
{
  "kind": "snapshot",
  "vehicleId": "UUID",
  "bootId": "UUID",
  "seq": 1,
  "at": "2026-10-19T12:00:00.000Z",
  "x": 130,
  "y": 150,
  "heading": 0,
  "speed": 0,
  "battery": 85,
  "status": "idle"
}
```

Command report shape:

```json
{
  "kind": "command_report",
  "vehicleId": "UUID",
  "bootId": "UUID",
  "seq": 2,
  "at": "2026-10-19T12:00:01.000Z",
  "commandId": "UUID",
  "attemptId": "UUID",
  "outcome": "completed"
}
```

`seq` is a safe nonnegative integer shared by snapshot/report messages within a boot. Preserve the entire envelope across retries. Accepted inbox identity is immutable. Report outcomes are accepted, started, completed, canceled, or rejected; valid outcomes depend on command kind. A successful transport admission can still produce an `unauthorized_report` processing outcome if the command does not belong to the reporting vehicle/attempt. It never mutates that command.

WebSockets accept no client subscriptions or arbitrary messages; the single-site session defines scope. A `ready` event triggers a full authoritative read, and every `invalidate` triggers coalesced refresh. Slow sockets close with 1013; the browser reconnects and still reconciles periodically.
