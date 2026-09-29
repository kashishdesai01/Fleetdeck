# 001 — Admit telemetry into PostgreSQL before acknowledging it

Status: accepted.

The console needs a precise answer when a gateway asks whether it can discard a retried batch. Acknowledging a Redis write before an explicitly durable boundary leaves a separate loss window and reconciliation protocol.

Fleetdeck validates an immutable batch, reserves message identities, and inserts its inbox rows in a committed PostgreSQL transaction before HTTP 202. The worker makes only database effects and applies a vehicle's bounded batch in one transaction under its row lock. A process crash rolls back partial effects and releases ownership. Unprocessed rows remain claimable.

This removes a broker from the correctness path. PostgreSQL now carries admission and history load; the local benchmark is deliberately a modest smoke workload, not evidence of unlimited burst capacity. Admission checks unfinished work and returns explicit backpressure. The release retains identity rows indefinitely; deletion requires a separate retry/archive horizon design.

Alternatives: a durable broker with an application receipt/reconciliation protocol; synchronous full processing in the HTTP request. Both can be valid. The inbox gives the smallest explainable durable boundary for the implemented fleet and keeps intake independent of application work.

Evidence: immutable retry/conflict, SQL ordering, concurrent consumer, capacity recovery, rollback and SIGKILL integration tests; packaged worker stop/start recovery.
