# 44: Web: Home, the board view and Needs you

Status: ready-for-agent
Builder: web
Blocked by: 36, 41
Features: F-062, F-036
Packages: `apps/web` (`components/home/`, `src/app/(panel)/needs-you/` (new), the sidebar)
Spec: `../spec.md`, section 12 (`needs-you`, `home-board`; and `m1/home` growing)

## What to build

- **Home** (`m1/home`, as the target already draws it): Needs you first (amber, every reason, inline answers where the item allows), then Running, then Recent activity, across the member's projects; the setup checklist above them while setup isn't done.
- **The board view** (`home-board`): a toggle on Home, the tasks grouped by state, the project filter, the project's colour square on each card.
- **The "Needs you" page** (`needs-you`): unread first, grouped by project, inline answers, "Done" tab, mark as read on view; the sidebar's "Needs you" with its amber count, live through the change notices.
- Phone width per F-075 (`phone-approval` for answering from Needs you).

## Done when

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright: an approval raised in one project shows on Sam's Home and Needs you, is answered inline, and moves to Done; the count updates without a reload; the board groups by state.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add Home's needs you and the board`.

## Comments
