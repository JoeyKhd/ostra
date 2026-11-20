# 41: What milestone 6's review left open

Status: needs-triage
Builder: core, adapters and web
Blocked by: none
Features: F-011, F-099, F-102, F-107, F-113, F-012, F-077, and the screens of ticket 30
Packages: `packages/db`, `packages/adapter-sdk`, `packages/adapters/*`, `apps/core`, `apps/runner`, `packages/api`, `apps/web`
Spec: `../spec.md`

## Why

Milestone 6's review (2026-11-20) fixed what it confirmed in code and tests, one commit each with a proof row; the ledger in `context/features.md` says what each row still waits on. These are what it confirmed and didn't fix, because each is a design change, a migration, or a part of a screen that the tickets didn't build and that no "done when" names. Phone width and accessibility on the automations, boards and inbox screens are another agent's, and aren't listed.

## Core and adapters

- [x] **An intake rule's filter on the tracker's own project matches nothing** (F-011): the ticket cache has no project column. It needs the trackers' `Ticket` to carry the project, Linear's query to read it, a migration adding the column (additive), the ingest to write it, and `matchesFilter` to read it. Until then the editor offers a field that starts nothing. *Done 2026-11-20: `Ticket.trackerProject` (Linear reads `project { id name }`, the Jira fake gives its project), migration `20261128000000_ticket_tracker_project` (two nullable columns), written at ingest, matched by ID or name; the editor offers the cached projects' names. F-011 is `done`; proof in `context/proof/F-011.md` (c1).*
- [ ] **An onboarding task's agent can push other paths to its own branch** (F-113, ADR 0038): the git proxy checks refs, not paths, and when no allowed path changed the runner pushes nothing over it. No PR opens, so it's a stray branch. Ticket 23 recorded it as a limit. Settling it needs a decision: refuse an agent's push when the spec has `commitPaths` (the runner's own push then needs a way past the proxy), or have the runner reset the branch.
- [x] **"Update ticket" can attach an image twice** when a retry follows a crash between the tracker's attach and `attachedAt` (F-099). The tracker interface has no way to list a ticket's attachments by a marker, as sub-tickets have. A small window, and a duplicate image at worst. *Done 2026-11-20: `attachFile` takes a `marker` (the attachment's subtitle) and the tracker interface gains `listAttachments` behind `attachments` (Linear and the Jira fake implement it, a tracker without `attachments` answers `unsupported`, the contract suite checks both); `draft.apply` skips an image whose marker the ticket already holds; proof in `context/proof/F-099.md` (c6, c7).*
- [x] **Agent mode checks a hand-typed scope list and the connection's kind** (`LINEAR_AGENT_MODE_SCOPES` in `packages/domain/src/use-cases/linear-connection.ts`), not the tracker's `agentScopes` and `agentSessions` capabilities. Correct while Linear is the only tracker with agent sessions. *Done 2026-11-20: `missingAgentModeScopes` reads the tracker's declared `agentSessions` and `agentScopes` (Linear's `LINEAR_CAPABILITIES`, carried by `LinearAppKit.capabilities`); the hand-typed list is gone; proof in `context/proof/F-012.md` (c3).*
- [ ] **The AI review reruns on every new head during a review without a cap** (Q224 leaves the review task's turns out of the automatic count). Each run passes the budget gate; whether review runs need a cap of their own is the maintainer's call.
- [ ] **The minimum interval is checked when a schedule is saved**, not at each tick, so one saved under a lower setting (the demo's `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES=1`) keeps its rate after the setting rises (`docs/configuration.md` says so).
- [x] **Core never links a Linear agent session to its task** (`setAgentSessionLink`), though Linear declares it. *Done 2026-11-20: the session's first post links it to the task's page (`sendActivity` in `apps/core/src/linear/agent-mode/outbox.ts`), where the tracker declares `agentSessionLink`; proof in `context/proof/F-012.md` (c2).*

## The screens (against `context/brand/app-targets/m6/`)

Each line is a difference from a build spec that the building ticket didn't record.

- [x] **Inbox ticks across a refresh** (added 2026-11-20 from the lead's list): the Shift range's anchor was a row index and the panel kept the tick order, so a refresh that reordered the rows moved both. *Done 2026-11-20: the ticks and the anchor are kept by ticket (`apps/web/src/components/inbox/inbox-selection.ts`), listed in the list's order with the refreshed copies; proof in `context/proof/F-107.md` (c1).*
- [x] **Inbox bulk start:** ticking another ticket after a bulk start doesn't clear the results, so the bar stays disabled until Done; the started rows stay ticked; the results don't show a started task's state or "Queued" with its reason. *Done 2026-11-20: a tick after the results ends them, started rows untick, and each result says the task's state or `Queued` with why (`apps/web/src/components/inbox/`, `inbox.bulkStart`'s `wait`); proof in `context/proof/F-107.md` (c1).*
- [x] **Ticket parent:** no Age column; the children on no board of the project don't name their board and project; the refined row has no "Draft vN applied by …" line. *Done 2026-11-20: the Age column, the elsewhere rows' board and project (restricted names only to who can open them), and the Refined line (`tickets.parent`, `ticket-parent-view.tsx`); proof in `context/proof/F-077.md` (c2).*
- [ ] **Linear agent mode:** the public address row doesn't show the address; with agent mode on and the address unreachable, State reads "On", not "On, not receiving".
- [ ] **Needs approval:** a collapsed row has a chevron instead of its Reject and Approve buttons.
- [ ] **Refine draft:** no "Retry sync" for a failed write, and no partly-applied state.
- [ ] **Review screen:** no "A new review is running on {sha7}" line; "Resolved" doesn't say its round.
- [ ] **Task rounds:** the Code group has no Head and CI rows; the status doesn't name the sub-state; a released hold's line and the "pushed, CI passed" outcome after each card are missing.
- [ ] **Automations:** "Created {date}" names nobody; the profile isn't a link for organization admins. The history's skip reasons don't link the task.
- [ ] **Environment proposal:** a decided proposal now shows its outcome after a reload, but not its read-only diff for 7 days.
- [ ] **The switch's colour:** the targets disagree (teal in `automations.md`, `--shell` in `review-settings.md`, green in `linear-agent-mode.md`); the app's `Switch` is green. One answer for every screen is the maintainer's.

## Comments
