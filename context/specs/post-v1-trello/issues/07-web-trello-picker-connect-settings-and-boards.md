# 07: Web: Trello in the picker, its connect steps, settings and board mapping

Status: ready-for-agent
Builder: web
Blocked by: 06; the design targets of spec section 13 (approved)
Features: F-153, F-152 (the picker), F-007 (a board's mapping)
Packages: `apps/web` (`components/trackers/tracker-words.ts`, `tracker-picker.tsx`, `trackers-view.tsx`, the connection page's Trello steps, `components/boards/*`, `components/tasks/task-ticket.tsx`, `messages/en.json`, the `/organization/trackers/<id>` route)
Spec: `../spec.md`, sections 1 and 13; ADR 0072; `brand/app-targets/m11-trackers/` (the shell this reuses)

## What to build

- **The picker:** `pickerKinds` gains `trello`; `comingSoonKinds` becomes `["notion"]`; Trello's tile is enabled, focusable, with its mark, its sub-line and its capability chips (`Boards`, `Cards`, `Webhooks`, `Markdown`; no Sub-tasks, no Agent mode, no Mentions). `F-152/c8`'s test now asserts only Notion is `Coming soon`, and Trello is a real radio option.
- **`tracker-words.ts`'s row status and words:** `rowStatus` and `failedWords` take Trello's arm (no token date: Pending says "not authorized", Failed says `Token refused`), and the kind's `Lists`/`Cards` words replace Statuses/Issues where a board or a ticket shows.
- **The connect page:** Trello's two steps on the m11 shell: step 1 the app (API key, secret, the connection's name), with the consent link; step 2 the member (the token from the URL fragment, or a pasted one) and `Check the token`'s lines (the member, its boards); each step's failures drawn in place (a refused token, a member already connected, a name taken); `Save and continue` turns the page into the settings.
- **The settings:** the mode (webhooks or polling), Replace the token, Replace the app secret, `Re-register webhooks`, Check again, Rename, Disconnect with the boards it pauses; a failed connection shows `Token refused` and its boards' pause lines link here. A member sees the same page without any admin control or secret detail.
- **A board's attach and mapping:** the attach picker groups Trello's boards under the connection; the attach form asks for the prefix (`TR`, 2–8 `[A-Z0-9]`) and shows it in the board's row; the mapping editor lists the board's lists with a category select each (prefilled with the guess), the started/in-review/done selects, a warning for a list with no category, no transition lines and no magic-word row.
- **A ticket's places:** Trello's mark in the picker, the Trackers list, the Inbox rows, the ticket chip and the task's "On Trello" group (the list each move wrote, no transitions); every copy key goes in `messages/en.json`.
- **The screens compare with the targets** at 1440 and 390 px in both themes, and the screenshots go under the ticket's `## Comments`.

## Done when

- [ ] Tests named for `F-153/c10`: Trello's tile is enabled and Notion's is the only `Coming soon`; the two steps render each failure and success state from props; the settings draw no admin control for a member and no secret for anyone; a board's mapping renders the lists' categories and the prefix; a ticket shows Trello's mark (break-it: leave Trello in `comingSoonKinds`, and the picker test fails).
- [ ] Tests named for `F-153/c5`: the attach form refuses a missing or duplicate prefix and posts it; the mapping posts and reads `statusCategories`.
- [ ] Tests named for `F-153/c1`: the consent hand-off reads the token from the fragment and never puts it in a URL, a log or a message file.
- [ ] The component tests pass for the touched components, and the screenshots match the targets at both widths and themes.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` for `apps/web` pass.
- [ ] Committed as `✨ connect Trello in the panel`.

## Comments

- Can't start before the `brand/app-targets/post-v1-trello/` set is approved (spec section 13): the connect steps, a Trello connection's settings and the board's list mapping need their pictures first (`build-order.md`, "How each milestone runs").
