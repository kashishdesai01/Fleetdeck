# Fleetdeck

**A control room for fleet operations.** Track vehicles, investigate incidents, and dispatch missions from one workspace.

Fleetdeck combines a live map, incident workflows, mission control, learned ETA predictions, and an audit trail. A persistent simulator runs 25 synthetic vehicles through the same telemetry and command APIs used by the console.

![Fleetdeck overview](docs/assets/overview.png)

[Watch the demo](docs/assets/demo.webm) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [ETA model](docs/eta.md)

## Features

- **Live fleet map:** vehicle positions, operating status, battery levels, and telemetry freshness.
- **Incident management:** detect connection loss, low battery, stalled movement, and unknown command outcomes; acknowledge, assign, and resolve incidents with notes.
- **Mission control:** select a vehicle and destination, follow execution, request cancellation, and reconcile delayed reports.
- **Learned ETA predictions:** preview mission duration and a calibrated range before dispatch; retain model version and inputs with each mission.
- **Durable processing:** PostgreSQL-backed message admission, ordered boot sessions, immutable retry identities, and transactional workers.
- **Operator controls:** session authentication, viewer/operator/admin roles, CSRF protection, optimistic concurrency, and audit history.
- **Observability:** readiness checks, structured logs, Prometheus metrics, and model error/coverage monitoring.
- **Scenario lab:** simulate connectivity loss, low battery, stalled movement, and lost command reports.

## Run locally

Install **Node.js 22.14+ or 24 LTS** and **Docker Compose**, then run:

```sh
git clone https://github.com/kashishdesai01/Fleetdeck.git
cd Fleetdeck
npm ci
make demo
```

Open **http://127.0.0.1:3080** and select **Explore the demo**. Startup generates local secrets, applies database migrations, seeds the fleet, and starts the API, worker, simulator, and PostgreSQL containers.

```sh
make logs       # Follow application logs
make stop       # Stop containers and preserve local data
make demo       # Build and start the stack again
```

Local configuration lives in `.env`; available settings are documented in [.env.example](.env.example). Set `DEMO_ACCESS=viewer` for a read-only session. See [deployment](docs/deployment.md) for authenticated service configuration.

## Try the workflow

1. Inspect a vehicle from the map or fleet list.
2. Open **Scenario lab → Lose contact** and follow the resulting incident.
3. Acknowledge the incident, assign it, restore contact, and resolve it with a note.
4. Select **Create mission**, choose an available vehicle and destination, and inspect the ETA preview.
5. Follow the mission through execution and completion in **Mission control**.
6. Enable **Lose command reports** to explore how reservations and reconciliation behave when execution reports are delayed.

## Technology

| Area                | Stack                                                         |
| ------------------- | ------------------------------------------------------------- |
| Frontend            | React, TypeScript, Vite, Lucide icons                         |
| API                 | Node.js, Fastify, Zod                                         |
| Storage and workers | PostgreSQL 17, transactional inbox, row locking               |
| Live updates        | WebSockets, PostgreSQL notifications, snapshot reconciliation |
| ETA training        | Python 3.13, scikit-learn, NumPy, SciPy                       |
| ETA serving         | Exported regression trees evaluated in TypeScript             |
| Testing             | Vitest, fast-check, Playwright, axe-core                      |
| Development and CI  | Docker Compose, ESLint, Prettier, GitHub Actions              |

## Architecture

```mermaid
flowchart LR
  Simulator[Persistent fleet simulator] -->|Telemetry batches| API[Fastify API]
  API -->|Durable admission| DB[(PostgreSQL)]
  Worker[Transactional worker] -->|Process and update| DB
  DB -->|Notifications| API
  API -->|Live updates| UI[React console]
  UI -->|Dispatch and incident actions| API
  API -->|Mission commands| Simulator
  Model[Versioned ETA model] --> API
```

| Directory             | Contents                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| `apps/api`            | Authentication, telemetry admission, workflows, live updates, and metrics |
| `apps/worker`         | Inbox processing, incident rules, and command reconciliation              |
| `apps/simulator`      | Persistent vehicles, command execution, and retry queues                  |
| `apps/web`            | Fleet map, investigation drawers, mission board, and activity feed        |
| `packages/core`       | Message schemas, ordering rules, and incident policies                    |
| `packages/eta`        | Feature contract, inference, trained model, and evaluation                |
| `packages/simulation` | Seeded motion shared by simulation and training traces                    |
| `db/migrations`       | Versioned PostgreSQL schema                                               |
| `ml`                  | Offline training and calibration                                          |
| `tests`               | Unit, property, database, and browser tests                               |

## ETA model

Gradient-boosted regression trees estimate dispatch-to-observed-completion duration from route distance, turns, battery level, and site workload. Training, validation, calibration, and test partitions contain separate synthetic runs. On 1,200 held-out synthetic missions, mean absolute error was **4.65 seconds**, compared with **20.31 seconds** for distance/speed and **5.78 seconds** for linear regression.

The application ships a trained artifact and runs inference directly in TypeScript. To regenerate the dataset and train the model:

```sh
python3.13 -m venv .local/ml-venv
.local/ml-venv/bin/python -m pip install -r ml/requirements.txt
npm run eta:train
npm run eta:reproduce
```

See [ETA training and serving](docs/eta.md) for features, calibration, model metadata, and monitoring.

## Development

```sh
npm run verify           # Types, lint, unit/property tests, and production build
npm run format:check
npm run test:integration # PostgreSQL integration suite
npm run test:e2e         # Browser workflows against the local stack
```

Configure a dedicated test database through `FLEETDECK_TEST_URL`:

```sh
FLEETDECK_TEST_URL=postgres://fleetdeck:password@127.0.0.1:5432/fleetdeck_test npm run test:integration
```

Each database suite uses an isolated schema. Install the browser runtime with `npx playwright install chromium` before running browser tests. Generated reports and screenshots go to `test-results/`.

For native development, configure `DATABASE_URL` in `.env`, run `npm run build`, and start the stack with `npm run demo:native`. Use `npm run web` for the Vite development server; set `PUBLIC_ORIGIN=http://127.0.0.1:5173` on the API for that workflow.

## Documentation

- [Architecture and state contracts](docs/architecture.md)
- [HTTP and live API](docs/api.md)
- [ETA model and evaluation](docs/eta.md)
- [Operations runbook](docs/runbook.md)
- [Deployment configuration](docs/deployment.md)
- [Benchmark harness](docs/benchmarks.md)
