# 17: Web: phone, light theme and the keyboard

Status: ready-for-agent
Builder: web
Blocked by: 10, 11, 12, 13, 14, 15, 16
Features: F-151
Packages: `apps/web` (every file of tickets 09 to 16 for its phone rules; the shortcut sheet; `apps/web/messages/en.json` and `src/task/renderers.tsx` for what nothing reads any more), new `apps/web/e2e/27-thread-phone.spec.ts`, `apps/web/e2e/a11y/` (the task page's routes)
Spec: `../spec.md`, sections 10 and 13
Targets: `context/brand/app-targets/m10-thread/s6.md` (`s6-phone`, `s6-phone-open`), `s7.md` (`s7-s1-light`, `s7-s3-light`), `parts.md` ("WCAG AA", "Keyboard and screen readers", "Reduced motion")

## What to build

Built to the approved targets, at their sizes. Each part ticket built its part in both themes; this one goes over all of them together, at the phone width, in light, and by keyboard.

- **Phone** (390 px, `s6.md`): bubbles 88% and 15px, prose 15px; a run's line wraps with its whole line the tap target (44px at least), the chevron and time after the last word; an opened run's verb inline before its subject, rows 36px at least, the footer wrapped by fact and `Event log ›` on its own line; the question's 44px choices and full-width `Send answer`; the pill in its band above the dock; the docked composer (50px box, Send 40px, the short model `Sonnet 5.5 · High ⌄`), with `Stop`, `Take it local` and `Interrupt and send` in the `…` menu (milestone 2's phone rule); no tooltip.
- **Light** (`s7.md`): every part in milestone 7's light tokens, with no colour named in a part; the WCAG table's pairs checked in both themes.
- **The keyboard:** `j` / `k` move between runs' lines and needs-you blocks (milestone 7's shortcut sheet lists them); Enter and Space toggle a run, a result that opens and the pill; the time is focusable with its tooltip; the opened run is a list and each link names its step.
- **Reduced motion:** the spinners stand still as rings, the live step's time still ticks, the chevron doesn't animate.
- **Tidy:** the old thread's rows and words that nothing reads any more (`Line`, `TurnUsage`, `task.tool.showOutput` and kin, the top-level `doing.*` keys the live step replaced) are removed; the subagents window draws its calls with ticket 10's rows.

## Done when

- [ ] Tests named for `F-151/c10`: at 390 px, a run's line wraps and its tap target is at least 44px tall; an opened run's footer holds the numbers and `Event log ›`; the time has no tooltip; the composer docks with `Interrupt and send` in its menu.
- [ ] Tests named for `F-151/c10`: `j` and `k` move the focus between runs' lines and needs-you blocks in order; with `prefers-reduced-motion`, no spinner turns.
- [ ] The keyboard walk and the contrast check pass on the task page with every part shown, in both themes (`MSYS2_ENV_CONV_EXCL=OSTRA_A11Y_ROUTES`, and the walk's count checked).
- [ ] `apps/web/e2e/27-thread-phone.spec.ts` (run once at the milestone's end) over the seeded S1.
- [ ] Screenshots at 1440 and 390 px, both themes, of every scene, compared with the targets, under `## Comments`, with each remaining difference and its reason.
- [ ] No unused key in `en.json` and no unused export in the thread's files.
- [ ] Checks for `apps/web` pass.
- [ ] Committed as `✨ fit the compact thread to phones and light`.

## Comments
