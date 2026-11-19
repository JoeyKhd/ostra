# Budgets, and metering at the key proxy

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q105, and the model half of Q20. Moves F-037 to v1 for organizations and projects. **Amended 2026-11-19 after spikes 1 and 10:** every call is metered, and the count has four kinds of token, each priced on its own (Q163).

Spend is counted where every model call passes: the **key proxy** in the box's sidecar (ADR 0030).

## Metering

- The proxy passes the stream through untouched and reads the usage from it, in both API formats the provider form offers. It logs IDs and counts only, never content.
- **It meters every call, whatever the call offers.** Title generation and other calls without tools sit outside every turn's usage figure (554 of 38,741 tokens in spike 1's run, 1.4%), so a count built from the agent's turn reports would undercount. The proxy is the only place that sees all of them.
- **Four kinds of token are counted and priced separately:** fresh input, output, cache reads and cache writes. The proxy stores all four counts per call. In spike 10's 30 runs cache reads were 88% of the tokens and 30% of the spend, while output was 3.6% of the tokens and 60% of the spend, at the prices configured there ($0.036 per million fresh input tokens, $0.50 output, $0.01 cache read), so a price for input and output alone would be far off. Whether models.dev and endpoints' own lists carry cache prices wasn't checked. If a source has none, the admin's price form for a custom model has two more fields (cache read and cache write).
- Each call is priced from, in order:
  1. the endpoint's own model list, where it carries prices
  2. the models.dev catalog (ADR 0033)
  3. a price the admin enters for a custom model
- An endpoint that reports no usage gets an estimate from token counts, and the panel marks that provider's spend as estimated.
- The proxy also reports rate-limit answers. The scheduler stops new dispatches to that provider until the retry time (Q20).
- Metering is the same on every executor. On the `host` executor, the runner process does the sidecar's work, the key proxy included.

## Limits

- **A monthly budget per organization and per project.**
  - At 80%, admins are told in the panel and by mail (F-115).
  - At 100%, new tasks and automatic rounds (ADR 0041) wait. Running tasks finish their current turn.
- **A spend cap per task:** 25 USD *(working value)*, enforced by the proxy. At the cap, the proxy refuses the task's further model calls and the task goes to "needs you", as runaway protection does (F-068).
- **Every start passes the budget gate,** a bulk start included (Q4).

Budgets per member and per agent profile come after v1 (F-131).

## Considered options

- **The agent's own cost figure.** Rejected. It's an estimate (`research/agent-harnesses.md`, unknown 11), and it differs by agent. The proxy sees every call, whatever the agent.
- **The provider's billing data.** Rejected. A model provider is a base URL and a token (ADR 0033), so ostra can't assume a billing API, and such data wouldn't split spend by task.
- **A third-party gateway with virtual keys and budgets, such as LiteLLM.** Rejected. It was supply-chain-compromised twice in 2026, and a Python gateway holding every organization's keys is a large dependency for little gain (`research/credential-proxy.md`).
- **Budgets after v1, as F-037 was.** Rejected. The review loops spend money without a person, so a limit has to exist before they do.
- **Stopping running turns at 100%.** Rejected. An interrupt fails the tool calls in flight and can leave an install or a migration half done (Q52).

## Consequences

- Budgets are only as good as the count. Spike 1 passes only when the proxy's token count is within 2% of what the endpoint reports. Its 2% bar compares the proxy's count with the agent's turn usage for the same response bytes, and the independent check is the provider's own usage figure for the session, which spike 1's run didn't use. Spike 10 records spend per run from the proxy.
- **Spike 10 validated the meter against the agent, not against the bill.** On 30 of 30 runs the proxy's count over the calls that offered tools equalled OpenCode's own turn usage (0% off, against the 2% allowed), with no call missing its usage. Title calls were 0.37% of the tokens (spike 1 saw 1.4%), which is why the proxy meters every call. The reference is OpenCode's parse of the same response bytes, so it validates the meter and not the dollars: unverified against billing. The whole set cost $0.2040, and its dearest run $0.0273, about 900 times under the $25 task cap.
- Every agent is metered by the same proxy. The second agent in milestone 7 (F-018) adds no metering of its own.
- On a personal runner the proxy runs on the member's machine, so an admin allows each provider there knowingly (Q47). Its spend counts the same way.
- Insights (F-108) read tokens and spend from the same records, computed by a scheduled job, not live.
- The key proxy and its metering come first, in milestone 1 (F-089). The spend cap per task follows in milestone 2 (F-068). Budgets are built in milestone 4 (F-037). All three come before the loops in milestone 6.
- Ledger: F-037 is v1 for organizations and projects. F-068 adds the spend cap. F-084's usage is tokens and spend counted at the key proxy. F-089 (the key proxy) counts every call.
- Glossary: Budget is a term.
- Revisit if an endpoint in common use reports no usage in its stream.
