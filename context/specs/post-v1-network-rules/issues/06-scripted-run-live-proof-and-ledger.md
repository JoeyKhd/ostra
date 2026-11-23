# 06: The scripted run, the live proof and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 02, 03, 04, 05
Features: F-052 (the live clauses of c2 and c4, and the row's status)
Packages: `e2e/f052-network-rules/` (new), `package.json` (the `e2e:f052` script), `.github/workflows/proof.yml` (the live jobs' cases), `scripts/live/docker.sh` and `scripts/live/kind.sh` (if the cases need a step), `context/features.md`, `context/open-questions.md`, `context/GLOSSARY.md`
Spec: `../spec.md`, sections 2 and 3; ADR 0073

## What to build

- **The scripted run, `e2e/f052-network-rules/src/demo.ts`** (`pnpm e2e:f052`), on `host` with loopback origins, following `e2e/m3-step-in/`'s harness:
  1. an environment with no rules: the task's agent environment holds no proxy variable and reaches a loopback origin directly;
  2. a rule for that origin's host and port: a new task's shell reaches it through `HTTP_PROXY`, a second loopback origin on another port is refused with the 403, the Event log shows one `egress.blocked` line, and a third attempt adds no second line;
  3. the panel's tab: add, edit ports, remove, the private-CIDR refusal's message, the empty state, and the three executor notes (read from the rendered page, not from the API alone);
  4. a fake minor-9 peer: a task whose environment has rules is not offered, with the reason, and stays queued instead of failing.
  Each step asserts through the real code path (the API, the task host, the stored events) and writes its result under `## Comments` here and in `demo.md` beside this spec.
- **The live cases** in `proof.yml`'s existing jobs, run once at the launch gate and dispatched only by the lead on the maintainer's word:
  - `live-docker`: from a shell in a real box, `curl` to an allowlisted origin through `HTTP_PROXY` (200), `curl` to a non-allowlisted public host (403 from the proxy), and the same host with `--noproxy '*'` (a connection failure) — the enforcement, with a positive control before each;
  - `live-kind`: the same three, with the third asserted **reachable** (the recorded difference), and the proxy assertions the same.
  The cases go through `@ostra/adapter-sdk/testing`'s allowlist probes, so the jobs and the unit tests can't disagree.
- **The ledger and the paperwork:**
  - `context/features.md`: F-052's row becomes the proposed row in this ticket's `## Comments` — with its seven conditions, status `building` when the code lands and `done` only once `live-docker` and `live-kind` pass, with the dated note about what the live run showed; the ledger's own row is the only change (no other row moves).
  - `context/open-questions.md`: the three questions from the spec's section 8, as new Q-numbers, each marked 👤 for the maintainer;
  - `context/GLOSSARY.md`: **network rule** and **egress proxy**;
  - `context/build-order.md`: the proposed line in `## Comments` (the "Right after" entry for F-052), for the lead to apply with the ledger commit.
- **The demo's own commit** is `✅ prove network rules on a real box` (cases) and `📝 close the F-052 ledger` (the rows), when the run passes.

## Done when

- [ ] The scripted run passes on `host` and its four steps' results are under `## Comments`; a failing assertion stops the run with the step named.
- [ ] The ledger row carries all seven conditions and its status follows the rule: `building` with the code merged, `done` only after the Proof run's two live jobs pass, with the date and what they showed.
- [ ] The three open questions are in `context/open-questions.md`; the two glossary terms are in `context/GLOSSARY.md`; the proposed build-order line and ledger row are in this ticket's `## Comments` for the lead.
- [ ] The whole repo's checks pass, and no `proof.yml` job was dispatched while building.
- [ ] Committed as above, with the ledger commit last and no other shared file touched by this spec's builders.

## Comments

- **The proposed ledger row (for `context/features.md`, status `building` at merge, `done` after the live run):**

  `| F-052 | Network rules | An environment limits which public hosts its agents may reach, as an allowlist on top of the egress baseline (F-116), enforced by an egress proxy in the box's sidecar. A rule is a host (an exact name or `*.` and a suffix) or a CIDR, with one or more TCP ports; a rule inside the baseline's ranges is refused, because an environment narrows the baseline and never widens it (ADR 0073). On `docker` the proxy is the box's only route out, so the rules are enforcement; on `kubernetes` the pod's direct public egress stays (ADR 0029's fourth difference), so the same proxy filters what uses it and not what ignores it; on `host` nothing enforces it (ADR 0029's fifth difference) and the page says so. The rules travel in the task spec at protocol minor 10, so a task with rules waits for a runner that can keep them. A refused destination is one `egress.blocked` line in the Event log, with no path, query or header. *Added before v1; built after it (`specs/post-v1-network-rules/`).* | later | building |`

- **The proposed build-order line (for `build-order.md`'s "After v1, in this order", item 1):**

  `1. **Right after:** network rules (F-052), built from `specs/post-v1-network-rules/`: an environment's allowlist, enforced by the sidecar's egress proxy on `docker`, a filter on `kubernetes` and advisory on `host` (ADR 0073); then Slack (F-057), signed runner binaries (F-085), and Trello, the next tracker, once someone asks (`research/trello-and-notion.md`: a small adapter on the Jira pattern; no ledger row yet).`

- **The three open questions, for `context/open-questions.md`:** (1) whether to close `kubernetes`'s direct egress with Cilium `toFQDNs` or a per-box NetworkPolicy, and the CNI requirement the first brings; (2) whether to add `@anthropic-ai/sandbox-runtime` for `host`; (3) whether an environment may ever open a range inside the baseline, recommended no, with `OSTRA_EGRESS_ALLOW` remaining the runner admin's.
