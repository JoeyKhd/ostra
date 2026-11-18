# Open questions

**Who answers:** 👤 = the maintainer's call · 🔬 = research informs it, then we decide together.

A settled question leaves this file. Its answer lives on in the ADR (`decisions/`) or ledger row (`features.md`) that settles it. IDs are permanent.

## Settled

| Question | Settled in |
|---|---|
| Q-01 name | "ostra" |
| Q-02 | ADR 0009 |
| Q-03 | ADR 0010 |
| Q-04, Q-18 | ADR 0008 |
| Q-05 | ADR 0012 |
| Q-06 | ADR 0014 |
| Q-07, Q-08 | ADR 0006 |
| Q-09 | F-007 |
| Q-10 | ADR 0019 |
| Q-11, Q-19 | ADR 0013 |
| Q-12 | F-053 and ADR 0013 now; F-034 later |
| Q-13 | F-026 |
| Q-14 | ADR 0020 |
| Q-15 | ADR 0017 |
| Q-16 | F-041 in v1; F-029 later |
| Q-17 | F-054 |
| Q-21 | F-055 in v1; F-056 later |
| Q-22 | ADR 0018 |
| Q-23 | ADR 0016 |
| Q-24 | F-021 |
| Q-25 | ADR 0004: Claude Code only in v1, then the researched tiers |
| Q-26 | F-050 to F-052 |
| Q-27 | F-058 in v1 |
| Q-28 | ADR 0018: Claude Code through ACP |

## Open

**Q-20 🔬 Jira's sign-in model** (F-008, ADR 0001). Atlassian says integrations that have each customer create their own OAuth app don't comply with its rules. How that applies to self-hosted tools is unverified. The safer route is a service account the team owns, plus webhooks an admin registers. Settle before Jira work starts.

## Round 7 (asked 2026-11-18, waiting for the maintainer)

The maintainer: the product "doesnt feel like a HUGE tool", and "i want to be able to scale infinitely". Each line below is followed by my recommendation.

**Making it a big tool**

| # | Question | Recommendation |
|---|---|---|
| Q1 | What "huge" means | Scale and autonomy in v1; enterprise depth later |
| Q2 | Environments at scale | Team templates plus auto-detection from every repo the App sees (lockfiles, tool versions, `.env.example`, `devcontainer.json`), reviewed in bulk |
| Q3 | Setup step 5 | Renamed "Prepare your repos" |
| Q4 | Starting many tickets at once | From the Inbox and from a rule's dry run, in v1 |
| Q5 | Runners page | A fleet view: slots, queue, versions, labels |
| Q6 | Insights | In v1: throughput, time to PR, time waiting on people, merge rate, tokens |
| Q7 | Tickets spanning several repos | Their tasks shown as one group |

**After looking at Omnara and its alternatives**

| # | Question | Recommendation |
|---|---|---|
| Q8 | Elastic runners | Design for them in v1, ship the first provider right after |
| Q9 | Runner pools | In v1 |
| Q10 | Schedules on intake rules | In v1 |
| Q11 | Spike 1 | Claude Code through ACP versus through Rivet Sandbox Agent; adopt Sandbox Agent if it passes |
| Q12 | CI failures and review comments sent to the owning agent | Move F-035 into v1 |
| Q13 | Reviewer agent as a profile option | In v1 |
| Q14 | Variants ×2/×3 | Soon after v1 |
| Q15 | YAML workflows | After v1 |

**Scaling without limits**

| # | Question | Recommendation |
|---|---|---|
| Q16 | Secrets | **Settled 2026-11-18: per repo** ("16 per repo ofc"). Recorded in F-050 |
| Q17 | Keys the agent can see | Model keys and GitHub tokens added by a proxy on the runner, never visible to the agent, in v1 |
| Q18 | Scale target | 1,000 tasks at once per install *(working value)*, the core service running as several copies |
| Q19 | Subscriptions versus scale | Subscriptions only on members' own laptops; pools and automation on team API keys, Bedrock or Vertex |
| Q20 | Rate limits | Tracked per provider and key; tasks wait instead of failing |

**Not reinventing the wheel**

| # | Question | Recommendation |
|---|---|---|
| Q21 | Copy specific Apache/MIT modules (Cyrus's Linear agent handling, Vibe Kanban's agent drivers, Cezar's variants and workflows) with attribution and a `NOTICE` file, instead of rewriting them | Yes, one module at a time, each in an ADR. The product as a whole stays our own (ADR 0015) |
| Q22 | Run the Tier 1 research | **Settled 2026-11-18: yes.** Running: `research/durable-execution.md`, `elastic-sandboxes.md`, `live-sync.md`, `integrations-platform.md`, `credential-proxy.md`, `runner-transport.md` |

**From the Tier 1 research**

| # | Question | Recommendation |
|---|---|---|
| Q23 | Token-level text deltas versus "saved before acted on" (ADR 0011), raised by `research/live-sync.md` | Stream deltas to the browser without saving them. Save each completed message and every event ostra acts on (tool calls, approvals, state changes). Deltas are display only, and nothing acts on them |
| Q24 | The durable queue (ADR 0017), from `research/durable-execution.md` | Adopt the MIT core of **DBOS Transact**, pending spike 6 (its nine pass/fail scenarios), with pg-boss as the fallback. Keep every DBOS import in one package, so swapping it out stays possible if DBOS drifts toward open core |
| Q25 | Integrations, from `research/integrations-platform.md` | No integrations platform: each one is a cloud service, ELv2 (Nango) or abandoned. Use the official SDKs behind ostra's adapters: `@linear/sdk`, the Octokit modules (`auth-app`, `webhooks`, `plugin-throttling`, `plugin-retry`, `createFromManifest`) and `jira.js` later. Port Cyrus's agent-event-to-Linear-activity rules, tool-call formatter and webhook fixtures, with attribution (needs Q21) |
