# Target: member invite (milestone 4, screen 2)

> **Committed images:** `member-invite.webp` (the form) and `member-invite-link.webp` (the link, shown once), each downscaled from its 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompts:** `member-invite.prompt.txt` and `member-invite-link.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each; the link picture edits the form picture's sheet. References: `app-targets/m1/project-new.png` (the screen this one starts from, spec section 12: its fields, radio rows, checkbox rows and footer), the `members` generation (the page behind), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. The page behind the sheet was dimmed afterwards by a script (×0.6 left of the sheet's edge), since the generation drew only a light overlay.
- **Route:** none of its own. A `Sheet` on `/organization/members`, opened by the top bar's **Invite** (`members.md`). `?invite=1` opens it, so a link can too.
- **Features:** F-002 (invitations), F-087 (the restricted projects it grants), F-115 (the invitation mail). Spec section 12, screen 2. Ticket 22 (`members.invite`), ticket 32 (this sheet).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 in both states and compare each with its picture.

## Purpose

An organization admin invites one person: an address, the organization role, and, optionally, the restricted projects they join with a role in each. ostra makes an invitation whose link is its ID (ADR 0053), shows that link once, and mails it when email is set up. The sheet then says plainly what to do with the link, because the link is the secret: anyone holding it can join as this person.

The pictures show Alex Kim inviting `jordan@acme.dev` as a member with `vault` (restricted) as a project member, on an install with email set up: first the form, then the link.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| The page behind | the Members page | dimmed by the sheet's overlay, `bg-black/60` (`ui/sheet.tsx`, as today), and inert |
| Sheet | **450px** (the picture's; a form with a project list and role selects needs more than the 380px form panel), full height, from the right, `--bg`, 1px `--line-2` on its left, no radius | padding `24px 28px`. A body that scrolls, and a footer pinned to the bottom with a 1px `--line` above it |

Inside the sheet, top to bottom, one left edge for everything:
- **Header:** the title, Manrope 700 19px, and the close `X` (Lucide `x` 16px `--faint`, a 28px ghost button) at the top right. Under the title, 6px, a 14px `--muted` line.
- **Fields** 20px apart. Labels Plex Sans 500 13px `--muted`, 8px above their control. Controls 34px, `--surface`, 1px `--line-2`, radius 7px.

### State 1: the form (`member-invite.webp`)

1. Title `Invite to {organization}`. Line: `They join through a link that works once and expires in 7 days.`
2. **Address.** `Input type="email"`, the sheet's full width, Plex Mono 14px, autofocused, required. `autocomplete="off"`.
3. **Role in {organization}.** A `RadioGroup` as two rows with a hairline between them, each 52px: the radio (Shell fill with an Abyss dot when selected), the role in `--text` 14px, and under it 12.5px `--faint`:
   - `Member` (default): `Starts, drives and reopens tasks in the projects they can open.`
   - `Admin`: `Every project, plus models, runners, budgets and who belongs.`
   - No other role is offered; the server refuses anything else (`owner` included, ADR 0053).
4. **Restricted projects** (section head, Plex Sans 600 14px) and `optional` in 12.5px `--faint`. Under it, 13px `--muted`: `Open projects need no grant: every member opens them.`
   - Then the organization's **restricted** projects only, as 44px rows with hairlines above and below, no box: a 14px `Checkbox` (Shell fill and an Abyss tick when checked), the project's 8px colour square, its name in `--text`, Lucide `lock` 13px `--faint`, and at the right a 30px `Select`, about 140px: `Member` or `Project admin`. A checked row has the `--sel` fill. An unchecked row's `Select` is disabled at 50% and keeps `Member`.
   - The list scrolls inside the sheet's body past 8 rows.
   - **With `Admin` picked,** the list goes, and one `--muted` line stays: `Admins open every project.` Picking `Member` again brings the list back as it was.
   - **No restricted project:** one `--faint` line in place of the list: `{organization} has no restricted project, so there's nothing to grant.`
5. **Footer**, pinned: first a 13px `--muted` line with Lucide `mail` 14px:
   - email set up: `ostra mails the link to this address too.`
   - email off: `Mail is off on this install: you send the link yourself.`
   Then 14px below, the sheet's one primary `Create invitation` (34px, Shell fill, Abyss text, 600) and a secondary `Cancel` (1px `--line-2`, `--text`).

### State 2: the link, shown once (`member-invite-link.webp`)

`members.invite` returns the link once (ticket 22). The sheet swaps its body for this; nothing re-fetches it.

1. Title `Invitation created`. Line, 14px `--muted`: `{address} joins {organization} as a member.` (`as an admin.`), the address in Plex Mono `--text`.
2. **Invitation link** (the field label). A code box (`Code`: `--surface`, 1px `--line-2`, radius 8px, padding `10px 14px`), the sheet's full width, holding the **full** link in Plex Mono 13px `--text`, wrapping (`break-all`), selectable: `{OSTRA_PUBLIC_URL}/invite/{invitationId}`. Under it, 8px, a teal link button with Lucide `copy` 14px: `Copy link` (`Copied` with `check` for 1.5s). Copying writes to the clipboard only; the link is never logged.
3. 14px below, 13px `--muted` with Lucide `shield` 14px: `Send it privately: anyone with this link can join as this person.` (ADR 0053's line, word for word.)
4. 8px below, 12.5px `--faint`: `Shown once. It works once and expires on {date}.` (`26 Nov`).
5. A hairline, then the mail row, 14px:
   - email set up: Lucide `circle-check` 16px `--green`, then `Mailed to {address}` in `--text`, the address in Plex Mono. It means the mail is queued: `account-mail.send` is enqueued in the invitation's transaction (ticket 22). A send that later fails is retried by the queue and isn't reported in this sheet.
   - email off: Lucide `info` 16px `--faint`, then `Mail is off on this install. Send the link yourself.` in `--muted`.
6. A hairline, then the **Invitation** group (12px 500 `--faint` label), `PropRow`s 30px with a 96px key column: `Role` · `Member`; `Projects` · the 8px square, `vault`, Lucide `lock` 12px `--faint`, then ` · Member` in `--muted` (one line per project; `Open projects` for none; `All projects` for an admin); `Expires` · `26 Nov`; `Invited by` · the viewer's name.
7. **Footer**, pinned: primary `Done` (closes the sheet) and secondary `Invite another` (back to state 1, empty, with the same role and no projects picked).

Closing the sheet any way (`Done`, `X`, Escape, the overlay) drops the link from the sheet. The Members page keeps `Copy link` on that invitation's row until it reloads (`members.md`), and no longer.

## States and copy

| State | What changes |
|---|---|
| Open (state 1, the picture) | the form, the address focused |
| Address empty or not an address | on submit: under the field, 13px `--red`, `role="alert"`: `Enter an address.` / `That doesn't look like an address.`; the field gets a `--red` border. Nothing is sent |
| Already a member | from the server: `{address} is already a member of {organization}.` under the field |
| An invitation already waiting for the address | from the server, if `members.invite` refuses it: `An invitation for {address} is waiting. Revoke it on the list to send a new one.` |
| A removed member's address | allowed: they get a new membership (ADR 0053). No warning |
| Creating | `Create invitation` reads `Creating…` with a 14px spinning `loader-circle`; every control disabled; the sheet can't be closed by the overlay |
| Create failed (other) | one `--red` line above the footer's buttons, `role="alert"`, from `errorText()`; the form keeps its values |
| Created, email set up (state 2, the picture) | as above, `Mailed to …` |
| Created, email off | as above, `Mail is off on this install. Send the link yourself.`; the form's footer line said so before |
| Copied | `Copy link` → `Copied` 1.5s, then back |
| A member (not an admin) | never sees `Invite`; `?invite=1` does nothing for them. The server refuses with `FORBIDDEN` anyway (spec section 3, step 2) |
| Phone (F-075) | the sheet takes the full width (`side="right"`, `w-full`), the footer stays pinned above the safe area, and the selects stay at the row's right |

## Components (shadcn/ui names)

`Sheet` / `SheetContent` (existing `ui/sheet.tsx`, `side="right"`, with a `className` for the 450px width and the pinned footer), `Field` / `Label` / `Input` (existing), `RadioGroup` / `RadioGroupItem` (existing), `Checkbox` (existing), `Select` (existing), `Button` (default = Shell primary; secondary; link for `Copy link`), the existing `Code` box, `PropRow`, `Separator`. Lucide 15px, stroke 1.75: `x`, `mail`, `lock`, `copy`, `check`, `shield`, `circle-check`, `info`, `loader-circle`, `chevron-down`.

## Tokens

At the approved pictures' scale (`../m1/README.md`, "Scale"; the colours `app-design.md` lists).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | the sheet |
| `--surface` | `#131416` | inputs, selects, the link's code box |
| `--sel` | `#1A1B1E` | a checked project row |
| `--line` | `#1F2023` | row hairlines, the footer's rule, group lines |
| `--line-2` | `#2A2C30` | the sheet's left edge, control borders, the secondary buttons |
| `--text` | `#F2F3F4` | values, names, the link |
| `--muted` | `#B4B7BB` | labels, lines under titles, the footer line, the privacy line |
| `--faint` | `#8B8E93` | descriptions under the roles, `optional`, locks, "Shown once…", group labels |
| `--green` | `#4FB286` | the `Mailed to` check only |
| `--teal` | `#6FB8AA` | `Copy link` |
| `--red` | `#E5675C` | field errors |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Create invitation`, `Done`, checked checkboxes, the selected radio |
| `--amber` | `#FFB224` | nowhere in the sheet. The page behind keeps its Needs you count, dimmed |

Type: Manrope 700 19px (the sheet's title); IBM Plex Sans 14px controls and rows, 13px lines and labels, 12.5px descriptions; IBM Plex Mono for the address and the link.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **Nothing exists:** no invite sheet, no `members.invite`. Sign-up is refused outright ("invitations come in a later release", `packages/api/src/auth/create-auth.ts`); ticket 22 replaces that with the invitation hook.
2. **`ui/sheet.tsx`** has the overlay (`bg-black/60`) and a right side; it has no pinned footer slot and a fixed width. Add both as props or classes; keep the overlay.
3. **The project list** reuses the look of `new-project-view.tsx`'s repo rows (checkbox rows on hairlines), with a `Select` added at the right.
4. **Messages.** New keys under `members.invite.*` in `messages/en.json`.

## Wrong in the image

Build the copy and details in this file, not these:

- **Form:** the first word of each role's description (`Starts,`, `Every`) is drawn smaller than the rest. The whole line is one 12.5px size.
- **Form:** the page behind already lists `jordan@acme.dev` under Invitations. Before `Create invitation` it isn't there; it appears once created.
- **Form:** the overlay was darkened by script. Build `bg-black/60`, as `ui/sheet.tsx` has today.
- **Form:** the unchecked `billing-platform` row's `Select` is drawn at full strength. Disabled, at 50%, until its checkbox is on.
- **Link:** the lock icon sits after `Member` in the Projects row. It goes right after `vault`.
- **Link:** the line under the title sits almost against it. 6px, as in the form.
- The sidebar behind is the members picture's, and is built from the shell, whatever it shows.

All visible copy in both images is spelled right.
