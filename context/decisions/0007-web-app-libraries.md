# The web app uses the libraries the maintainer already works with

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: adds `ai` (types only), assistant-ui, pg-boss and `ws` (Q24, Q50, ADR 0034, ADR 0036, ADR 0037), and lists `dockerode`, `@kubernetes/client-node` and `nodemailer` as pending the maintainer (ADR 0029, F-115). First answered on 2026-11-17. The maintainer chose the frontend libraries they already ship with elsewhere. Since the server is TypeScript too (ADR 0008), the server-side libraries of that stack come along.

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript in strict mode |
| UI | shadcn/ui + Tailwind 4, with lucide-react and sonner; designed through the `ui-taste` skill |
| Task page | The AI SDK's message types (`ai`, types only), rendered with assistant-ui (`@assistant-ui/react`, `@assistant-ui/react-markdown`) through its external store, fed by ostra's own event stream. Not `useChat` (ADR 0036) |
| API | tRPC v11, with TanStack Query 5 on the client |
| Database access | Prisma 7, with migrations through Prisma Migrate on Postgres (ADR 0017) |
| Background work | pg-boss, with every import of it in one package, `packages/jobs` (ADR 0037) |
| Runner protocol | `ws` and `@types/ws` for the WebSocket, and `pg` used directly for each replica's listen connection (ADR 0034) |
| Validation | Zod 4, also for environment variables and the runner protocol |
| Forms | react-hook-form + @hookform/resolvers |
| Dates | date-fns |
| Charts | EvilCharts on Recharts (usage, F-084 and F-037) |
| Drag and drop | @dnd-kit (a task board) |
| Accounts | better-auth (ADR 0003), pinned to an exact version |
| Code quality | ESLint (typescript-eslint strict-type-checked, unicorn filename-case) + Prettier with the Tailwind plugin |
| Interface text | next-intl, English only in v1, every string in message files (F-083) |
| Tests | Vitest; Playwright for flows in the browser |
| Workspace | a pnpm + Turborepo monorepo |

## Notes

- **The server's shape:** settled in ADR 0016. Next.js serves the panel, and a core service handles runners and background work.
- A library is installed when the first feature that needs it is built.
- **Added 2026-11-18:** the task page, pg-boss and `ws` rows. The maintainer asked for the AI SDK and assistant-ui (Q50). pg-boss (Q24) and the transport libraries were chosen on the maintainer's delegation, from `research/durable-execution.md` and `research/runner-transport.md`.

## Dependencies added in the 2026-11-18 rework, pending the maintainer

`AGENTS.md` says to ask before adding a dependency. The three below were chosen on the maintainer's delegation (answers 4.6) and no other ADR names them. Each is added only when its feature is built, and only after the maintainer confirms it and its license.

| Dependency | Package | For | License |
|---|---|---|---|
| `dockerode` | runner | The `docker` executor (ADR 0029, F-017) | to confirm |
| `@kubernetes/client-node` | runner | The `kubernetes` executor (ADR 0029, F-093) | Apache-2.0 per `research/elastic-sandboxes.md`; to confirm with the maintainer |
| `nodemailer` | server | Mail for invites, reset links and notifications (F-115, Q54) | to confirm |

Other dependencies from the same list are recorded in the ADR of the feature that needs them, each with its own confirmation line: `@agentclientprotocol/sdk` (ADR 0032), `@modelcontextprotocol/sdk` (ADR 0044), an S3 client (ADR 0043) and `@changesets/cli` (ADR 0045).
