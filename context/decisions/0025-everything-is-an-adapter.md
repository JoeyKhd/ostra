# Every integration is an adapter on an abstract base class

**Status:** accepted on 2026-11-18. The maintainer: "we should create a class, and then every integration uses an abstract class of that class. So basically, everything becomes an adapter that we can just build upon ... That way, our code becomes very easy to modify and build upon and extend upon."

This extends ADR 0013 ("each tracker is an adapter") to every kind of integration. Each kind has **one abstract base class** in its own package. Concrete adapters extend it, using the vendor's official SDK inside (Q25: no integrations platform).

| Kind | Base class | v1 adapters | Later |
|---|---|---|---|
| Tracker | `TrackerAdapter` | Linear | Jira, GitHub Issues, GitLab |
| Code host | `CodeHostAdapter` | GitHub | GitLab, Bitbucket |
| Agent | `AgentAdapter` (through Rivet Sandbox Agent, ADR 0024) | OpenCode | Claude Code, Codex, Pi |
| Runner provider | `RunnerProviderAdapter` | Fixed runners, Docker | E2B, Kubernetes `agent-sandbox` |
| Model provider | `ModelProviderAdapter` | The models.dev catalog plus any base URL and key | — |
| Notification channel | `NotificationAdapter` | The panel, Linear | Email, Slack |
| Secret store | `SecretStoreAdapter` | Built in, encrypted in Postgres | Vault/OpenBao, cloud key managers |

**Each base class:**
- declares the abstract operations every adapter of its kind must implement, typed with branded IDs and Zod-checked results
- declares **capabilities** as a typed object (e.g. `agentSessions`, `pause`, `steerMidTurn`). Optional abilities are declared, never assumed (adapter parity, `AGENTS.md`)
- holds the shared plumbing, written once:
  - rate limits per credential (Q20)
  - retries with backoff
  - idempotency keys (ADR 0011)
  - Zod validation of vendor data at the boundary
  - logs that carry IDs and never content
  - health checks

## Rules

- **A contract test suite per kind.** Every adapter must pass it, against fakes and against the test workspaces. An adapter is done when its suite is green.
- **One level of inheritance.** An adapter extends its kind's base class and never another adapter. Shared helpers are composed in, not inherited.
- **A registry.** Adapters register by kind and name. Later, each is an npm package (`@ostra/adapter-linear`) under the Apache-2.0 adapter SDK (ADR 0009), so the community can add adapters.

## Consequences

- Adding Jira, GitLab, Codex or a new sandbox provider means one new class plus a green contract suite. No core change.
- `AGENTS.md` allows classes for adapters. Everything else keeps the function style.
