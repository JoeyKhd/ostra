# 35: The panel shell

Status: ready-for-agent
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

- [ ] `pnpm --filter @ostra/web build` produces a production build; `pnpm dev` serves the shell at `http://localhost:3000`.
- [ ] Signing in reaches an empty Home; signing out returns to sign-in.
- [ ] A Playwright check (Playwright is in ADR 0007) at desktop and phone width finds no horizontal scroll and no request to another origin.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the panel shell`.

## Comments
