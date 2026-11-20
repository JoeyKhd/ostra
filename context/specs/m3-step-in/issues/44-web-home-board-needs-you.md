# 44: Web: Home, the board view and Needs you

Status: resolved
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

- [x] The screens match their targets, checked by eye, with the differences recorded here. (2026-11-20, the wired pages at 1440 wide from the Playwright run's frames, against `home-board` and `needs-you`; the parts were checked at 1440 and 390 on 2026-11-19, and `phone/sweep.spec.ts` answers from Needs you at 390. Differences in the Comments.)
- [x] Playwright: an approval raised in one project shows on Sam's Home and Needs you, is answered inline, and moves to Done; the count updates without a reload; the board groups by state. (`apps/web/e2e/21-needs-you.spec.ts`, two cases, seeded by `seed-needs-you-world.ts`; break-its in `context/proof/F-062.md`.)
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web` (and for `domain` and `core`, which this close touched).
- [x] Committed as `✨ add Home's needs you and the board`. (The work landed as `92c1fb5` (`✨ add the board and Needs you parts`) and `3af06b0` (`✨ wire milestone 3's screens to the API`), then `b5277118` and `f9079cdd`; its proof is `✅ prove Home's needs you and the board`.)

## Comments

- 2026-11-19: the board and Needs you parts are in, `92c1fb5` (`✨ add the board and Needs you parts`), on the shared `UnderlineTabs` from `20f6c8d` and sized in `7f6f3ef`: `components/home/board-words.ts` and `home-board.tsx` (the toolbar, the five columns, the cards, the phone's state picker), and `components/needs-you/` (grouping and order, the row that opens by itself, the approval, plan and question answers, the Done tab, the reach panel). Tests name F-062, F-036, F-075; break-it checks on the order, the auto-open row, the plan's eight entries, the unread dot, `N more` and the column order each failed a test. Checked by eye against `home-board` and `needs-you` at 1440 and 390 wide. Differences: the board's `Setup failed` line has no command (the overview's reason detail carries only the exit code). **Not done yet:** the route `/needs-you`, the sidebar's count, `?view=board` on Home and the Playwright run wait on ticket 36 (`home.board`, `notifications.*`) and ticket 35's answers, which aren't on `main` yet; the parts take their data as props so the wiring is the only step left.
- 2026-11-19, integrate (ticket 50): Home's Overview/Board toggle (`?view=board`), the Needs you page with its inline answers and Done tab, and the sidebar's count (`notifications.unreadCount`) are wired (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
- 2026-11-20, close: every box holds, `Status: resolved`. Commits: `92c1fb5` and `3af06b0` (the screens), `b5277118` and `f9079cdd` (one rule for what waits), and `✅ prove Home's needs you and the board` (this ticket's Playwright cases and proof rows). The cases: Sam, a member who isn't an admin, sees an approval the admin's task raised in one of two projects on Home and on Needs you, approves it inline, and finds it under Done with "Approved once by"; the sidebar's count rises when a new approval is raised in the other project and falls when Sam answers, with no reload; the board, from Home's toggle and filtered to one project, shows each task in the column of its state and none in the others. One break-it pass: the count without its refetch, `merged` tasks in In review; each failed its case. `context/proof/F-062.md` c1 and c3 are `proved`; c2 stays `partial` (the amber and the order of Home's sections are checked by eye). F-062 and F-036 stay `building` for milestone 6's audiences.
- 2026-11-20, a later decision changed a box's words: "the count, live through the change notices" is now the sidebar's `notifications.openCount` (`b5277118`, replacing `unreadCount`): everything that waits on the member by Home's rule, so the badge counts open items, read or not, and equals Home's total and the Open tab's count. It is kept fresh by a 10-second refetch in the sidebar and the shell, not by change notices; the case waits up to 25 s for it.
- 2026-11-20, differences from the targets, by eye: the board sits beside Home's right panel (pull requests, spend, runners), so its five columns are narrower than in `home-board`, which draws the board full width with no panel; the Needs you page has no "Mark all as read" (rows are marked read on view, as this ticket asks); the sidebar's Needs you has a bell, not a hand, and there's no "My tasks" row; the board's `Setup failed` line has no command (2026-11-19). Of `../demo.md`'s differences, only Home's spend figure (priced at the catalog, where the task prices at the key proxy) concerns these screens, and it stays as recorded there.
