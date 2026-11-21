# Every integration is an adapter on an abstract base class

**Status:** accepted on 2026-11-18. Amended 2026-11-18: there are eight kinds. `ExecutorAdapter` replaces `RunnerProviderAdapter`, `BlobStoreAdapter` is new, `AgentAdapter` goes over ostra's own ACP driver instead of Rivet (ADR 0032), the shared plumbing takes its stores as interfaces, and the v1 column is updated (Q76, Q78, Q98). The maintainer: "we should create a class, and then every integration uses an abstract class of that class. So basically, everything becomes an adapter that we can just build upon ... That way, our code becomes very easy to modify and build upon and extend upon." **Amended 2026-11-21 by ADR 0069:** `CodeHostAdapter` gains the optional capability `readTree` (`resolveRef` and `readTree` at a commit), and by ADR 0068: `ExecutorAdapter` declares `boxBrowser` and `appReach`.

This extends ADR 0013 ("each tracker is an adapter") to every kind of integration. Each kind has **one abstract base class** in its own package. Concrete adapters extend it, using the vendor's official SDK inside (Q25: no integrations platform).

| Kind | Base class | v1 adapters | Later |
|---|---|---|---|
| Tracker | `TrackerAdapter` | Linear | Jira, GitHub Issues, GitLab |
| Code host | `CodeHostAdapter` | GitHub | GitLab, Bitbucket |
| Agent | `AgentAdapter` (over ostra's own ACP driver, ADR 0018, ADR 0032) | OpenCode (Claude Code moved after v1 on 2026-11-19) | Claude Code, Codex, Pi |
| Executor | `ExecutorAdapter` (runs in the runner, ADR 0029) | `docker`, `host`, `kubernetes` | Community executors |
| Model provider | `ModelProviderAdapter` | Any base URL and token, with the models.dev catalog (ADR 0033) | Providers that sign each request |
| Notification channel | `NotificationAdapter` | The panel, Linear, email | Slack |
| Secret store | `SecretStoreAdapter` | Built in, encrypted in Postgres | Vault/OpenBao, cloud key managers (F-133) |
| Blob store | `BlobStoreAdapter` (ADR 0043) | Built in, in Postgres. Any S3-compatible store, optional | — |

**Each base class:**
- declares the abstract operations every adapter of its kind must implement, typed with branded IDs and Zod-checked results
- declares **capabilities** as a typed object (e.g. `agentSessions`, `steerMidTurn`, `services`). Optional abilities are declared, never assumed (adapter parity, `AGENTS.md`). Two declarations came from the spikes: an agent declares `steerMidTurn` (OpenCode does, ADR 0032), and a code host declares the hosts its LFS actions may call, `lfsActionHosts` (ADR 0030)
- holds the shared plumbing, written once:
  - rate limits per credential (Q20)
  - retries with backoff
  - idempotency keys (ADR 0011)
  - Zod validation of vendor data at the boundary
  - logs that carry IDs and never content
  - health checks

  The plumbing needs state, such as a rate budget or an idempotency key. It takes its stores as small interfaces, which the server implements with Postgres. So no Apache-2.0 package imports the database package (ADR 0009, Q78, Q79).

## Rules

- **A contract test suite per kind.** Every adapter must pass it, against fakes and against the test workspaces. An adapter is done when its suite is green. The agent suite also runs a scripted fake ACP agent that declares what OpenCode lacks (ADR 0018).
- **One level of inheritance.** An adapter extends its kind's base class and never another adapter. Shared helpers are composed in, not inherited.
- **A registry.** Adapters register by kind and name. Later, each is an npm package (`@ostra/adapter-linear`) under the Apache-2.0 adapter SDK (ADR 0009), so the community can add adapters.

## Consequences

- Adding Jira, GitLab, Codex or a community executor means one new class plus a green contract suite. No core change.
- `AGENTS.md` allows classes for adapters. Everything else keeps the function style.
- The executor adapter lives in the runner, not in the server. The differences between executors are capabilities it declares. The `host` executor declares no services and no box sizes (ADR 0029).
