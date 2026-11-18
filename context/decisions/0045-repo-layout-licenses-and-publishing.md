# One monorepo, a license per package checked by CI, and one version line

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q78, Q79 and Q81. Builds on ADR 0007 (pnpm and Turborepo), ADR 0009 (the license split) and ADR 0016 (two server processes). The CLI and the images are ADR 0046.

## The layout

| Path | What it holds | License |
|---|---|---|
| `apps/web` | The Next.js panel, better-auth, tRPC | AGPL-3.0 |
| `apps/core` | The runner gateway, webhooks, queue workers | AGPL-3.0 |
| `apps/runner` | The `ostra` CLI: the pool runner, the sidecar, `login`, `checkout` | Apache-2.0 |
| `apps/docs` | The docs site. Built with milestone 7, in the same stack as the panel | Declared when it's created |
| `packages/db` | The Prisma schema and client | AGPL-3.0 |
| `packages/domain` | Lifecycles and use cases | AGPL-3.0 |
| `packages/api` | The tRPC routers | AGPL-3.0 |
| `packages/jobs` | The only package that imports pg-boss (ADR 0037) | AGPL-3.0 |
| `packages/task-view` | The fold from events to `UIMessage`, shared by the panel and its tests (ADR 0036) | AGPL-3.0 |
| `packages/protocol` | Zod schemas for the runner protocol, agent events and config | Apache-2.0 |
| `packages/adapter-sdk` | The eight base classes, their contract test suites and shared plumbing | Apache-2.0 |
| `packages/adapters/*` | One package per adapter | Apache-2.0 |
| `packages/tooling` | Shared TypeScript and lint config | Private, never published |

Outside the packages:
- `e2e/` runs ticket to task to PR against the test workspaces.
- `spikes/` stays outside the workspace. Spike code is throwaway, and product code never imports it.

The start is small. There's no `ui` package until a second app needs the shadcn components. `domain` is one package until that hurts.

## Enforcing the license line

ADR 0009 only holds if a machine checks it.

- **Every package declares its license** in the `license` field of its `package.json`. A package without one fails CI.
- **CI fails when an Apache-2.0 package depends on an AGPL-3.0 one,** directly or through another package. So `protocol`, `adapter-sdk`, `adapters/*` and `runner` never import `db`, `domain` or `api`.
- **The CLI talks to the server only through the schemas in `protocol`,** never through the AGPL tRPC types.
- **The shared plumbing is injected.** The base classes in `adapter-sdk` share rate budgets per credential, idempotency keys and logging (ADR 0025). That plumbing needs Postgres, and `adapter-sdk` can't import `db`. So it's written against small interfaces, such as a rate-budget store and an idempotency store. The server implements them with Postgres, and whoever else hosts an adapter supplies its own.
- **A lint rule keeps pg-boss inside `packages/jobs`.** A package boundary is the one seam a lint rule can enforce.

## Publishing

- **What's published to npm:** the `ostra` CLI, `protocol`, `adapter-sdk` and the adapters, so others can write adapters. The server packages are private. The server ships as an image (ADR 0046).
- **One version line.** Every published package carries ostra's release version. Server and runner versions are tied by ADR 0022, so one line is the simplest truth.
- **Changesets** manages versions and publishing, and is configured to bump every published package together. `@changesets/cli` is a new dev dependency, and AGENTS.md says to confirm it with the maintainer before it's added.
- **Publishing starts at the v1 launch,** in milestone 7. Publishing the adapter SDK earlier would promise a stability it doesn't have yet.
- **Names.** The maintainer registers the npm scope and the image namespace, and checks the CLI's package name. `ostra` itself is taken on npm (`build-order.md`). ADR 0046 covers that.

## Considered options

- **Separate repos for the server, the runner and the SDK.** Rejected: one protocol change would need coordinated releases across three repos. ADR 0007 already chose a monorepo.
- **Independent versions per package.** Rejected: server and runner versions are tied, so independent lines would hide the one pairing that matters.
- **Publishing the server packages as well.** Rejected: the server is an image. An AGPL package on npm adds nothing for a self-hoster.
- **Publishing before v1.** Rejected: see above.
- **A license line kept by review alone.** Rejected: a convention that nothing checks fails the first time someone is in a hurry.
- **Letting `adapter-sdk` import `db` for its plumbing.** Rejected: an Apache-2.0 package would then depend on an AGPL-3.0 one, which breaks ADR 0009.
- **Many packages from the start,** such as a `ui` package and a split `domain`. Rejected: each boundary is worth a package only when a lint rule needs the seam.

## Consequences

- A new adapter is a new package under `packages/adapters/` and a green contract suite. It needs no core change (ADR 0025).
- If the package count slows the build, `jobs` folds into `domain` behind a lint rule, and `domain` splits only when it hurts.
- An adapter that needs to release faster than the server would break the single version line. That would reopen this decision.
- `apps/web` and `apps/core` are the two processes of ADR 0016. Both import the same domain packages, and neither holds logic the other needs.
- Contributions keep the DCO sign-off of ADR 0009. Anything only the hosted version needs stays in separate services.
