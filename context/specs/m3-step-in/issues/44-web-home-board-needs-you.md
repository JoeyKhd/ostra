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

- 2026-11-19: the board and Needs you parts are in, `92c1fb5` (`✨ add the board and Needs you parts`), on the shared `UnderlineTabs` from `20f6c8d` and sized in `7f6f3ef`: `components/home/board-words.ts` and `home-board.tsx` (the toolbar, the five columns, the cards, the phone's state picker), and `components/needs-you/` (grouping and order, the row that opens by itself, the approval, plan and question answers, the Done tab, the reach panel). Tests name F-062, F-036, F-075; break-it checks on the order, the auto-open row, the plan's eight entries, the unread dot, `N more` and the column order each failed a test. Checked by eye against `home-board` and `needs-you` at 1440 and 390 wide. Differences: the board's `Setup failed` line has no command (the overview's reason detail carries only the exit code). **Not done yet:** the route `/needs-you`, the sidebar's count, `?view=board` on Home and the Playwright run wait on ticket 36 (`home.board`, `notifications.*`) and ticket 35's answers, which aren't on `main` yet; the parts take their data as props so the wiring is the only step left.
- 2026-11-19, integrate (ticket 50): Home's Overview/Board toggle (`?view=board`), the Needs you page with its inline answers and Done tab, and the sidebar's count (`notifications.unreadCount`) are wired (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
