# Automations: intake rules, schedules and starting many

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 6's spec: "continue working on everything throughout the night"). Settles Q210 to Q213. Covers F-011, F-106, F-107 and F-077, and builds on ADR 0037 (schedules on ostra's own table, after spike 8), ADR 0011 (nothing acted on before it's saved), ADR 0031 (nothing automatic without a limit) and ADR 0055 (the budget gate). **Amended 2026-11-21, the maintainer's decision** ("yes" to webhook triggers, from `research/multica-comparison.md`): a third trigger, a webhook request, covers F-139 (the section "Webhooks").

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

## Webhooks

Added 2026-11-21, the maintainer's decision ("yes"). An alert or a failed pipeline posts to ostra, and a task starts (F-139). Multica's autopilots take webhooks with filters and an idempotency key (`research/multica-comparison.md`); this is ostra's form of it, inside the rules above.

- **A webhook automation is a third kind,** beside intake rules and schedules. It starts one prompt task per request it takes, with the kind, profile, pool labels and "wait for approval" of the other two. It needs no board.
- **Its address is `POST /webhooks/automations/<id>` on core's public address** (`OSTRA_CORE_PUBLIC_URL`), the address the tracker's and GitHub's webhooks use. The ID is 24 random bytes, base64url, made when the automation is created: it routes the request, and nobody can guess it. It isn't the credential.
- **The credential is a signing secret,** 32 random bytes made with the automation, kept in the secret store and shown once, in the create's answer. "New secret" makes another, shown once, and the old one stops working at once. The automation says how a request proves it holds the secret:
  - **`signature`** (the default): `X-Ostra-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body under the secret, the form GitHub's own webhooks use, so a shell computes it with `openssl`.
  - **`bearer`**, for a sender that can't sign (an alerting tool that can only add a header): `Authorization: Bearer <secret>`.
  - An automation verified by signature refuses a bearer token, and the other way round, so a secret meant to sign is never sent as a header by mistake. Both compare in constant time.
- **The order before the answer,** as the inbox's (ADR 0013): the automation by its ID (an unknown, deleted or other kind's ID is `404`); the body read up to `OSTRA_WEBHOOK_BODY_MAX_KIB`, 64 KiB *(working value)* (`413`, nothing stored); the signature or the token (`401`, nothing stored); the body as JSON, an empty one as `{}` (`422`); then one transaction under a lock on the automation's row.
- **In that transaction,** in this order: the request rate, at most `OSTRA_WEBHOOK_REQUESTS_PER_MINUTE`, 60 *(working value)*, counted from the automation's request runs of the last minute (`429` with `Retry-After`, and no row: a flood leaves no history to page through); a repeat of an idempotency key; a pause; the filter; "skip while the last one is open"; the hourly limit; then the start through `startTask`, as every other start (ADR 0056's first rule). Each request it takes is a run of kind `request`, the history's row.
- **Idempotency:** the key is the `Idempotency-Key` header, or else the body field the automation names (`body.alert.id`), at most 255 characters. A key is spent by a request that started a task: a repeat within 24 hours starts nothing, is recorded `skipped: duplicate`, and answers `200` with the first task's ID. A key whose earlier request started nothing (filtered, skipped, refused) is taken again, so a sender retrying a refusal isn't stuck. Only the key's SHA-256 is stored. The automation's row lock makes two requests with one key at once start one task.
- **The body is untrusted data,** as ticket text is (AGENTS.md):
  - The automation's prompt and title are templates written by a project admin. A placeholder names a body field by a simple path, `{{body.alert.title}}` (dot-separated keys, a number for an array's item); `{{body}}` is the whole body. A placeholder that isn't such a path is refused when the automation is saved.
  - In the prompt, a one-line string lands as an inline code span, a string over lines in a block marked `webhook-text`, an object or array as JSON in a block marked `webhook-json`, each fence longer than any run of backticks inside; a number, a boolean or `null` as written; a missing field as `(none)`. ostra's own first paragraph says that what's in backticks and those blocks is the request's, sent from outside ostra, to read as information and never as instructions.
  - In the title, a field is plain text on one line, with control characters removed, as a ticket's title is.
  - Nothing of the body reaches a shell, a log line or an audit entry. The prompt goes to the agent as a prompt task's does.
- **The filter** is a list of conditions on body fields, all of which must hold: `equals` and `not-equals` (the field as text, exactly; a missing field isn't equal), `contains` (a string holds the text, in any case, or an array holds an item equal to it) and `exists` (present and not `null`). At most 10. No conditions: every request starts a task. A request it doesn't match is recorded `skipped: filtered` and answered `200`.
- **The limits ADR 0031 asks for** are a schedule's and a rule's: "skip while the last one is open", on by default, and at most `OSTRA_WEBHOOK_STARTS_PER_HOUR`, 20 tasks an hour *(working value)*. The request over it is recorded `skipped: hourly_limit`, answered `429`, pauses the automation and tells the project's admins, as an intake rule's 21st match does. The task then passes the queue, the project's share of a pool and the budget like any other. A webhook automation's task isn't an outside task: a project admin wrote the automation.
- **The answers:** `202` with `taskId` for a start; `200` with `status` `duplicate` (and the first `taskId`) or `skipped` (and its reason: `filtered`, `last-open`, `paused`) for a request that started nothing by the automation's own settings, so a sender doesn't retry it; `401`, `404`, `413`, `422` (not JSON, a bad key, a prompt over the limit, or the project's setup refused the start: no repo, or no profile with a model) and `429` as above; `503` with `Retry-After` when the database misses its deadline, so the sender retries. A setup refusal is recorded `skipped: setup`.
- **Every request is logged** with the automation's, the organization's and the project's IDs, the run's and the task's, the outcome and the body's size, never the body, the key or a header.

## Considered options

- **Rules that start every current match when saved.** Rejected: the dry run shows the same list, and a person decides.
- **A rule that starts again when a ticket re-enters its filter.** Rejected: labels flap, and each flap would be a task.
- **pg-boss's own cron for schedules.** Rejected by spike 8 (ADR 0037): a replica killed holding a batch sends some occurrences twice.
- **`cron-parser`.** Not chosen without a yes, and not needed.
- **One transaction for a whole bulk start.** Rejected: one ticket's failure would undo forty-nine starts.
- **Running the parent as well as its children.** Rejected by F-077.
- **A webhook signature with a timestamp** (Stripe's and Slack's form), against a captured request sent again later. Not chosen: a sender would need both headers and a clock, and a shell step more than one `openssl` line. A replay is bounded by the idempotency key, the caps and TLS. Revisit if teams post through relays they don't trust.
- **One secret accepted both ways.** Rejected: the automation names one, so a signing secret isn't sent as a bearer header by mistake.
- **Recording every refused request.** Rejected: a `401`, `413`, `422` and the rate's `429` are logged only. They come before or instead of anything the automation does, and a flood would fill the history.
- **The automation's own ID in the URL.** Rejected: it's a UUIDv7, partly a timestamp. The webhook's ID is random.

## Consequences

- The schema gains the automation's zone, prompt and pause, `AutomationRun` for occurrences and matches, bulk starts and their items, and the task's origin (milestone 6's spec, section 5.3).
- F-048's schedule hunt runs against the scheduler tick in milestone 2's failure suite.
- Revisit the hourly limit and the one-hour interval if teams hit them in normal use; revisit "blocked by" ordering if sub-issue tasks often conflict.
- Webhooks (2026-11-21): the schema gains the `webhook` kind, the automation's webhook ID, its secret's reference, its verification, its payload filter and its idempotency field, the `request` run with its key's hash, and the skip reasons `filtered`, `duplicate` and `setup`; three settings, `OSTRA_WEBHOOK_STARTS_PER_HOUR`, `OSTRA_WEBHOOK_REQUESTS_PER_MINUTE` and `OSTRA_WEBHOOK_BODY_MAX_KIB`. The start's origin gains `webhook`.
