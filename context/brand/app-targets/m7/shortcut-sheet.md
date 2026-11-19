# Target: the shortcut sheet (milestone 7, screen 6)

> **Committed image:** `shortcut-sheet.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `shortcut-sheet.webp` | Alex Kim pressed `?` on Home. The sheet lists every shortcut by scope: `Anywhere` on the left, `On a needs-you item` and `On a task` on the right, the `g` sequences drawn as sequences, and the palette's link in the footer. |

- **Prompt:** `shortcut-sheet.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `../m4/search-palette` (the screen spec section 13 names as the start: the same dialog over the same dimmed Home), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Feature:** F-081. Spec section 4 ("The palette's actions": one registry drives the palette, the shortcuts and the sheet), section 12 item 11 (the shortcuts, Q260). Ticket 13 (this screen and the shortcuts), ticket 17 (the walk).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 13 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Every shortcut the panel has, on one sheet, so a member learns them once. It's drawn **from the registry** (ticket 13), never typed by hand: ticket 13's test fails when a shortcut has no line here or a line has no shortcut. The sheet also points to the palette, where every action is, with or without a key.

## Route

No route: a `Dialog` over every panel page, opened by `?` (Shift+/ on most layouts) anywhere outside a text field, by `?` typed into an empty palette, by the palette's footer hint `?` `All shortcuts`, and from Account, Appearance's link (`account-appearance`). Closed by Escape, by `Close`, or by clicking outside it. Focus returns to what had it.

## Layout

The page underneath stays as it was, under the current overlay (`bg-black/50`).

**The sheet:** `Dialog.Content`, 760px (`min(760px, 100vw - 32px)`), centred, top at `12vh`, `--surface` fill, 1px `--line-2`, radius 12px, the palette's shadow. Its height follows its content.

1. **Header,** 52px, padding 0 20px, a 1px `--line` under it: the title `Keyboard shortcuts` 15px weight 600 `--text` (`Dialog.Title`); at the right a ghost button holding a `Kbd` `esc` and `Close` 12px `--faint` (`aria-label="Close"`).
2. **Body,** padding 16px 20px 20px, two columns of 340px with a 40px gap (`grid-template-columns: 1fr 1fr`).
   - **A scope's label,** 28px: 12px weight 500 `--faint`, sans (`Anywhere`); after it, 12px `--faint` the scope's condition where there is one (`focused in a list`). 20px above every label but the column's first.
   - **A line,** 34px, a 1px `--line` under it: the action 14px `--text` at the left (the action's label from the registry, without `…`), then, for `Stop`, 12.5px `--faint` ` asks to confirm`; its keys at the right.
   - **Keys:** a `Kbd` per key (20px tall, min 20px wide, radius 4px, 1px `--line-2`, `--bg` fill, Plex Mono 11.5px `--muted`). **A sequence** is two `Kbd`s with `then` 11px `--faint` between them, 6px each side. **A chord** is two `Kbd`s 4px apart with no word. The same `kbd-sequence.tsx` draws them here and in the palette (`command-palette.md`).
3. **Footer,** 44px, padding 0 20px, a 1px `--line` above it: `info` 13px `--faint` and 12.5px `--faint` `Shortcuts don't fire while you type in a field or the composer.`; at the right a teal link 13px `Every action is in the command palette` and the chord `⌘` `K` (`Ctrl` `K` off macOS), which closes the sheet and opens the palette.

### The lines (from the registry)

| Scope | Action | Keys |
|---|---|---|
| Anywhere | `Open the command palette` | `⌘` `K` (chord; `Ctrl` `K` off macOS) |
| Anywhere | `Search tasks` | `/` |
| Anywhere | `New task` | `c` |
| Anywhere | `Go to Needs you` | `g` then `n` |
| Anywhere | `Go to Home` | `g` then `h` |
| Anywhere | `Go to Tasks` | `g` then `t` |
| Anywhere | `Show these shortcuts` | `?` |
| On a needs-you item (`focused in a list`) | `Approve` | `a` |
| On a needs-you item | `Deny` | `d` |
| On a needs-you item | `Reply or answer` | `r` |
| On a task | `Reopen` | `o` |
| On a task | `Take over` | `t` |
| On a task | `Stop` + ` asks to confirm` | `s` |

The order is the registry's. A new action with a shortcut adds its line by being registered; the sheet has no list of its own.

**Role:** the sheet lists every shortcut, whatever the member's role, because a key is the same for everyone; a key whose action the member can't take does nothing on that item (and the palette doesn't offer it). Recommended over hiding lines, so two people comparing notes see the same sheet.

## How the shortcuts behave (the sheet's promise; ticket 13 builds it)

- **Never while typing:** not in an `input`, `textarea`, `select`, a `contenteditable`, the composer, or while a dialog other than the sheet has focus. The footer says so.
- **Sequences:** after `g`, the next key within **1 second** completes it; anything else, or the second passing, drops it. While a `g` waits, a small 28px `Kbd` `g` shows at the bottom-left of the window (12px from each edge, `--surface`, 1px `--line-2`, `aria-hidden`), so a member sees the first key landed; it leaves when the sequence ends.
- **On a needs-you item:** `a`, `d`, `r` act on the focused row of a needs-you list (Home, Needs you, a project's Tasks) and on the open item of a task page. `a` approves once; `d` opens the deny reason; `r` focuses the reply or the question's first field.
- **On a task:** on a task's page. `s` opens an `AlertDialog` (`Stop CALC-174?` / `The agent's turn ends now. You can reopen it later.` / `Cancel`, `Stop task`).
- No modifier but ⌘K / Ctrl+K (spec item 11), so no key fights the browser's or a screen reader's.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json` under `shortcuts.*`; the action labels are the registry's (`actions.<id>.label`).

| State | Shows |
|---|---|
| **Open** (`shortcut-sheet.webp`) | As above |
| macOS / elsewhere | `⌘` on macOS, `Ctrl` elsewhere (`navigator.userAgentData.platform`, falling back to `navigator.platform`) |
| Narrow (below 800px) | one column: `Anywhere`, then `On a needs-you item`, then `On a task`; the sheet scrolls inside `min(80vh, 720px)` |
| Phone (390px) | not opened by a key (there's none). Reached from Account, Appearance's link, as a full-height `Sheet` from the bottom with the same lines and a top note 13px `--muted` `For when a keyboard is connected.` |
| Light theme | the same layout on the light tokens (`light-home`) |

## Components (shadcn/ui names)

- **From the repo:** `Dialog` (`radix-ui`, as the palette), `Kbd`, `Button` (ghost), `Sheet` (phone).
- **New:** `components/shell/shortcut-sheet.tsx`, `kbd-sequence.tsx` (shared with the palette), `use-shortcuts.ts` (the one key listener, reading the registry).
- **Semantics:** `Dialog.Title` is the heading; each scope is a `section` with an `h3` label; each scope's lines are a `dl` (`dt` the action, `dd` the keys), each `Kbd` a `kbd`, a sequence's `then` a real word in the text, so a screen reader reads "g then n".
- **Icons:** `info` 13px. No icon per line.

## Tokens

The measured dark tokens; the light ones from `light-home`. No amber, no green, no red on the sheet. The link is teal.

## Contrast (WCAG AA, F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text` #F2F3F4 on `--surface` #131416 (actions, title) | 16.6:1 | 4.5 |
| `--muted` #B4B7BB on `--bg` #0D0E10 (`Kbd` letters) | 9.6:1 | 4.5 |
| `--faint` #8B8E93 on `--surface` (labels, `then`, the footnote) | 5.6:1 | 4.5 |
| teal #6FB8AA on `--surface` (the link) | 8.0:1 | 4.5 |

The `Kbd` border (`--line-2`) is decoration. The close button's focus ring is the panel's 2px `--text` outline.

## Differences from the current code

1. **Nothing exists:** no `?` key, no sheet, no shortcut listener; the palette is the only key binding (⌘K).
2. **`Kbd`** exists; `kbd-sequence.tsx` is new.
3. **Messages:** `shortcuts.*` (title, scope labels, `then`, `asks to confirm`, the footnote, the link, the phone note) and the registry's action labels.

## Open points (recommendations; ticket 13 records the answer)

1. **`t` means take over on a task, and `g` then `t` goes to Tasks.** They don't clash (a sequence needs its `g`), but a member who presses `t` after a stale `g` would take over. Recommended: the 1-second window, and `t` ignored for 1 second after a dropped `g`.
2. **Lines for keys a member can't use.** Recommended: listed for everyone (above).

## Wrong in the image (build from this file)

- **The scope labels `Anywhere` and `On a task` are drawn in mono**, and `needs-you item` is brighter than the rest of its label. Build 12px weight 500 `--faint` Plex Sans, one tone.
- **The lines are drawn with boxes around each column's rows.** Build hairlines under each line only, no box.
- **The `Kbd` letters** are bright. Build `--muted`.
- **The sheet's top** sits at about 168px. Build `12vh` (about 115px at 956px).
- **The `esc` and `Close` look like two controls.** It's one ghost button.
- **The sidebar** is milestone 4's picture's. Build it from `sidebar.tsx`.
