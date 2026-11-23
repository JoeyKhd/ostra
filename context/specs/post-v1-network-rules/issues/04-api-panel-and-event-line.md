# 04: The Network tab, its procedures, and the Event log's line

Status: ready-for-agent
Builder: api and web
Blocked by: 01
Features: F-052 (c1's editing and c4, c5's words; c7's line)
Packages: `packages/api` (`src/routers/environment-network.ts` (new), `src/routers/environment-network.test.ts` (new), `src/app-router.ts`), `apps/web` (`src/components/projects/environment-network.tsx` (new), `environment-network-words.ts` (new) and its test, `environment-view.tsx`, `src/components/tasks/task-event-log/event-log-words.ts` and its test, `src/components/runners/runner-page-words.ts` and its test, `messages/en.json`), `packages/task-view` (only if the event's words need a place there — ticket 01 added its coverage row)
Spec: `../spec.md`, sections 5.5 and 5.6; ADR 0073

## What to build

- **The API, `packages/api/src/routers/environment-network.ts`**, registered on `appRouter`, on `projectProcedure` exactly as `servicesRouter` is:
  - `list` (`read`): the project's rules as the spec's `RuleView`s in `networkRulesView`'s order, plus `enforcement: { online: ExecutorKind[], pool: ExecutorKind[] }` read the way `whereTasksRun` reads the pools and personal runners;
  - `save` (`admin`): one rule, upserted by an optional `ruleId`; normalised by `normalizeNetworkRule`; refused with `BAD_REQUEST` and `networkRuleProblem`'s exact message; one transaction with the audit action (`environment.network-rule-added` or `-changed`) and a change notice; **no `snapshot.schedule`**; returns the whole list;
  - `delete` (`admin`): by `ruleId`, one transaction with `environment.network-rule-removed` and a change notice; returns the whole list.
  - Project scoping on every query (`organizationId` + `projectId` + the environment's composite relation), so another project's rule is `NOT_FOUND`.
- **The tab:** `"network"` in `EnvironmentTab` and the `?tab=network` handling, the tab strip's label "Network" between Services and checks and App, and a tabpanel that renders `EnvironmentNetwork`.
- **`environment-network.tsx`**, with every word in `environment-network-words.ts` (tested on its own, the `environment-services-words.test.ts` pattern):
  - the list with add (kind picker Host/Address, value, ports prefilled `443`, Add), edit (ports and value), remove, all with per-field server errors shown verbatim;
  - the three executor notes built from `enforcement`, in the order `docker`, `kubernetes`, `host`, and only for the executors that are actually there:
    - "Enforced on `docker`: the agent's container's only way out is the proxy."
    - "On `kubernetes`, a process that ignores the proxy still reaches the internet directly (ADR 0029)."
    - "On `host`, nothing enforces it: the executor isn't isolated."
  - the notes under the list: "Applies to the next task; a running task keeps the rules it started with.", "The setup script and the install at box start run through the proxy: name the package hosts they use.", "A service isn't proxied.";
  - the empty state: "No rules: this environment's egress is unrestricted. On `docker` that still means no public host; on `kubernetes` and `host` the agent has whatever its machine has.";
  - a member sees the list and the notes and no add button; a project admin sees both.
- **The Event log's line:** `event-log-words.ts` gains `egress.blocked`'s words — `Blocked example.com:443 — not in this environment's network rules`, `— inside the egress baseline`, `— couldn't resolve` — and its test. It appears once per destination per task; the fold (`packages/task-view`) treats it as bookkeeping, so it doesn't become a bubble (ticket 01 added the coverage row).
- **The runner page's line:** `runner-page-words.ts` gains one sentence per executor beside the existing executor notes: `docker` "network rules are enforced here", `kubernetes` "network rules are a filter here: the agent keeps direct internet access", `host` "network rules are advisory here: the executor isn't isolated". Its test covers the three.
- **`apps/web/messages/en.json`:** every string above, under `environment.network.*`, `eventLog.egressBlocked.*` and `runner.networkRules.*`; no hard-coded English in the components.

## Done when

- [ ] Tests named for `F-052/c1`: `save` normalises (`EXAMPLE.com.` → `example.com`, ports sorted and de-duplicated), refuses a private CIDR with the spec's message and an IP inside a private CIDR (not only an exact address), and refuses a duplicate `(kind, value)`; `delete` removes the row and the audit entry names it; a member is refused for both mutations and allowed `list`.
- [ ] Tests named for `F-052/c4` and `c5`: the words function emits exactly the three executor notes, in order, only for executors present, and the runner page's three sentences come from one enum with a test per kind (break-it: swap `kubernetes`'s sentence for `docker`'s and the case fails).
- [ ] Tests named for `F-052/c7`: the event's line is one line, names the host and port and the reason, and holds no path, query or header; a second event for the same destination renders one line (the dedupe is the runner's, and the words don't add a thousand).
- [ ] The panel's accessibility follows the page's pattern: the tab is in the existing `tablist`, the add form is labelled, errors are `aria-describedby`, and the empty state is text, not a disabled control.
- [ ] Checks for `packages/api`, `packages/task-view` and `apps/web` pass (typecheck, lint, tests), including the words' tests and the panel's contrast/dark rules.
- [ ] Committed as `✨ edit an environment's network rules`.

## Comments
