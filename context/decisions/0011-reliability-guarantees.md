# Reliability guarantees

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: guarantee 1 gains one sentence, that partial text is shown, never saved, and nothing acts on it (Q23, ADR 0035). The maintainer: connecting GitHub repos and attaching Linear or Jira boards "must be very robust". These six guarantees were accepted in grilling round 2 (2026-11-17), and each is a v1 row (F-043 to F-048) in the "Reliability and scale" section of `features.md`.

1. **Nothing is lost.** Every ticket event, task change and agent event is saved before ostra acts on it. A server restart picks every task up where it was. Text an agent is still writing is shown to viewers but never saved, and nothing acts on it.
2. **Drift gets fixed.** Regular checks against the tracker and GitHub catch anything a missed webhook would have changed.
3. **Runners can drop out.** A runner that disconnects reconnects and carries on. If it's gone for good, its tasks stop cleanly and can be reopened elsewhere (ADR 0006).
4. **No duplicates.** Every call to a tracker or code host retries safely. A retry never creates a second PR, comment or status change.
5. **Agent crashes don't kill tasks.** A crashed session is marked as such, and the workspace and branch stay, ready to reopen.
6. **It's tested.** End-to-end tests run against the test workspaces, plus failure tests: kill the runner, drop a webhook, restart the server mid-task.

## Consequences

- Background work (webhooks, retries, checks, timers) runs from a durable queue in the database, not from memory. This shapes the server (Q-23) and the database (Q-15).
- Every call to an outside service carries a key that makes repeating it harmless, or checks first whether it already happened.
