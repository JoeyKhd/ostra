# The web app uses the libraries the maintainer already works with

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17. The maintainer chose the frontend libraries they already ship with elsewhere. Since the server is TypeScript too (ADR 0008), the server-side libraries of that stack come along.

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript in strict mode |
| UI | shadcn/ui + Tailwind 4, with lucide-react and sonner; designed through the `ui-taste` skill |
| API | tRPC v11, with TanStack Query 5 on the client |
| Database access | Prisma 7, with migrations through Prisma Migrate on Postgres (ADR 0017) |
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
