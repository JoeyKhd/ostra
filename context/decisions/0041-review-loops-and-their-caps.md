# Review loops and their caps

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q12 and Q72. Moves F-035 to v1 and splits F-034.

In v1, three signals send a code task back to its coding agent without anyone typing a prompt.

| Signal | What the agent gets | Cap |
|---|---|---|
| **CI fails** on one of the task's PRs (F-035) | The failing checks and their logs | 2 rounds *(working value)* |
| **The AI review** (ADR 0028) has blocking findings (F-101) | The blocking findings. Nits are only listed | 2 rounds *(working value)* |
| **A linked member requests changes** in a GitHub review (F-105) | That review's comments, as one prompt | None on rounds: a person asked |

- **A task gets at most 4 automatic turns** *(working value)*, CI and review rounds together. Then a person has to act: the task goes to "needs you" for its driver.
- **Every turn stops at the task's spend cap and at the budget** (ADR 0042). At 100% of a budget, automatic rounds wait.
- **A question in an automatic round gets a fixed neutral reply, never a decline** (Q160). No member is present, and the agent may ask a question (an ACP elicitation). The driver answers with a fixed line, such as "No one is available to answer. Use your best judgment, say what you assumed, and carry on." It records the question and the reply in the task's activity. Declining isn't an answer: spike 10 found that when the driver declined, OpenCode failed the question tool and the turn ended `cancelled`, which would score an agent as dead for asking. The round still ends at its cap.
- **Every round shows in the task's activity.** While in review, a code task shows where it is: CI running, fixing CI, AI review, fixing findings, or waiting for a reviewer.
- **Every other comment still needs `@ostra`** (F-053). Only a linked member's review counts (F-119).

## Considered options

- **Every PR and ticket comment reaches the agent (F-034 in full).** Rejected for v1. Anyone who can comment could then steer an agent and spend tokens, and comments are untrusted input (`AGENTS.md`). "Changes requested" is an explicit signal that GitHub already has. F-034's remainder stays later, and can become a project setting.
- **No automatic loops in v1, as F-035 was.** Rejected. PRs that arrive green are the point of throughput.
- **Uncapped loops.** Rejected. A loop that spends money without a person needs a hard stop.
- **Sending nits back too.** Rejected. A nit doesn't block a merge, and each round spends tokens without a person.
- **A reviewer as an option on the coding profile (Q13).** Superseded by the review task kind (ADR 0028).

## Consequences

- Domain rule: nothing automatic runs without a limit. Every loop has a cap of rounds, a spend cap and a budget above it.
- The per-task spend cap arrives with runaway protection (F-068) in milestone 2. Budgets (F-037) are built in milestone 4, and the loops in milestone 6. The order is on purpose.
- The code host adapter has to deliver check results, their logs and review events. An adapter that can't deliver one of them declares it as a missing capability (adapter parity, `AGENTS.md`).
- The rounds apply per task across all its PRs (ADR 0027), so a task with three PRs still gets at most 4 automatic turns.
- Ledger: F-035, F-101 and F-105 are v1 rows in milestone 6. F-034 is split: its "changes requested" part is F-105.
- Revisit if two rounds rarely settle anything: the cap drops to one. Revisit if organizations ask for every review comment to count: F-034 becomes a project setting.
