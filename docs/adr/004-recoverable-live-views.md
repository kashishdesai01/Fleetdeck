# 004 — Treat live notifications as coalesced invalidation hints

Status: accepted.

The operator needs an eventually trustworthy screen after reconnect, not an application pretending its socket is a reliable event log. A committed update can outlive its publisher or notification connection.

Each API instance listens to transactional PostgreSQL notifications and coalesces them into bounded invalidate hints. Authenticated socket readiness triggers an authoritative snapshot. The browser also reconciles every five seconds and on focus. Authoritative reads use one repeatable-read transaction, and full replacement removes entities from filtered views naturally. Failed synchronization is visible.

The read model always includes active incidents and active/uncertain mission reservations, independent of recent resolved/terminal history limits. A long history must never hide the work an operator still needs to reconcile.

This intentionally trades fine-grained delta efficiency for simple recovery at the tested fleet size. Slow sockets are closed and resynchronize. There is no claim of zero-latency recovery while a tab is suspended or the API is unavailable, and the included benchmark does not measure browser paint latency or many-viewer fan-out.

Evidence: browser reconnect/fallback test, active-reservation history regression, real workflow tests and explicit slow-socket queue bounds in the API.
