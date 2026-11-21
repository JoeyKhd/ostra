# Target: suggestions to the library, a member's and the admins' (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. Both render from `html/library-suggestions.html` (`?view=member` for the second), with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `library-suggestions.webp` | Alex Kim, an org admin, on Organization › Skills and MCP › Suggestions. Three open suggestions; Sam Rivera's `globex/agent-skills@db-seeding` is selected: Sam's note on the left, what ostra found at the source on the right (the commit, the files, two scripts, the hash, and the source not on the allowlist). `Install…` and `Dismiss`, with Dismiss's popover open on an optional reason for Sam. The properties panel: the suggestion, who decides, this month's counts. |
| `library-suggest-form.webp` | Sam Rivera, a member and not an admin, on the read-only library with `Suggest a skill or server` open: the same reference looked up, the allowlist line, Sam's note, and their three past suggestions with each answer (open, installed, dismissed with Priya Shah's reason). The Organization panel shows a member's rows only. |

- **Routes:** the admins' list is new, `apps/web/src/app/(panel)/organization/skills/suggestions/page.tsx`, `?tab=open|decided&suggestion={id}`. The member's form is a right `Sheet` over the library (`organization/skills?suggest=1`).
- **Shell:** the double sidebar (`app-shell.md`): the rail's **Org** space, the Organization panel's **Skills and MCP** row selected. A member's panel has only a member's rows (`app-shell.md`, "A member, not an admin").
- **Features:** F-145 (the skills and MCP library: "Members see the library and suggest items, and only organization admins install"), ADR 0069 ("Installing": "Organization admins install. Members suggest"). The milestone 8 spec names this target in section 13 (target 13, `library-suggestions`), starting from `../m4/memory-proposals`.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

Only org admins install, so a member who finds a useful skill or server needs a way to ask, and an answer. Devin's "Suggest MCP Integration" is the precedent (ADR 0069). The two screens have to make plain:
1. **For the member:** what they're suggesting resolves to something real, whether its source is allowed, and what happened to what they asked before.
2. **For the admin:** who asked and why, what the reference holds today (commit, files, scripts, hash, allowlist), and two clear answers: install it (through the one install flow, `library-install.md`) or dismiss it with a reason the member sees.

A suggestion is an admin chore, never "needs you": its count is plain, never amber (`library.md`, Purpose 3).

## Layout: the admins' list (`library-suggestions.webp`)

The page column is 1136: the page `minmax(0, 1fr)` and the properties panel 320. Page padding `26px 36px 20px`.

1. **Top bar,** 46px: `Organization › Skills and MCP › Suggestions`; nothing at the right. The library's `Suggested` band (`library.md`) links here, as does its `Suggested {n}` in the panel.
2. **Title** `Suggestions` (Manrope 700 26px). **Lede,** 15px `--muted`: `What members asked to add to {organization}'s library. Nothing is installed until an admin installs it.`
3. **Tabs,** 16px under the lede: `Open {n}` (mono 12px `--faint` count) and `Decided`.
4. **The list,** 16px under the tabs, newest first. 40px rows, a 1px `--line` under each, padding `0 8px 0 4px`, one grid:

   | Column | Width | Contents |
   |---|---|---|
   | Kind | 28px | Lucide 15px `--faint`: `book-open` a skill, `plug` an MCP server |
   | Reference | `minmax(0,1fr)` | Plex Mono 500 14px `--text`, as the member wrote it, ellipsis |
   | From | 150px | 13px `--muted`, the member's name |
   | Allowlist | 178px | 13px `--faint`: Lucide `lock` 13px + `Not on the allowlist`, or `check` 13px `--green` + `On the allowlist` |
   | Age | 40px, right | mono 12px `--faint`: `2h`, `1d` |

   The selected row has a `--sel` fill and a 6px radius (`aria-selected`). On load the first open one is selected unless the URL names one.
5. **The selected suggestion,** 24px under the list: two columns, `44% | 1fr`, 28px apart, no cards.
   - **Left, `Suggested`** (12px 500 `--faint`): the reference in Plex Mono 600 15px; 8px down, the kind as a chip (`skill`, `MCP server`) and 13px `--muted` `for {organization}'s library`; 12px down, the member's note, 14px/1.6 `--text`; 10px down, a 20px avatar and 13px `--muted` `{member} · {when}`.
   - **Right, `At the source`** with 12px `--faint` `· looked up just now`: what core finds at the reference today, as `78px | 1fr` key-value rows with a 1px `--line` between them, 13.5px:
     - `Skill`: the name in mono, the description in 13px `--muted` under it (`Server`: the name, the version and the remote's host);
     - `Commit`: mono, then `--faint` `{ref} · {age}` (a server: `Version`);
     - `Files`: `{n} · {size} · {k} look like scripts` (a server: `Inputs`, `{n} · {k} secret`);
     - `Hash`: `sha256 {first 4}…{last 4}` mono;
     - `Allowlist`: `lock` `--faint` + `{source} isn't on it.` + a teal `Allow it`, or `check` `--green` + `On it, as {entry}`.
6. **The decisions,** under a hairline 20px below the columns, 16px padding above, one row, 8px apart:
   - **`Install…`,** the page's one primary (Lucide `download`). It opens the install sheet (`library-install.md`) with the reference filled and looked up, its head reading `Suggested by {member}`. Installing there decides the suggestion.
   - **`Dismiss`,** outline with a 14px `chevron-down` (`chevron-up` and `--sel` while open, `aria-expanded`). It opens a `Popover`, 380 wide, under it at a 4px gap: `Dismiss {name}?` (14.5px 600); the label `A reason for {member} (optional)`; a `Textarea` (`--surface`, a `--control-line` edge, 8px radius, 13.5px/1.55, at least 3 lines); under it 12px `--faint` `{member} sees it on their suggestion, and nowhere else.` and the counter `{n} / 500` in mono; then `Cancel` (ghost) and `Dismiss suggestion` (outline).
   - At the row's right, 12.5px `--faint`: `{member} is told either way.`

### The properties panel (320)

1. **Suggestion:** `Kind`, `From` (avatar and name), `Sent` (`today, 14:12`), `Source` (mono: the repo, or the registry and the name), `Ref` (mono, `the default` `--faint` when none was given), `Status` (a 7px dot and `Open`, `Installed`, `Dismissed`, `Withdrawn`).
2. **Who decides:** `Org admins` with their avatars and names, then 12.5px `--faint` `Any of them installs or dismisses it. Members suggest; they never install.`
3. **This month:** `Installed`, `Dismissed`, `Withdrawn`, mono counts.

## Layout: a member's form (`library-suggest-form.webp`)

The library page (`library.md`) read-only, as `library.md`'s "A member who isn't an org admin" state: no `Add from a source` or `Browse marketplace`; at the top bar's right `Suggest a skill or server` (outline, Lucide `message-square-plus`). The member's own open suggestion shows in the `Suggested` band as `You suggested it · {age}` with a teal `Withdraw`.

`Suggest a skill or server` opens a right `Sheet`, **480 wide** (it holds a look-up and a list, not a whole install), shadcn's: `--side`, a `--line` left edge, `--shadow-palette`, the `--scrim` behind.
1. **Head,** padding `20px 24px 0`: `Suggest a skill or server` (600 17px); 13.5px `--muted` `An admin of {organization} installs it, or tells you why not.`; the `Skill | MCP server` toggle.
2. **`Source`** (or, for a server, `Server's name in the registry` and a `Registry` select), with `Look up` inside its end, as the install sheet.
3. **What was found,** a block with a 1px `--line` edge and an 8px radius, padding `10px 12px`: the name in mono 500 14px and `at {commit}` mono 12px `--faint`; the description 13px `--muted`; mono 12px `--faint` `{n} files · {size} · {k} look like scripts`; then, under a hairline, the allowlist line: `lock` + `{source} isn't on {organization}'s allowlist. An admin can add it when they install.` (On the list: `check` `--green` + `Its source is on the allowlist.`) A suggestion from a source that isn't on the list is still allowed: ADR 0069 says only that it "says so".
4. **`Why your team wants it`,** a `Textarea`, 3 lines at least, required; under it 12px `--faint` `Admins see it with your name.` and the counter `{n} / 1,000`.
5. **`Your suggestions {n}`** (600 14px, 18px above): the member's own, newest first, a 1px `--line` under each, padding 8px 0, a `16px | 1fr | auto` grid:
   - a 14px icon: `clock` `--faint` open, `check` `--green` installed, `x` `--faint` dismissed or withdrawn;
   - the reference in mono 500 13.5px;
   - line 2, 12.5px `--muted`: `Open · sent 3 days ago`, `Installed by {admin} · {date}`, `Dismissed by {admin} · {date}`, `Withdrawn · {date}`;
   - a dismissal's reason as a quote under it, 12.5px `--faint`, a 2px `--line-2` left rule;
   - an open one has a teal `Withdraw` at the right.
6. **Footer,** pinned: 13px `--muted` `Nothing reaches a profile until an admin installs it and attaches it.`, then `Cancel` (ghost) and `Send to the admins` (primary, Lucide `send`), disabled until the look-up found something and the note isn't empty.

## Every state

| State | What shows |
|---|---|
| **Open, several** (the first picture) | As above |
| **No open suggestions** | Under the tabs: Lucide `message-square-plus` 28px `--faint`, `No suggestions waiting` 16px 600, `Members suggest skills and servers from the library page. Their suggestions wait here for an admin.` 14px `--muted` |
| **Decided tab** | The same list with an `Outcome` column (150px) in place of `Allowlist`: `check` `--green` `Installed` / `x` `--faint` `Dismissed` / `Withdrawn`, and a `By` column. The selected one shows the note, the outcome with who and when, the reason given, and for an installed one a teal `Open db-seeding` (the item page) |
| **A server suggestion selected** | `At the source` shows `Server`, `Version`, `Remote` (the host), `Inputs` (`3 · 1 secret`), `Allowlist`. A server that needs OAuth or has packages only shows the install sheet's refusal words (`library-install.md`) as the last row, and `Install…` reads `Install, marked` or is disabled with them |
| **The source changed or vanished since it was suggested** | `At the source` reads 13px `--red` `circle-x` `{reference} doesn't resolve any more: {reason}.` `Install…` is disabled; `Dismiss` stays, with the reason prefilled `It's no longer at its source.` |
| **The look-up is running** | The right column's rows are 20px `--surface` skeleton bars |
| **Installed from here** | The install sheet closes, the row leaves `Open` for `Decided`, the next one is selected, and a toast `db-seeding installed. Sam Rivera sees it on their suggestion.` |
| **Dismissed** | The popover closes, the row moves to `Decided`, and a toast `Dismissed. Sam Rivera sees your reason on their suggestion.` |
| **Two admins at once** | The second's action is refused: `Priya Shah installed it a moment ago.` and the page refreshes |
| **The member is told** | On their suggestion: the library's `Suggested` band and the sheet's `Your suggestions` show the answer and the reason the next time they open the library. It isn't a "needs you" moment, so it raises no notification (F-036) and no email in this milestone (open point 3) |
| **A member's sheet, the look-up fails** | The install sheet's not-found words; `Send to the admins` disabled |
| **A member suggests what's already in the library** | `It's in the library already, at {pin}.` with a teal `Open it`; `Send` disabled |
| **The same reference, suggested twice** | `{member} suggested it {age} ago. Add your note to theirs?` and `Send` adds it to the open suggestion, so the admins see one row with two notes |
| **Withdrawn** | The member's row moves to `Withdrawn · {date}`, and it leaves the admins' `Open` tab |
| **Light theme** | `../m7/light-home.md`'s tokens. No colour of its own |

## Keyboard

- **Admins' list:** each row one Tab stop; ↑ and ↓ move the selection (as memory proposals); Enter moves focus to `Install…`. `i` and `d` aren't added: `a` already approves and single keys stay few (`../m7/shortcut-sheet.md`).
- **Dismiss's popover:** focus starts in the reason; ⌘Enter (Ctrl+Enter) dismisses; Escape closes it and returns focus to `Dismiss`.
- **The member's sheet:** a Radix `Dialog`: focus starts in `Source`, Enter looks up, ⌘Enter sends when `Send` is on, Escape closes (asking first with a note written).

## Narrow and phone width

- **1024 to 1279:** the context panel collapses (the shell's rule); the two columns of the selected suggestion keep their split.
- **Below 1024:** the properties panel moves under the decisions as a section; the two columns stack (`Suggested`, then `At the source`).
- **Phone (390):** the shell's phone pattern (a 54px top bar whose menu button opens the rail and the panel as one sheet; `app-shell.md`). The list is one 60px row per suggestion (reference; `{member} · {age}` and the allowlist line under it); a tap opens the suggestion full-screen with `Install…` and `Dismiss` pinned at the bottom as two 44px buttons. The member's sheet is a full-screen bottom `Sheet`.

## Components (shadcn/ui names)

- **From the repo:** the shell, `Tabs`, `Button`, `Popover`, `Textarea`, `Sheet`, `ToggleGroup`, `Input`, `Select`, `Tooltip`, the toast, and memory proposals' list and two-column layout (`components/memory/proposals-page.tsx`).
- **New:**
  - `components/library/suggestions-page.tsx`: the list, the selected one, the decisions;
  - `suggestion-source.tsx`: `At the source`;
  - `dismiss-suggestion-popover.tsx`;
  - `suggest-sheet.tsx` and `my-suggestions.tsx`;
  - `allowlist-note.tsx` and the look-up from `library-install.md`.

  A suggestion's state is a union with an exhaustive `switch`: `open | installed | dismissed | withdrawn`.
- **Icons** (Lucide, stroke 1.75): `book-open`, `plug`, `lock`, `check`, `x`, `clock`, `download`, `chevron-down`, `chevron-up`, `message-square-plus`, `send`, `circle-x`.

## Tokens

`globals.css`'s, both themes: `--bg` the page, `--side` the member's sheet, `--raise` the popover, `--sel` the selected row and the open `Dismiss`, `--surface` the textarea and skeletons, `--line` hairlines, `--line-2` chips and a quote's rule, `--control-line` the textarea, `--text` references and notes, `--muted` names and labels, `--faint` ages, help and the allowlist line, `--green` installed and allowed, `--red` a broken source, `--teal` links, `--primary` `Install…` and `Send to the admins`. **No amber.**

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--bg` (ages, the allowlist column) | 5.9:1 | 5.6:1 | 4.5 |
| `--faint` on `--sel` (the selected row's age and allowlist) | 5.2:1 | 4.8:1 | 4.5 |
| `--muted` on `--sel` (its member) | 8.6:1 | 7.0:1 | 4.5 |
| `--muted` on `--bg` (labels, keys) | 9.6:1 | 8.1:1 | 4.5 |
| `--teal` on `--bg` (`Allow it`) | 8.4:1 | 6.1:1 | 4.5 |
| `--green` on `--bg` (the allowed check) | 7.4:1 | 5.5:1 | 3 |
| `--faint` on `--raise` (the popover's help and counter) | 5.4:1 | 5.8:1 | 4.5 |
| `--control-line` on `--surface` (the textarea's edge) | 3.4:1 | 3.4:1 | 3 |
| `--faint` on `--side` (the sheet's help, a quoted reason) | 6.0:1 | 5.3:1 | 4.5 |
| `--muted` on `--side` (the sheet's line 2s) | 9.8:1 | 7.6:1 | 4.5 |
| `--teal` on `--side` (`Withdraw`) | 8.5:1 | 5.7:1 | 4.5 |

## Data it needs

From ADR 0069 and the milestone 8 spec (tickets 28 and 30):
1. **A suggestion:** kind, the reference as written (source, ref, or registry and name), the member, the note (at most 1,000 characters), when, its state, and the decision (who, when, the reason, at most 500 characters, and the item it became). A branded `LibrarySuggestionId`.
2. **`library.suggestions.list({ state })`** for admins; **`library.suggestions.mine()`** for a member.
3. **`library.lookUp`** (`library-install.md`), run when an admin opens a suggestion and when a member looks up.
4. **`library.suggestions.create`, `.withdraw`, `.dismiss({ reason })`**, and the install's `fromSuggestion` field that decides it. Each decision is an audit entry (ADR 0054), with names and never the note or the reason.
5. **The decision on the member's suggestion,** read with `.mine()`; no notification.
6. **The allowlist**, to say whether the source is on it, matched by source.

## Differences from the current code

1. **No suggestions:** a member can't ask for a skill or server; they edit nothing in a profile they can't administer.
2. **No `Suggestions` page** under the library.
3. **Messages:** new keys under `library.suggestions.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **A suggestion from a source that isn't allowed:** accept it and say so (drawn; ADR 0069: "says so"), or refuse it until an admin allows the source. Recommended as drawn: the admin can allow the source while installing, in the same sheet.
2. **The dismissal's reason:** optional (drawn), or required. Recommended: optional, with a prefilled reason for the common cases (packages only, OAuth, a source gone).
3. **How the member is told:** on their own suggestion, the next time they open the library (recommended, drawn), or also a notification. A decision isn't a needs-you moment, so F-036 doesn't cover it as written.
4. **A second member suggesting the same reference** joins the first (recommended), rather than a second row.

## Wrong in the image (build from this file)

- **`library-suggestions.webp`:** `isn't on it. Allow it` wraps onto a second line in the `Allowlist` row. Fine at this width; build it to wrap, never to truncate.
- **`library-suggestions.webp`:** the Organization panel's `Skills and MCP` count is the library's size (14), as `library.md` draws it. The open suggestions' count shows only on the library page and this page's tab, never in the panel.
- **`library-suggest-form.webp`:** the member's Organization panel is drawn by removing the admin rows from the shared `shell.js` after it runs (`html/library-suggestions.html`). Build it from the shell's role gates (`app-shell.md`), not the picture.
- **`library-suggest-form.webp`:** the library behind the sheet is trimmed (no `Updates` tab, no last column). Build the member's library from `library.md`'s member state.
