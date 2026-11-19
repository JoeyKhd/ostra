# Target: the device approval screen (milestone 1)

> **Committed image:** `device.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

- **Image:** `device.webp`, 2048×1360 (3:2). It's a 1440×960 layout drawn at about 1.42×, so divide a measurement by 1.42 to get CSS px. Where the image and this file disagree, this file wins.
- **Prompt:** `device.prompt.txt`. GPT Image 2.6 through Higgsfield, 2 generations; the second one is the target. The references were `app-concepts/html/task-b-graphite.png`, `home-graphite.png` (first generation only), `kit/logo/export/ostra-hinge-single-color-2048.png`, and the first generation itself (second generation).
- **Route:** `apps/web/src/app/(panel)/device/page.tsx` → `components/runners/device-approval.tsx`.
- **Features:** F-014 (personal runner: device-code sign-in, "personal, not isolated"), ADR 0029, ticket 30 (the device approval).
- **Status:** a proposed target. It isn't approved by the maintainer yet (`app-design.md`).

> app-design.md rule 5 says concepts are built as real HTML, not image-model mockups. This image is a visual target for the build, not a concept to approve as-is. Build it in real HTML/React with the real fonts, then screenshot the build at 1440×960 and compare it with the image.

## Purpose

A member ran `ostra runner` on their own machine. It printed a code and the panel's `/device` address. On this page the member either types that code or arrives with it already filled in (`/device?user_code=…`), checks that the code on screen is the one in their terminal, sees what is asking and what approving grants, then approves or denies.

It's a security decision, so the page reads top to bottom in the order the member has to think: **is this my code → what does approving do → decide**. Nothing is a modal and nothing is hurried. The one amber thing on the page is the decision itself, the same "needs you · approval" block as an agent's approval on the task screen (`task-b-graphite`), so the member recognises "ostra wants me to approve something".

## Layout (CSS px at 1440×960)

The usual panel shell: the 232px sidebar, the 44px top bar, the main column and the 300px properties panel (`PageFrame` with `properties`).

- **Sidebar:** unchanged; the Runner pools row is selected (`#1A1B1E`). It's the page this flow belongs to.
- **Top bar:** breadcrumbs `Acme Corp › Runner pools › Approve a runner`; the last crumb is text (`#EDEDEE`, 500), the others muted links. No actions on the right.
- **Main column:** padding 28px 40px. Content is left-aligned in a column of **max 640px** (the image draws it about 700px; keep it narrower so the hairlines stop well short of the properties panel). Below the content the column stays empty; don't fill it.

### Main column, top to bottom (confirm state, the image)

| Element | Spec |
|---|---|
| Eyebrow | `ostra runner · device sign-in`. IBM Plex Mono 500 12px, `#64676D` (`.key`). The `PageHeading` `eyebrow` slot. |
| Title | `Approve a runner`. Manrope 700 24px/1.25, letter-spacing -0.015em, margin 6px 0. |
| Lede | `Check that this code matches the one in your terminal.` 13.5px `#9A9DA3`. |
| Code label | `Code`. 12px 500 `#9A9DA3`, margin-top 22px, 6px above the box (`.field label`). |
| Code box | Full column width, 64px tall, `#131416` fill, 1px `#1F2023` border, 8px radius, padding 0 20px, flex row, centered vertically. Left: the code, IBM Plex Mono 500 28px, `#EDEDEE`, letter-spacing 0.18em, formatted `XXXX-XXXX` (8 characters, `userCodeLength: 8`). Right, `margin-left: auto`: `expires in 8:41`, IBM Plex Mono 12.5px `#64676D`, a live `m:ss` countdown, `tabular-nums`. The code is selectable text. |
| Section | margin-top 26px. Title line `What approving does` (`.shead h2`, Plex Sans 600 13px), then three rows (`.rows > .r`, min-height 38px, hairlines `#1F2023` above each and below the last). Each row: a Lucide icon 15px/1.75 in `#9A9DA3`, 12px gap, 13px `#EDEDEE` text. |
| Row 1 | `server` icon. `It becomes your personal runner in Acme Corp.` (the active organization's name). |
| Row 2 | `user` icon. `It runs only the tasks you send to it.` |
| Row 3 | `shield-off` icon. `Personal, not isolated: the agent runs as a process on that machine, as you.` Neutral text, **not amber** (amber means "needs you" only). |
| Approval | margin-top 24px. A 2px `#FFB224` left rule (`border-l-2 border-amber`), padding-left 16px, no fill, no box. Line 1: Lucide `hand` 15px + `Needs you · approval`, Plex Sans 600 13px `#FFB224`. Line 2 (margin-top 4px): `Approve only if you ran ostra runner yourself, just now. If you didn't, deny it.` 13px `#EDEDEE`; `ostra runner` in Plex Mono 12.5px. Buttons (margin-top 12px, 8px gap): `Deny` (`Button variant="default"`, 28px) then `Approve runner` (`Button variant="amber"`). Same order as the task screen's approval: deny first, approve last. |

### Properties panel (300px, padding 20px 18px)

`PropGroup` titles are 11px 500 `#64676D`; `PropRow` is an 84px key column (`#9A9DA3`) and a value (`#EDEDEE`), 30px rows, 12.5px. Groups are separated by a 1px `#1F2023` rule with 14px above and below. Values all start at the same x.

| Group | Key | Value (demo) | Source today |
|---|---|---|---|
| Request | Status | amber dot + `Waiting for you` (`Status tone="amber"`) | `status: "pending"` |
| | Client | `ostra runner 0.1.0` (sans; the version in mono) | `client_id` gives `ostra runner`; the version isn't sent (see below) |
| | Scope | `runner` (mono) | `scope` |
| | Requested | `14:02 · 1 min ago` (mono) | not returned (see below) |
| | Expires | `14:12` (mono; absolute, the code box has the countdown) | not returned (see below) |
| Machine | Hostname | `alex-mbp` (mono) | **not sent today** |
| | System | `macOS 15.1 · arm64` | **not sent today** |
| | Address | `192.0.2.14` (mono; the IP the code request came from) | **not stored today** |
| | Executor | `host` (mono) | known: a personal runner is always `host` (F-014) |
| Signs in as | Member | 18px avatar `AK` + `Alex Kim` | the session |
| | Organization | `Acme Corp` | the session's active organization |
| | Pool | `Personal` | check against ADR 0029; drop the row if personal runners aren't a pool |

**The Machine group is the "which machine is asking" part, and the server doesn't have that data yet.** better-auth's `/device/code` takes only `client_id` and `scope`, and `GET /device` returns `user_code`, `status`, `client_id` and `scope` (the last two only once the signed-in member owns the request). It stores `expiresAt` but doesn't return it. better-auth 1.7's `deviceAuthorization({ grant })` option has `requestSchemaFields` (extra request fields) and `getVerificationContext` (extra fields in the owner-only verify response), which looks like the route for hostname, OS, arch, runner version, request IP, created-at and expires-at. That's a server and runner-protocol change: settle it with the maintainer (add it to `context/open-questions.md`) before building it. **Until then, build the Machine group with only the rows that have data (Executor), and hide Requested and Expires rather than showing invented values.** A hostname is the runner's own claim, so the page must never present it as verified; it's a hint for the member, the code match is the check.

## States and copy

`Step` stays a discriminated union; add the states below. Copy keys are under `device.*` in `apps/web/messages/en.json`. Existing keys keep their text unless marked **new** or **changed**.

1. **Enter** (no `user_code` in the URL, or the member chose "Use a different code").
   - Eyebrow, title as above. Lede: `Enter the code ostra runner printed on your machine.` (`device.lede`, existing).
   - `Field`: label `Code`, an `Input` 40px tall, Plex Mono 20px, letter-spacing 0.2em, uppercase as typed, placeholder `ABCD-EFGH`, `autoFocus`, `autoComplete="off"`, `spellCheck={false}`, max width 320px. Help: `Letters and digits. The dash doesn't matter.`
   - Button `Continue` (`variant="primary"`, the page's one Shell button), disabled while the normalized code is empty.
   - No "What approving does" section and no approval block yet. Properties panel: only the "Signs in as" group.
2. **Checking** (after Continue, or on load with `?user_code`): the button reads `Checking…` and is disabled. With `?user_code`, show the confirm layout with the code box filled and the rest of the column as a 2-line skeleton for at most one request; don't flash the enter form.
3. **Code not found:** under the input, `#E5675C` 12px with a `circle-alert` 13px icon: `That code isn't known, or it expired. Run ostra runner again for a new one.` (`device.unknownCode`). Focus returns to the input.
4. **Code already used:** same place: `That code was already used.` (`device.notPending`).
5. **Confirm** (the image). Lede **changed** for this step: `Check that this code matches the one in your terminal.` (**new** `device.ledeConfirm`). Under the code box, a `Button variant="link"` 12px: `Use a different code` (**new**), back to Enter.
6. **Deciding:** both buttons disabled; the pressed one reads `Approving…` or `Denying…` (**new**).
7. **Decision failed:** inside the approval block, under the buttons, `#E5675C` 12px with `circle-alert`: `That didn't work. The code may have expired.` (`device.failed`).
8. **Expired** (the countdown reaches 0 while on Confirm; needs `expiresAt`): the code box text goes `#64676D` and its right side reads `expired`. The approval block is replaced by a neutral row (no amber, no rule): `circle-x` icon `#9A9DA3` + `This code expired. Run ostra runner again for a new one.` (**new** `device.expired`). Status → grey dot `Expired`.
9. **Approved:** the approval block is replaced by a row with no rule: `circle-check` `#4FB286` + `Approved. The runner finishes signing in on its own, then shows on the Runner pools page.` (**changed**: "Runners" → "Runner pools", to match the sidebar), then a teal `Button variant="link"`: `Open Runner pools →`. Status → green dot `Approved`. The "What approving does" section stays, so the member keeps the record of what they agreed to.
10. **Denied:** `circle-x` `#9A9DA3` + `Denied. The runner can't sign in with that code.` (`device.denied`). Status → grey dot `Denied`. Link: `Back to Runner pools`.

**New or changed keys:** `device.eyebrow` = `ostra runner · device sign-in`; `device.ledeConfirm`; `device.does` = `What approving does`; `device.doesPersonal` = `It becomes your personal runner in {organization}.`; `device.doesOwnTasks` = `It runs only the tasks you send to it.`; `device.notIsolated` (changed) = `Personal, not isolated: the agent runs as a process on that machine, as you.`; `device.needsYou` = `Needs you · approval`; `device.approveOnly` = `Approve only if you ran {command} yourself, just now. If you didn't, deny it.`; `device.approve` (changed) = `Approve runner`; `device.approving` = `Approving…`; `device.denying` = `Denying…`; `device.checking` = `Checking…`; `device.otherCode` = `Use a different code`; `device.expiresIn` = `expires in {time}`; `device.expired`; `device.approved` (changed); `device.openRunners` = `Open Runner pools`; `device.backToRunners` = `Back to Runner pools`; property labels `Request`, `Status`, `Client`, `Scope`, `Requested`, `Expires`, `Machine`, `Hostname`, `System`, `Address`, `Executor`, `Signs in as`, `Member`, `Organization`, `Pool`; statuses `Waiting for you`, `Approved`, `Denied`, `Expired`.

**Accessibility:** the countdown is not announced every second (`aria-live="off"`); announce once at 1 minute left and at expiry. Each state change moves focus to its first actionable element (Enter → input, Confirm → `Deny`, never `Approve runner`, so a stray Enter key can't approve). Errors use `role="alert"`, outcomes `role="status"`. The status dots always carry their label.

## Components (shadcn/ui names)

- `Input`, `Label`, `Button` (`primary` for Continue, `default` for Deny, `amber` for Approve runner, `link` for the small links): `components/ui/`.
- `Separator` for the hairlines between property groups (or the existing `.sep` utility).
- `Skeleton` for the checking state (not in `components/ui/` yet; it's a copy-in shadcn file, not a new dependency).
- `Field` (ostra's own label + control + help/error), `Status` (dot + label), `Code` from `components/ui/status.tsx`.
- `PageFrame` with `properties`, `PageHeading` with `eyebrow` and `lede`, `Section`, `PropGroup`, `PropRow` from `components/shell/page-frame.tsx`.
- The approval block: the same markup as the task page's needs-you block (`components/tasks/task-view.tsx`, `border-l-2 border-amber pl-3`). Extract it into one shared `NeedsYou` component rather than writing a third copy. Not shadcn `Alert` (that's a box; app-design rule 3 says an approval is a rule, not a card).
- Not `InputOTP`: it would be a new dependency (`input-otp`), and one plain mono input already accepts pasted codes with or without the dash.
- Icons, Lucide 15px stroke 1.75: `server`, `user`, `shield-off`, `hand`, `circle-alert`, `circle-check`, `circle-x`.

## Tokens (from `app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page background |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | code box, input, Deny button |
| `--sel` | `#1A1B1E` | the selected Runner pools nav row |
| `--line` | `#1F2023` | hairlines, code box border, panel borders |
| `--line-2` | `#2A2C30` | input and button borders |
| `--text` | `#EDEDEE` | body text, the code, property values |
| `--muted` | `#9A9DA3` | lede, labels, row icons, property keys |
| `--faint` | `#64676D` | eyebrow, countdown, group titles |
| `--amber` | `#FFB224` | the approval rule, its title and icon, Approve runner, the Waiting status dot. Nothing else. |
| `--ink` | `#0C1D21` | text on amber and on Shell |
| `--shell` | `#F3F0E8` | the Continue button (Enter state only) |
| `--green` | `#4FB286` | Approved |
| `--red` | `#E5675C` | errors |
| `--teal` | `#6FB8AA` | the links (`Use a different code`, `Open Runner pools`) |

Type: Manrope 700 24px (title); IBM Plex Sans 400 13px body, 500 for buttons and nav, 600 for section titles; IBM Plex Mono for the code, eyebrow, times, scope, hostname, IP, executor. Radius: 8px boxes, 7px buttons and inputs.

## Wrong in the image (use the copy and specs above, not the pixels)

- **Fonts.** The image model drew a generic grotesque (SF/Inter-like) for both the title and the body, not Manrope 700 and IBM Plex Sans. Build with the real fonts.
- **Scale.** Everything is drawn larger and looser than the concepts: the sidebar is about 255 CSS px instead of 232, the properties panel about 380 instead of 300, the title and rows look bigger than 24px and 13px. Use the specs above.
- **Main column width.** About 700 CSS px; use max 640px.
- `macos 15.1` should read `macOS 15.1`.
- The Client value `ostra runner 0.1.0` is partly mono in the image; it's sans with only the version in mono.
- Property group titles (`Request`, `Machine`, `Signs in as`) are drawn semibold and grey; they're 11px 500 `#64676D`.
- The breadcrumb text is drawn at about 16px; it's 13px.
- The image shows only the Confirm state. Every other state is in "States and copy" above.
- The Machine values, Requested, Expires and Pool are demo data. See the Properties panel section for what the server can supply today.

## Differences from the current code

`device-approval.tsx` today, against this target:

1. **No properties panel.** Today it's a bare 440px column. Add `PageFrame properties` with the Request, Machine and Signs in as groups.
2. **No eyebrow, no "What approving does".** Today one paragraph (`device.confirmBody`) carries everything; the target splits it into three scannable rows, and `device.confirmBody` goes away.
3. **"Not isolated" is amber text today.** Amber means "needs you" only; the target makes it a neutral row with a `shield-off` icon.
4. **The approval isn't marked as one.** Today: a plain `primary` Approve button beside Deny. Target: the amber-rule needs-you block, Deny first, `Approve runner` in amber, and the "if you didn't, deny it" line.
5. **The code is a small mono line between two hairlines with a server icon.** Target: a 64px code box with the code at 28px and a live countdown, so comparing it with the terminal is easy.
6. **`?user_code` still needs a Continue click.** Target: check it on load and land on Confirm, with `Use a different code` to go back.
7. **Busy states have no words.** Target: `Checking…`, `Approving…`, `Denying…`.
8. **No Expired state.** Target: one, once `expiresAt` is returned.
9. **The outcome is a single coloured line.** Target: an outcome row that keeps "What approving does" above it, a Status update in the panel and a link back to Runner pools. "Runners page" → "Runner pools page".
10. **Errors are bare text.** Target: an icon, and `role="alert"`.
11. **Focus.** Today nothing moves focus on step changes. Target: as in Accessibility above (Confirm focuses Deny).
12. **Crumbs.** Today `Runners › Approve a runner`; target `Acme Corp › Runner pools › Approve a runner` (match whatever label the runners target settles on).
13. **Server data** (hostname, OS, arch, runner version, request IP, requested-at, expires-at) isn't available yet. It needs a decision before it's built; see the Properties panel section.
