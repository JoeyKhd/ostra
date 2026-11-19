# 27: Security review: the threat model, the checklist and the findings

Status: ready-for-agent
Builder: an independent session that built none of the box's code (core assigns it), then the maintainer's signature
Blocked by: 07, 08, 28
Features: none (a launch gate, ADR 0064)
Packages: `context/specs/m7-launch/security-review.md` (new), `SECURITY.md` (new), the docs' security page (ticket 23)
Spec: `../spec.md`, section 2; ADR 0064 ("The security review of the box")

## What to do

- **Who:** a fresh agent session that didn't write any of `apps/runner/src/sidecar/`, the executors or `adapter-claude-code`, with the `security-review` skill and this ticket. It reads the code on the release candidate, never a summary of it.
- **The threat model,** per boundary (the agent's container, the sidecar, the runner, the server, the browser): what crosses it, who's on each side, what an attacker on the inside wants.
- **The checklist:** ADR 0064's ten areas, each item with its evidence: a test that already proves it (cited as a proof file cites one), a log from the Linux or kind proof job (ticket 31), the adversarial run (ticket 28), or a finding.
- **Findings,** each with a severity (critical, high, medium, low), where it is, how to reproduce it without a secret, and its fix's commit or why it stays open. A critical or high finding is fixed before this ticket is done, and the run that showed it repeated.
- **What wasn't tested,** and why (a machine, a cloud, a person).
- **`SECURITY.md`:** how to report a vulnerability through GitHub's private reporting, what's in scope, and what to expect.
- **The maintainer reads it and signs it** under `## Comments`, with the date. An outside penetration test is the maintainer's choice; if one is ordered, its report joins the record.

## Done when

- [ ] `security-review.md` holds the threat model, every checklist item with its evidence, every finding with its outcome, and what wasn't tested.
- [ ] No critical or high finding is open.
- [ ] `SECURITY.md` exists, and the docs' security page states the open mediums and lows.
- [ ] The maintainer's signature is under `## Comments`.
- [ ] Committed as `📝 record the security review of the box`.

## Comments
