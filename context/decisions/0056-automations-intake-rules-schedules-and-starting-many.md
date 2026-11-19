# Automations: intake rules, schedules and starting many

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 6's spec: "continue working on everything throughout the night"). Settles Q210 to Q213. Covers F-011, F-106, F-107 and F-077, and builds on ADR 0037 (schedules on ostra's own table, after spike 8), ADR 0011 (nothing acted on before it's saved), ADR 0031 (nothing automatic without a limit) and ADR 0055 (the budget gate).

An automation starts tasks without a person pressing Start. Every way of starting one, by hand or not, goes through one start use case, so the queue, the project's cap on a pool, the budget and the one-active-task rule apply to all of them alike.

## Intake rules

- **A rule's filter** is a ticket's labels (any of, all of, none of), its status (by ID or by category), its assignee (a tracker user, "unassigned" or ostra's app), its board, and the tracker's own project. It names a task kind, an agent profile and pool labels, never a repo (F-011, Q29).
- **A rule acts when a ticket starts to match after the rule exists,** on milestone 2's ticket ingest, by webhook or by poll. It starts **one task per ticket per rule, ever**: a row keyed on the rule and the ticket, inserted with `ON CONFLICT DO NOTHING`, is the only thing that starts it, so a replayed webhook, a poll racing a webhook, two workers or a ticket that leaves and re-enters the filter start nothing twice. A member starts more by hand.
- **Existing matches don't start when a rule is saved.** The dry run lists them, with what a start would do for each, and "Start all" starts them as a bulk start. A rule saved by mistake can't start a hundred tasks before anyone looks.
- **A rule starts at most 20 tasks an hour** *(working value)*. The 21st pauses the rule, records the match as skipped, and tells the project's admins. A mislabelled batch costs twenty tasks, not five hundred, and the budget sits above that.
- **A rule's tasks aren't outside tasks** (ADR 0057): a project admin wrote the rule. A rule can still ask that its tasks wait for a member's approval, off by default.

## Schedules

- **A schedule is a five-field cron expression in an IANA time zone** (default `UTC`), on the automation's row. ostra evaluates it with its own code on `Intl`: ranges, steps, lists and names; no seconds and no `L`, `W` or `#`. A skipped local time fires at the next valid minute, and a repeated hour fires once. No dependency is added: `cron-parser` sits in pg-boss's tree, and using it directly would need the maintainer's yes for a small piece of code that is easy to test against a reference list.
- **Occurrences are at least an hour apart** *(working value)*. A schedule's work is unattended, and a minute's schedule is a runaway loop with a cron syntax.
- **A schedule either checks a rule's filter,** starting each match the rule hasn't started (up to the bulk limit), **or starts one prompt task** with its prompt, kind and profile.
- **"Skip while the last one is open"** is on by default: an occurrence whose previous task isn't merged, done or stopped is recorded as skipped. "Update dependencies every Monday" doesn't stack four PRs while nobody merges the first.
- **ADR 0037's rules hold:** one tick a minute; each occurrence a row with a unique key on the automation and its time, inserted with its job in one transaction; a missed occurrence under 6 hours late fires once for the latest, older ones are skipped and audited; a pause, an edit or a delete takes effect at the next tick, and an edit never fires a past time.

## Starting many

- **Up to 50 tickets at once** *(working value)*, from the Inbox or a dry run's "Start all".
- **Each ticket starts in its own transaction,** idempotent by the member's request and the ticket, so a retried request starts nothing twice and one failure doesn't undo the others. The result is per ticket: started, skipped (with the reason) or failed.
- **A start that can't run yet is queued, not refused.** Admission, the project's cap on a pool and the budget act on each task as on any other (Q4), and the task shows why it waits.

## Sub-issues

- **A code start on a ticket with open sub-issues starts its leaves:** the open tickets without open children of their own, down to three levels *(working value)*, that are on one of the project's boards; at most 50 *(working value)*, or nothing starts and the member is told.
- **The parent never runs code** (F-077). Its page in ostra lists its children and their tasks, and ostra's progress comment on the parent lists them in the tracker.
- **A child on no board of the project** is listed and not started: ostra can't tell which project it belongs to.
- **A refine start on a parent refines the parent itself:** that's where a ticket is split.
- **Children start together,** whatever the tracker's "blocked by" relations say. Ordering by them waits until teams ask for it.

## Considered options

- **Rules that start every current match when saved.** Rejected: the dry run shows the same list, and a person decides.
- **A rule that starts again when a ticket re-enters its filter.** Rejected: labels flap, and each flap would be a task.
- **pg-boss's own cron for schedules.** Rejected by spike 8 (ADR 0037): a replica killed holding a batch sends some occurrences twice.
- **`cron-parser`.** Not chosen without a yes, and not needed.
- **One transaction for a whole bulk start.** Rejected: one ticket's failure would undo forty-nine starts.
- **Running the parent as well as its children.** Rejected by F-077.

## Consequences

- The schema gains the automation's zone, prompt and pause, `AutomationRun` for occurrences and matches, bulk starts and their items, and the task's origin (milestone 6's spec, section 5.3).
- F-048's schedule hunt runs against the scheduler tick in milestone 2's failure suite.
- Revisit the hourly limit and the one-hour interval if teams hit them in normal use; revisit "blocked by" ordering if sub-issue tasks often conflict.
