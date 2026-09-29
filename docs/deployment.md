# Deployment

The default Compose configuration is an interactive loopback-only demonstration. Its local API serves the built React app; no Vite development server is required. Containers run application code as the non-root `node` user; API and worker use read-only root filesystems and dropped capabilities.

For an authenticated deployment:

1. Set `NODE_ENV=production`, `DEMO_MODE=false`, `COOKIE_SECURE=true`, an explicit `DATABASE_URL`, and an exact `PUBLIC_ORIGIN=https://...`.
2. Provide a random `INGEST_KEY`, `ADMIN_EMAIL`, and an `ADMIN_PASSWORD` of at least 14 characters to the initial seed job. Remove initial password material from running services after provisioning. Existing accounts are not silently overwritten on reseed.
3. Terminate TLS at a trusted ingress and preserve the original Origin. The API does not trust arbitrary forwarding headers. Keep PostgreSQL on a private network and use a managed secret store. Disable simulator deployment for an integration that uses a real gateway.
4. Apply migrations as a one-off release job before starting compatible services. The migration runner takes an advisory lock. Release 001 is a forward-only baseline; schema rollback is a database restore/forward-fix procedure, not a destructive down migration.
5. Run the API and worker separately. Supply resources, log collection, database backup/restore, storage alerts, inbox-age monitoring, and a shared ingress rate limiter. HTTP request/admission metrics are available to administrators at `/metrics`.
6. Check login, session security, readiness, database recovery, and the environment-specific workload after configuring the deployment.

API instances listen to shared database notifications and clients reconcile through authoritative polling. Configure shared rate limiting at the ingress. Run one simulator writer per state file and mount its persistent volume.
