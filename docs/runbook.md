# Operating Fleetdeck

## ETA quality or model availability

Inspect admin-only `/v1/eta/monitoring` and `fleetdeck_eta_recent_*` metrics, including usable label counts and reconciled exclusions. Check unfinished missions too; completed-only metrics can hide delays. Predictions are immutable dispatch estimates. Missing artifacts and unsupported inputs fall back to an uncalibrated baseline; stale telemetry withholds estimates. To disable learned estimates, set `ETA_ENABLED=false` and recreate API/worker containers. See [model operations](eta.md) for calibration assumptions, monitoring guidance and reproduction.

## Inbox backlog

Inspect the Overview pipeline card and `/v1/state` health fields. Confirm the worker is running with `./scripts/compose.sh logs worker`. New admissions receive 503 above the pending-work limit; gateways retain their immutable messages and retry. Processed history does not count toward the limit. Restart the worker; its uncommitted PostgreSQL transaction rolls back and the pending work can be claimed again. Do not delete inbox rows to quiet the backlog: they are identity fences and the retained history.

## A vehicle appears offline

Check last contact separately from last observation. Offline detects missing current-boot gateway contact, not physical vehicle failure. Verify the simulator/gateway process and its API access. In the demo, restore the scenario from vehicle detail. Recovery clears the condition; acknowledge, investigate and resolve its incident with a note. A fresh connection carrying old observations remains ineligible for dispatch.

## Mission outcome unknown

The vehicle remains reserved because execution may have happened. Restore contact and inspect the attempt timeline. A valid terminal report reconciles the outcome even if the start report was lost. An operator can request cancellation; release still waits for terminal evidence. Do not edit mission rows to reassign the vehicle. If no terminal evidence is recoverable, the bounded product deliberately requires investigation rather than inventing certainty.

## Browser reconnecting or stale

REST is authoritative. The browser re-reads after socket ready and every five seconds. Refresh the page if needed. Check API readiness and database access. Loss of PostgreSQL notification delivery degrades update latency to periodic polling; it does not lose committed state. A suspended browser or unavailable API cannot converge until it resumes.

## Simulator stopped

The simulator persists its world, sequence counters, retry outbox and command ledger in `.local/simulator.json`, or the named Compose volume. Stop the old process before replacing it. Its `.lock` prevents simultaneous local writers; after a hard kill, confirm the old process is absent before removing a stale `.lock`. A full 7,200-message vehicle buffer pauses new sampling and report enqueueing while retained messages continue to drain after contact returns. Reports remain pending until they enter the persisted outbox. If new buffered identities become older than the 24-hour admission window, export and reconcile the outbox explicitly; the simulator does not silently discard them. Never reset its state while retaining the server database as a casual recovery step: that changes the vehicle boot/command recovery boundary. Export the state for investigation first.

## Database and backups

PostgreSQL is the source of truth. Back up both the database and simulator volume for a consistent demo recovery. Native SQL identities and audit history are retained indefinitely in this release. Configure storage monitoring; a production installation needs an explicit retention/archive design that preserves retry and reconciliation identity horizons. Disaster recovery must be restore-tested separately from process-crash recovery.

## Security configuration

Keep `.env` out of source control. Use a secret manager for deployment, configure TLS at the ingress, secure cookies, and an exact HTTPS origin. Seed an administrator with a strong password while demo mode is disabled. Place a shared rate limiter at an internet ingress. Database and metrics must not be public. See deployment instructions before changing binding or exposing the service.
