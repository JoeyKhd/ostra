# The web app uses the libraries the maintainer already works with

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: adds `ai` (types only), assistant-ui, pg-boss and `ws` (Q24, Q50, ADR 0034, ADR 0036, ADR 0037), and lists `dockerode`, `@kubernetes/client-node` and `nodemailer` as pending the maintainer (ADR 0029, F-115). Amended 2026-11-19: the maintainer confirmed `dockerode`, `@kubernetes/client-node` and `@tanstack/react-virtual`, and chose Resend (`resend`) as the first email option, with SMTP through `nodemailer` as the second. Amended again 2026-11-19: `koffi` is how the runner makes a Windows job object (Q126), and later that day the adapter SDK's Windows process listing too, as an optional dependency. Amended 2026-11-19 for milestone 7's spec: three entries (the docs site's Fumadocs, Changesets, and Claude Code's ACP adapter, installed at run time), at the end of this file, confirmed the same day under the maintainer's permission for the session's dependencies. **Amended again 2026-11-19:** the Claude Code entry is withdrawn, since the maintainer moved Claude Code (F-018) after v1; Fumadocs and Changesets stay confirmed. First answered on 2026-11-17. The maintainer chose the frontend libraries they already ship with elsewhere. Since the server is TypeScript too (ADR 0008), the server-side libraries of that stack come along.

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
- **`yaml`** (ISC), spike 3's dev dependency for reading its deploy files, and **`@dbos-inc/dbos-sdk`** (MIT core only, no Conductor), spike 8's fallback arm. Approved for the spikes only (Q162). Neither is a product dependency: no package outside `spikes/` lists them.

## Dependencies added in the 2026-11-18 rework

`AGENTS.md` says to ask before adding a dependency. The ones below were chosen on the maintainer's delegation (answers 4.6), and no other ADR names them. Each is added only when its feature is built, pinned exactly, in the same commit as the updated `pnpm-lock.yaml`. The maintainer confirmed them on 2026-11-19 ("rest is ok"), except the Windows job-object helper, which was chosen later that day (Q126, the last row).

| Dependency | Package | For | License |
|---|---|---|---|
| `dockerode` | runner | The `docker` executor (ADR 0029, F-017) | Apache-2.0; confirmed 2026-11-19 |
| `@kubernetes/client-node` | runner | The `kubernetes` executor (ADR 0029, F-093) | Apache-2.0; confirmed 2026-11-19 |
| `resend` | server | Email for invites, reset links and notifications (F-115, Q54), as the email channel's `NotificationAdapter` and better-auth's mail callbacks. Chosen by the maintainer on 2026-11-19 as the first email option ("resend is better and works with better-auth", "resend is priority") | MIT; confirmed 2026-11-19 |
| `nodemailer` | server | The second email option: SMTP, for installs that can't or won't use a hosted service (a company's own mail relay, an air-gapped network). Same channel, same mail; built after Resend ("add smtp as an option as well, but resend is priority") | MIT-0; confirmed 2026-11-19 |
| `@tanstack/react-virtual` | web | List virtualization on the task page for long tasks (ADR 0036, Q112) | MIT; confirmed 2026-11-19 |
| `koffi` | runner (`@ostra/adapter-executor-host`; `@ostra/adapter-sdk` as an optional dependency), loaded on Windows only | The Windows job object that ends every process of a task on the `host` executor (ADR 0029, Q126). Since 2026-11-19, also the adapter SDK's listing of a Windows machine's processes: one `NtQuerySystemInformation` call in place of a PowerShell per listing, with PowerShell as the fallback when koffi can't load (`research/host-process-containment.md`, section 6). Pinned at 3.3.8, with install scripts off: its prebuilt `@koromix/koffi-win32-x64` or `-arm64` package is enough. It replaces "a native addon or a small helper program": the code stays TypeScript, and nothing is compiled on a member's machine. Node's own `node:ffi` takes its place once the CLI's minimum Node has it out of experimental (`research/host-process-containment.md`) | MIT; chosen 2026-11-19 on the maintainer's delegation, the day the maintainer allowed new dependencies for the session |

Other dependencies from the same list are recorded in the ADR of the feature that needs them, each with its own confirmation line: `@agentclientprotocol/sdk` (ADR 0032), `@modelcontextprotocol/sdk` (ADR 0044), an S3 client (ADR 0043) and `@changesets/cli` (ADR 0045).

## Milestone 7 (2026-11-19)

Chosen on the maintainer's delegation for milestone 7's spec, and confirmed the same day by the lead under the maintainer's standing permission for that session ("for this entire session you can just install every dependency without permission"), pending the maintainer's own review. Each is added only when its ticket is built. If the maintainer withdraws one, its ticket builds the fallback in the last column. Claude Code itself stays under Anthropic's terms, and whether ostra's public images may include it is Q266, a legal reading left to the maintainer. **Withdrawn 2026-11-19:** the Claude Code row below, with F-018, which moved after v1 on the maintainer's word; Q266 waits with it. Fumadocs and Changesets stay confirmed.

| Dependency | Package | For | License | If withdrawn |
|---|---|---|---|---|
| `fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx` | `apps/docs` | The docs site (F-058, ADR 0063): MDX pages, layout, the static search index, on Next.js 16 | MIT; confirmed 2026-11-19 | The pages on Next.js alone, from Markdown through `@assistant-ui/react-markdown`, without search |
| `@changesets/cli` | the root, dev only | One version line for every published package (ADR 0045, ADR 0064) | MIT; confirmed 2026-11-19 | The release workflow bumps every published `package.json` with a small script of its own |
| `@agentclientprotocol/claude-agent-acp` 0.108.1, and through it `@anthropic-ai/claude-agent-sdk` 0.3.326 | **No `package.json`:** installed at run time by the runner, or into an agent image (ADR 0062, ADR 0046) | Claude Code over ACP (F-018) | Apache-2.0; the SDK and Claude Code under Anthropic's legal agreements; confirmed 2026-11-19, **withdrawn 2026-11-19** (F-018 is after v1) | Withdrawn: nothing in v1 installs it. The row stays for when F-018 is built, and asks for its yes again then |

No other new dependency is planned for milestone 7: the keyboard and contrast checks, the message-file check and the measure's script are ostra's own code on what's already installed.

## Milestone 9 (2026-11-21)

Chosen for milestone 9's spec (ADR 0070, `research/attachments-for-agents.md` §5) under the maintainer's permission for that session's work, pending the maintainer's own review (milestone 9's ticket 19). Each is pinned exactly, in `apps/core` only, so the runner's image doesn't grow. Added by milestone 9's ticket 07.

| Dependency | Package | For | License | If withdrawn |
|---|---|---|---|---|
| `unpdf` 2.2.1 | `apps/core` | A PDF's text layer, page by page (F-150) | MIT, no dependencies; it bundles Mozilla's pdf.js (Apache-2.0) | `pdfjs-dist` 6.5.438 (Apache-2.0) directly, its legacy build |
| `fflate` 0.8.3 | `apps/core` | Reading an Office file's zip part by part, with each part's declared size checked first (F-150) | MIT, no dependencies | Node's `zlib` with ostra's own reader of a zip's central directory |
| `@xmldom/xmldom` 0.9.12 | `apps/core` | Parsing an Office part's XML (F-150) | MIT, no dependencies | A small tokenizer of ostra's own for the few elements read |

Considered and not added: `mammoth` (its `jszip` is `(MIT OR GPL-3.0-or-later)`, which the images' notices check refuses), `officeparser` (an OCR engine that fetches its data at run time) and `pdf-parse` (a native module).
