# The safety minimum for v1, revised

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0020. Settles F-040, F-060, the egress baseline (F-116) and approvals.

Ticket text, PR comments and agent output are untrusted input. They come from anyone with access to the tracker or the repo, and they reach an agent that can run commands. v1 holds these lines:

1. **A box per task** (ADR 0029). On `docker` and `kubernetes`, every task gets a fresh box, never reused for another task. The docs recommend gVisor as the runtime. The `host` executor has no box: the panel labels it "not isolated", a pool uses it only when an admin opts in, and on a pool the agent runs as a separate OS user.
2. **No credential in the agent's container** (ADR 0030). Model keys and GitHub tokens stay in the sidecar. The agent sees a fake key, valid for one task, and no GitHub token at all.
3. **Only the task's refs can be pushed.** The git proxy refuses every other ref and every delete before a byte reaches GitHub. Refine and review tasks may only fetch (Q66, Q71).
4. **An egress baseline for boxes** (F-116). A box can't reach private address ranges, the cloud metadata address or another box. It's a network policy on `kubernetes` and host rules on `docker`. Allowlists per environment (F-052) come later.
5. **Tasks from outside ostra wait for a member's approval** (F-040). A task started by someone who isn't a member runs on the project's default profile, on a pool, and waits until a member approves it. This is on by default, and an admin can switch it off.
6. **An unprotected default branch gets a warning** (F-060), not a refusal.
7. **Explicit permissions and approvals.**
   - ostra sets every agent's permissions from its profile and never relies on an agent's defaults (F-026, ADR 0018).
   - A profile's approval rules name what needs a person, for example a new dependency or a migration. The answers are "once", "for this task" or "deny".
   - Any member who can open the project may answer. The first answer wins, and it's an audit entry.
   - "For this task" is an ostra rule on the task. The agent itself is always answered "once".
   - The agent can't answer its own approval.
8. **Nothing reaches the tracker or memory from an agent without a person.** Refine drafts and memory proposals wait for a member (Q67, Q86). Every memory note is scanned for secrets (round 13, problem 4).
9. **Nothing automatic runs without a limit.** Every loop has a cap of rounds, every task has a spend cap, and budgets sit above both (Q72, Q105).

## Considered options

- **The runner's container as the boundary, with a container per task later** (ADR 0020, line 1). Rejected: a pool serves many projects, and one project's task could reach another's (`research/elastic-sandboxes.md`, isolation rule 6). A box per task is F-017, now in v1.
- **Keys handed to the agent per task** (ADR 0020, line 2). Rejected by ADR 0030.
- **Refusing a repo whose default branch isn't protected** (ADR 0020, line 4). Rejected: its reason was that a GitHub token can't be limited to one branch. The agent now holds no token, and the git proxy accepts only the task's refs. Branch protection still guards against people, so ostra warns.
- **Egress allowlists in v1** (F-052). Rejected for v1: only an OS-level jail or a CNI that understands names makes them real, and each environment needs its own policy (`research/credential-proxy.md`, summary and §15). The baseline covers the risks a shared pool adds: other projects' boxes, private networks and cloud credentials.
- **Requiring gVisor.** Rejected for v1: a one-machine install must work on plain Docker, and gVisor with rootless Docker is fragile (`research/elastic-sandboxes.md`). The docs recommend it, and spike 3 runs every check with it as well.

## Consequences

- An environment's own secrets are readable by the code under test, and so by anything that tricks the agent. The panel says environments are for dev and test credentials, not production ones (F-050). A secret needed during setup is mounted for the build only, and the build fails if its value is found in the image (ADR 0038).
- The `host` executor is weaker than a box. A member's personal runner can read an organization key only when an admin has allowed that provider on personal runners (ADR 0030).
- The `docker` executor needs the Docker socket, which is root on that host. Pool runners belong on dedicated hosts (ADR 0029).
- A join token is worth every secret of every project that may use its pool. Its rules are in ADR 0029.
- Spike 3 tests lines 1, 2, 4 and the approval rule from a shell in the agent's container. Spike 4 tests line 3.
- Milestone 7 includes a security review of the box before launch.
