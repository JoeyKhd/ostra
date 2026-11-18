# The web app uses the libraries the maintainer already works with

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: adds `ai` (types only), assistant-ui, pg-boss and `ws` (Q24, Q50, ADR 0034, ADR 0036, ADR 0037), and lists `dockerode`, `@kubernetes/client-node` and `nodemailer` as pending the maintainer (ADR 0029, F-115). First answered on 2026-11-17. The maintainer chose the frontend libraries they already ship with elsewhere. Since the server is TypeScript too (ADR 0008), the server-side libraries of that stack come along.

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript in strict mode |
| UI | shadcn/ui + Tailwind 4, with lucide-react and sonner; designed through the `ui-taste` skill |
| Task page | The AI SDK's message types (`ai`, types only), rendered with assistant-ui (`@assistant-ui/react`, `@assistant-ui/react-markdown`) through its external store, fed by ostra's own event stream. Not `useChat` (ADR 0036) |
| API | tRPC v11, with TanStack Query 5 on the client |
| Database access | Prisma 7, with `@prisma/adapter-pg` (Prisma 7 requires a driver adapter for Postgres), and migrations through Prisma Migrate on Postgres (ADR 0017). Pinned exactly: spike 9 ran Prisma 7.10.1 |
| Background work | pg-boss, with every import of it in one package, `packages/jobs` (ADR 0037) |
| Runner protocol | `ws` and `@types/ws` for the WebSocket, and `pg` used directly for each replica's listen connection (ADR 0034) |
| Validation | Zod 4, also for environment variables and the runner protocol |
| Forms | react-hook-form + @hookform/resolvers |
| Dates | date-fns |
| Charts | EvilCharts on Recharts (usage, F-084 and F-037) |
| Drag and drop | @dnd-kit (a task board) |
| Accounts | better-auth (ADR 0003), pinned to an exact version: spike 9 ran 1.7.25. `prisma` is pinned beside it, because npm's `latest` for `prisma` is the 8 release candidate, which better-auth's adapter doesn't support |
| Code quality | ESLint (typescript-eslint strict-type-checked, unicorn filename-case) + Prettier with the Tailwind plugin |
| Interface text | next-intl, English only in v1, every string in message files (F-083) |
| Tests | Vitest; Playwright for flows in the browser |
| Workspace | a pnpm + Turborepo monorepo |

## Notes

- **The server's shape:** settled in ADR 0016. Next.js serves the panel, and a core service handles runners and background work.
- A library is installed when the first feature that needs it is built.
- **Added 2026-11-18:** the task page, pg-boss and `ws` rows. The maintainer asked for the AI SDK and assistant-ui (Q50). pg-boss (Q24) and the transport libraries were chosen on the maintainer's delegation, from `research/durable-execution.md` and `research/runner-transport.md`.

## Versions the spikes ran with

Milestone 1 starts from these and pins exactly (a version less than a day old is refused by pnpm 11's supply-chain policy, so the newest release that is at least a day old is used where a newer one exists). Each is a pin, not a promise that a later version breaks.

| Package | Ran in the spike | Note |
|---|---|---|
| `better-auth` | 1.7.25 | `beta` is already 1.8.0-beta.x. The contract test in ADR 0003 is the upgrade gate |
| `prisma`, `@prisma/client` | 7.10.1 | Not `latest`: that is the 8 release candidate |
| `@prisma/adapter-pg` | with Prisma 7 | ADR 0037 names it too |
| `@agentclientprotocol/sdk` | 2.7.0 | ADR 0032 |
| OpenCode | 2.3.2, as `@opencode/cli` | ADR 0032, ADR 0046 |
| `@linear/sdk` | 102.0.0 | 103.0.0 was published a week later and wasn't tested. Rerun the spike's `sdk-strict` check before bumping |
| `ai` and `@assistant-ui/react` | an older pair than npm's newest (7.0.176 and 0.15.37 were newer) | ADR 0036 |

## Approved by the maintainer's delegation, 2026-11-18

- **`embedded-postgres`, as a devDependency only.** Milestone 1's development runs Postgres through it, started by a dev script, because the machine has no Docker. `DATABASE_URL` overrides it. It is a beta (18.6.0-beta.19) and four spikes already use it (`auth-foundation`, `durable-queue-choice`, `runner-transport` and `live-stream-and-task-view`), and their findings ask for this approval. It never enters a production dependency list and no image ships it. The self-hosted install uses a real Postgres (ADR 0017).
- **`vite`** was used by spike 7's throwaway page only. It is not in the product: the panel is Next.js 16.
- **Vitest and Playwright** were already in the table above.

## Dependencies added in the 2026-11-18 rework, pending the maintainer

`AGENTS.md` says to ask before adding a dependency. The three below were chosen on the maintainer's delegation (answers 4.6) and no other ADR names them. Each is added only when its feature is built, and only after the maintainer confirms it and its license.

| Dependency | Package | For | License |
|---|---|---|---|
| `dockerode` | runner | The `docker` executor (ADR 0029, F-017) | to confirm |
| `@kubernetes/client-node` | runner | The `kubernetes` executor (ADR 0029, F-093) | Apache-2.0 per `research/elastic-sandboxes.md`; to confirm with the maintainer |
| `nodemailer` | server | Mail for invites, reset links and notifications (F-115, Q54) | to confirm |
| `@tanstack/react-virtual` | web | List virtualization on the task page for long tasks (ADR 0036, Q112). Until it is confirmed, paging by turn is the long-task answer | to confirm, with its license, with the maintainer |
| A way to make a Windows job object from Node | runner | Process containment on the `host` executor on Windows (ADR 0029, Q126): a native addon or a small helper program | to choose and confirm |

Other dependencies from the same list are recorded in the ADR of the feature that needs them, each with its own confirmation line: `@agentclientprotocol/sdk` (ADR 0032), `@modelcontextprotocol/sdk` (ADR 0044), an S3 client (ADR 0043) and `@changesets/cli` (ADR 0045).
