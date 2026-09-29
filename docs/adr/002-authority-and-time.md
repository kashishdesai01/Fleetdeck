# 002 — Separate ordering authority from device time and freshness

Status: accepted.

Device clocks can move backward or forward. Clamping event timestamps to receipt time creates a total order but can still make delayed older sequences overwrite newer vehicle state.

The server activates an ordered boot generation; a sequence within that boot establishes current snapshot authority. Old boots remain historical and cannot reactivate through a repeated registration. Snapshot and report messages share an immutable transport counter, while reports do not advance the current snapshot sequence.

Four times answer different questions: device observation, its immutable first server receipt, latest gateway contact, and worker application. Current gateway contact is allowed to refresh on an unchanged retry. It does not refresh the exact applied observation's receipt. Dispatch requires both recent device observation and recent first receipt, plus live contact; it does not infer observation freshness from processing time. A new boot clears the receipt until another snapshot applies.

Rules use fresh observations and processing-time durations. Missing observation intervals interrupt continuity while preserving an already active condition so later recovery can clear it. The release intentionally stores historical replay without generating retrospective live incidents.

Consequences: event-time alarm reconstruction and gap correction are outside this version. A skewed device can be connected while its observation is ineligible. This uncertainty is visible rather than corrected by a guessed clock offset.

Evidence: skew, boot, conflicting identity, observation-gap, interruption/recovery, and delayed-queue receipt regressions.
