# 35: The panel shell

Status: done
Builder: web
Blocked by: 30
Features: F-082 (dark first), F-075 (responsive), F-083 (English text in message files), F-002 (sign-in page)
Packages: `apps/web`
Spec: `../spec.md`, sections 2 and 4

## What to build

- **Next.js 16** (App Router), **Tailwind 4**, **shadcn/ui** components installed as source, **lucide-react**, **tRPC 11** with **TanStack Query 5**, all pinned exactly. `apps/web` stays `LicenseRef-Sustainable-Use-1.0`.
- **Tokens:** `graphite.css`'s values as Tailwind 4 theme tokens (`app-design.md`'s colour table), dark first, with a light theme left for later. Fonts self-hosted from `context/brand/fonts/` (Manrope 700 for titles, IBM Plex Sans and Mono), no font CDN.
- **Layout** (`app-design.md`): the 232 px sidebar (organization switcher, Home, Needs you, My tasks, Projects, Organization), the 44 px top bar with breadcrumbs, the page, the 300 px properties panel. At phone width the sidebar becomes a drawer and the properties panel stacks below, with no horizontal scroll.
- **Text:** every string in `messages/en.json`, read through one small typed helper, so a key that's missing fails the typecheck.
- **better-auth** mounted at `/api/auth/[...all]`, tRPC at `/api/trpc/[trpc]` with SSE for subscriptions. A sign-in page (username or email, and password). Routes guard on the session.
- **Safety:** no raw HTML from agent or vendor text anywhere, safe links only, a Content Security Policy that allows no third-party origin.

## Done when

- [x] `pnpm --filter @ostra/web build` produces a production build; `pnpm dev` serves the shell at `http://localhost:3000`.
- [x] Signing in reaches an empty Home; signing out returns to sign-in.
- [x] A Playwright check (Playwright is in ADR 0007) at desktop and phone width finds no horizontal scroll and no request to another origin.
- [x] Package checks pass.
- [x] Committed as `✨ add the panel shell`.

## Comments

- 2026-11-18 (web): built in `apps/web`. Next.js 16.4.6 (Turbopack), React 19.3.1, Tailwind 4.3.5 with graphite's tokens in `src/app/globals.css`, shadcn/ui-style primitives on `radix-ui` 1.8.1 in `src/components/ui/`, lucide-react 1.73.0, tRPC 11.28.6 (the version `packages/api` pins) with TanStack Query 5.107.1, better-auth 1.7.25's client. Fonts self-hosted from `context/brand/fonts/` in `public/fonts/`. Strings in `messages/en.json` through `t()`, whose key type is the file's leaves. The CSP is set per request with a nonce in `src/proxy.ts`; its one exception is `form-action https://github.com`, for the manifest flow's form post (F-006). The composition root is `src/server/deps.ts` (adapters, the enqueue-only queue, which connects lazily so the panel doesn't wait on core, the outbox, the catalog, and the secrets key kept at `OSTRA_DATA_DIR/secrets-key` when `OSTRA_SECRETS_KEY` is unset). `pnpm --filter @ostra/web test:e2e` builds and runs Playwright on a throwaway stack (`e2e/stack.ts`: an embedded Postgres, migrated, and `next start`): first admin with a wrong and a right token, sign-in by username and by email, sign-out, at 1440×900 and Pixel 7 width, no horizontal scroll, no request to another origin. 7 passed.
- Two build notes: Next's root `"next"` types declare `NODE_ENV` a required variable of every `ProcessEnv`, which breaks the workspace's server code, so the panel imports `next/types` and Next's own build check runs on `tsconfig.next.json` without blocking (`pnpm typecheck` is the gate). And `import.meta.dirname` is undefined in a Turbopack bundle, so `packages/db/src/dev` now uses `import.meta.url` (`🐛 fix db dev paths inside a bundle`).
- Not in the sidebar yet: Needs you and My tasks, which have no router in milestone 1 (ticket 33 lists tasks per project). The projects list fills in with ticket 32's router.
