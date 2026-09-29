# 003 — Preserve reservations until terminal execution evidence

Status: accepted.

Loss of a command acknowledgement cannot distinguish a command that was never received from one that executed. Reassigning immediately can duplicate work.

A dispatch creates an immutable mission attempt and a command in the reservation transaction. SQL enforces one active/uncertain reservation per vehicle. Completion and cancellation reports are authorized against command, attempt and vehicle, and can reconcile an attempt without requiring a start event to arrive first. Terminal state cannot regress from delayed start evidence.

Start/cancel deadlines and command rejections retain uncertainty. A rejected cancellation is not evidence that execution stopped. Each operator cancellation retry creates a new immutable command ID and supersedes older deliveries; it does not renew the meaning of an already processed execution ID. The simulator's persisted command ledger deduplicates execution identities and fences cancel-before-start ordering.

The tradeoff is availability: a vehicle can remain reserved while evidence is unavailable. The UI offers investigation and cancellation, not a misleading force-reassign button. SQL uniqueness constrains reservations; physical exactly-once execution is not established by a synthetic protocol.

Evidence: lost acknowledgement, rejected current/superseded command, immutable cancel retry, complete-before-start, obsolete attempt, concurrent reservation and simulator restart/expiry tests, plus the recorded uncertainty workflow.
