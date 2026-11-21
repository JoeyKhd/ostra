# Target: a profile's skills and MCP servers, with library items (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. All three render from `html/agent-profile-library.html`, a query string choosing the state (`?theme=light`, `?state=limit`), with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `agent-profile-library.webp` | Alex Kim, an org admin, edits `Careful`. **Skills** `5 of 50`: its own `changelog`; three from the library (`webapp-testing` with an update waiting in the library, `prisma-migrations`, and `pdf`, just attached and not saved yet); `frontend-design`, on every profile. **MCP servers** `5 of 20`: two of its own, two from the library, one on every profile. The attach picker is open from Skills' `From the library`: an attachable skill, an attached one, an every-profile one, one refused because `Careful` has its own `changelog`, and in the servers' group an attachable one and `globex-crm`, which needs sign-in. The properties panel counts against the limits. |
| `agent-profile-library-light.webp` | The same in the light theme. |
| `agent-profile-library-limit.webp` | Scrolled to MCP servers, now `20 of 20`: 3 of its own, 15 from the library (two shown, `Show 13 more`), 2 on every profile. Attaching `incidents` was refused, and the refusal under the section names the profile and the counts. |

- **Route:** unchanged, `apps/web/src/app/(panel)/organization/agent-profiles/[profile-id]/page.tsx` → `components/agent-profiles/agent-profile-editor.tsx` (`../m3/agent-profile.md`).
- **Shell:** the double sidebar (`app-shell.md`): the rail's **Org** space, the Organization panel's **Agent profiles** row selected.
- **Features:** F-021 (agent profiles), which gains attached and inherited library items and stays `building`; F-145 (the skills and MCP library: "Items attach to agent profiles, or are marked every profile … within a profile's limits of 50 skills and 20 MCP servers. A name the profile already uses is refused"). ADR 0069 ("Attaching", "Delivery: unchanged"), ADR 0049. The milestone 8 spec names this target in section 13 (target 15, `agent-profile-library`), starting from `../m3/agent-profile`.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

With the library, a profile's skills and servers come from three places (ADR 0069, "Consequences"): its own, attached from the library, and inherited from items on every profile. The editor has to make each row's origin plain, because each is changed somewhere else:
1. **Its own** are edited here, as milestone 3 drew them.
2. **Attached** ones are pinned in the library: here they're only attached or detached, and their source links to the item.
3. **Every-profile** ones are set in the library: here they're shown, counted, and can't be removed.

And it has to say how close the profile is to its limits, since all three count (50 skills, 20 MCP servers, ADR 0049).

## Layout

As `../m3/agent-profile.md`, in the new shell: the page column is 1136, the page `minmax(0, 1fr)` and the properties panel **340** (`wideProperties`: it holds form controls). Page padding `26px 36px 20px`; the main column at most 724.

The heading (eyebrow, title, lede), `Agent and model`, `Instructions`, `Approval rules` and the footnote are unchanged from milestone 3. Only `Skills` and `MCP servers` change.

### A section's title line

As every section (`m8.css`'s `.shead`, 30px): the title in Plex Sans 600 15px; the count as `{n} of {limit}`, the number in mono 500 `--text` and ` of 50` in mono `--faint`; the note in 13px `--muted` (milestone 3's notes, unchanged). The count is every row of the section, of all three kinds.

### The three groups

Under the title line, up to three groups, each with a label row 28px tall: 12px 500 `--faint` label and mono count, and an optional 12px `--faint` note at the right. A group with no rows is left out.

| Group | Label and note | Rows |
|---|---|---|
| **Its own** | `Its own {n}` | Milestone 3's rows, unchanged: `Edit` (teal) and remove (`x`) |
| **From the library** | `From the library {n}`; note `pinned in the library; an update there reaches this profile once an admin accepts it` | Attached items, in the order they were attached; `x` detaches |
| **On every profile** | `On every profile {n}`; note `set in the library` | Items marked every profile; nothing to remove here |

**A row,** 40px, a 1px `--line` above each and under the group's last, one grid `26px | 150px | minmax(0,1fr) | auto | 52px`, 10px apart:
1. the kind's icon, 15px `--faint` (`book-open` a skill, `plug` a server);
2. the name, Plex Mono 13.5px `--text`, ellipsis;
3. **the middle:**
   - its own: as milestone 3 (a skill's description; a server's `HTTP` or `stdio` chip and its URL or command in mono `--faint`);
   - a library item: its source in mono 12.5px `--teal`, a link to the item's page (`library-update.md`), with the whole source in its `title`;
4. **the meta,** right-aligned, 6px apart:
   - its own: as milestone 3 (`SKILL.md · 1 file`, a header's `set` chip, `read-only`);
   - a library item: the pin in mono 12.5px `--text` (`a3f9c1e`, `v0.21.0`), after any chips: `1 secret` (Lucide `lock`) for a server with secret inputs; `update waiting` (Lucide `circle-arrow-up` 12px `--teal`) when the library holds an update not yet accepted, which changes nothing here; `Every profile` (Lucide `layers`) on an inherited row; `not saved yet` (a dashed `--line-2` edge) on a row attached since the last save;
5. **the actions,** right-aligned: its own, `Edit` and `x`; attached, `x` alone (`aria-label="Detach webapp-testing"`); inherited, none.

**Under the groups,** 8px down, the ghost buttons (26px, 13px): milestone 3's (`Skill`; `HTTP server`, `stdio server`) and, new, **`From the library`** (Lucide `blocks`), which opens the attach picker. While it's open the button has the `--sel` fill and `aria-expanded`.

### The attach picker

A `Popover` with a `Command` inside, 470 wide, under its button at a 4px gap and aligned to its left edge (Radix flips it above when there's no room). `--raise`, a 1px `--line-2` edge, 10px radius, `--shadow-pop`.
1. **The search,** 40px, a `--line` under it: `search` 15px and the placeholder `Find a skill or server in the library` (14px `--faint`). It matches name and source.
2. **Two groups,** the section it was opened from first: `Skills {n}` and `MCP servers {n}` (12px 500 `--faint`, the count in mono). Each item, padding `6px 8px`, 6px radius, a `16px | 1fr | auto` grid:
   - the kind's icon 15px `--faint`;
   - the name in mono 500 13.5px, then `{pin} · {source}` in mono 12px `--faint`, ellipsis;
   - at the right, 12.5px `--faint`, its state.
   - The active item (keyboard or pointer) has the `--sel` fill.
3. **The items' states:**

   | State | Right | Line 2, 12.5px `--faint` | Selectable |
   |---|---|---|---|
   | Attachable | — | — | yes: it's attached, the picker stays open, the row appears with `not saved yet` |
   | Already attached | `check` `--green` + `attached` | — | yes: it detaches |
   | On every profile | `layers` + `on every profile` | — | no |
   | The profile already uses its name | — | `Careful has its own changelog. Rename or remove it first.` | no |
   | Needs OAuth sign-in | `key-round` + `needs sign-in` | `It needs sign-in, which ostra doesn't do yet.` | no |
   | Its source left the allowlist | `lock` + `source not allowed` | `Attached profiles keep it; it can't be attached anew.` | no |

   A disabled item's name is `--faint`, and it's skipped by the arrows' selection but read by a screen reader with its reason.
4. **Footer,** a `--line` above, padding `9px 14px`, 12.5px `--faint`: `{n} of 50 skills · {n} of 20 servers` (the numbers mono `--text`), and a teal `Open the library` at the right.

**Org admins only:** a member who may use the profile sees the three groups read-only, with no buttons, no `x`, and the sources as links they can open.

### The refusal at the limit (`agent-profile-library-limit.webp`)

When an attach would pass a limit, nothing is attached, the picker closes, and the section shows under its buttons, `role="alert"`, 12px down: a 2px `--red` left rule, Lucide `circle-x` 15px `--red`, and 13px `--text-2`:

> `incidents wasn't attached. Careful already has 20 MCP servers, the most a profile holds: 3 of its own, 15 from the library and 2 on every profile. Detach one first.`

For skills: `… already has 50 skills, the most a profile holds: …`. The refusal stays until the section's count changes.

**Every profile, from the library's side** (not drawn here): turning an item's `Every profile` on, on its page (`library-update.md`), is refused when any profile would pass a limit, naming each one: `Turning on Every profile would give Careful 21 MCP servers, over the 20 a profile holds. Detach one from Careful first.` (ADR 0069: "the refusal names the profile").

### The properties panel (340)

Milestone 3's groups, with one new group after `Profile`:
- **Skills and MCP:** `Skills` `{n} of 50`, with 12px `--faint` under it `{own} own · {attached} library · {every} every profile`; the same for `MCP servers` `{n} of 20`; at the limit, 13px `--muted` ` · the most it holds` after the count. Then 12.5px `--faint`: `Every-profile items count on every profile, the built-in Refine and Review profiles too.`
- `Plan first`, `Who may use it` and `Default for` as milestone 3 (the switch teal, `app-design.md`). The picture leaves out `Archive` for room.

## Every state

| State | What shows |
|---|---|
| **Items from all three places** (the picture) | As above |
| **No library items** | Only `Its own`, with no label row (as milestone 3 looks), and `From the library` under it. An empty library: the picker reads `The library has no skills yet.` with a teal `Add one in the library` (org admins) |
| **Only inherited ones** | `On every profile` alone; the section's count includes them |
| **Attached, not saved** | The row's `not saved yet` chip; `Save profile` turns on; leaving asks first, as milestone 3. Saving makes the attachment, an audit entry (ADR 0054) |
| **Detached, not saved** | The row stays at 45% opacity with `Undo` (teal) in place of `x`, until saved |
| **An update waiting in the library** | The `update waiting` chip; a click on it opens the item's `Update` tab. The profile keeps the old pin until an admin accepts it there |
| **An attached item removed from the library** | It's gone from every profile at once (ADR 0069, "Consequences"); the editor, open at that moment, shows a toast `webapp-testing was removed from the library, so Careful no longer has it.` |
| **Its source left the allowlist** | The row keeps working; its meta adds `source not allowed` (Lucide `lock`, `--faint`), as the library's row |
| **A server that needs sign-in** | Never attached (the picker refuses it). One attached before it started asking shows `needs sign-in` and is skipped at delivery, with the task's warning `globex-crm needs sign-in, so it wasn't given to the agent.` |
| **At a limit** | `agent-profile-library-limit.webp`. The picker still opens, its attachable items disabled with line 2 `Careful is at 20 MCP servers.` |
| **The built-in profile** | The same three groups. `Every profile` items are on it too |
| **A member who may use it** | Read-only, as above |
| **Loading** | Each group's rows are skeleton bars; the counts wait for them, never `0` |
| **Light theme** | `agent-profile-library-light.webp`: `../m7/light-home.md`'s tokens; the sources `--teal` `#1F6B5E` |

## Keyboard

- **The groups' rows** are as milestone 3: Tab reaches each row's controls (`Edit`, `x`, a source link) in order. The label rows aren't focusable.
- **`From the library`** opens the picker with focus in its search. ↑ and ↓ move through selectable items, skipping disabled ones; Enter attaches or detaches the active item and keeps the picker open; Escape closes it and returns focus to the button. Typing filters both groups.
- **The refusal** is announced by its `role="alert"`; focus stays on `From the library`.
- No new shortcut.

## Narrow and phone width

- **1024 to 1279:** the context panel collapses (the shell's rule). The row's middle (the source) ellipsizes first.
- **Below 1024:** the properties panel moves under the main column, as milestone 3's.
- **Phone (390):** the shell's phone pattern (a 54px top bar whose menu button opens the rail and the panel as one sheet; `app-shell.md`). Each row becomes two lines, 56px: the icon and name, then the pin and chips in mono 12px `--faint`; the source moves to the row's detail (a tap opens the item). The picker opens as a full-height bottom `Sheet` with 44px items. `x` and `Edit` become 44px targets.

## Components (shadcn/ui names)

- **From the repo:** milestone 3's editor (`components/agent-profiles/agent-profile-editor.tsx`), `Popover`, `Command`, `Button`, `Tooltip`, the toast.
- **New:**
  - `components/agent-profiles/profile-items-section.tsx`: the three groups for one kind, with the count and the refusal;
  - `library-item-row.tsx`: the attached and inherited rows;
  - `attach-from-library.tsx`: the picker.

  A row's origin is a union with an exhaustive `switch`: `own | attached | every-profile`. An item's pickability is a union: `attachable | attached | every-profile | name-taken | needs-sign-in | source-not-allowed | at-limit`.
- **Icons** (Lucide, stroke 1.75): `book-open`, `plug`, `blocks`, `layers`, `circle-arrow-up`, `lock`, `key-round`, `check`, `x`, `search`, `circle-x`, `chevron-down`, `plus`.

## Tokens

`globals.css`'s, both themes: `--bg` the page, `--raise` the picker, `--sel` its active item and the open button, `--line` hairlines, `--line-2` chips and the `not saved yet` dashed edge, `--text` names and pins, `--text-2` the refusal's text, `--muted` descriptions and notes, `--faint` labels, line 2s and disabled names, `--teal` sources, `Edit`, the update icon and the switch, `--green` `attached`, `--red` the refusal's rule and icon, `--primary` `Save profile`. **No amber.**

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--teal` on `--bg` (a source link) | 8.4:1 | 6.1:1 | 4.5 |
| `--faint` on `--bg` (group labels, ` of 50`) | 5.9:1 | 5.6:1 | 4.5 |
| `--muted` on `--bg` (notes, descriptions) | 9.6:1 | 8.1:1 | 4.5 |
| `--faint` on `--raise` (the picker's pins, sources, reasons) | 5.4:1 | 5.8:1 | 4.5 |
| `--faint` on `--sel` (the active item's pin) | 5.2:1 | 4.8:1 | 4.5 |
| `--green` on `--raise` (`attached`'s check) | 6.8:1 | 5.8:1 | 3 |
| `--teal` on `--raise` (`Open the library`) | 7.7:1 | 6.3:1 | 4.5 |
| `--red` on `--bg` (the refusal's icon) | 5.9:1 | 5.7:1 | 3 |
| `--text-2` on `--bg` (the refusal's words) | 13.5:1 | 13.2:1 | 4.5 |
| `--on-primary` on `--teal` (the switch's knob) | 7.5:1 | 6.1:1 | 3 |

## Data it needs

From ADR 0069 and the milestone 8 spec (tickets 28 and 30):
1. **`agentProfiles.get`** gains the profile's attached items (item ID, kind, name, source, current pin, secret count, whether an update waits, whether its source is allowed, whether it needs sign-in) and the organization's every-profile items, with the counts by origin.
2. **`library.list`** for the picker, with each item's pickability for this profile, computed on the server: the name clash, sign-in, the allowlist, and the limit.
3. **`agentProfiles.save`** carries the attached item IDs. Core refuses past a limit or a name clash with the reason (the words above), and writes an audit entry for each attach and detach.
4. **Delivery is unchanged:** at dispatch, core copies the own, attached and every-profile skills at their pins into the task's blobs, and the servers go through the sidecar's MCP proxy (ADR 0069).

## Differences from the current code

1. **Skills and servers have one origin:** the profile's own rows (`AgentProfile` skills, the `mcpServers` column). No attached or inherited rows, no group labels.
2. **The counts** aren't shown against the limits, and the limits count only the profile's own.
3. **No attach picker,** no `From the library` button, no source links, no pins.
4. **The properties panel** has no `Skills and MCP` group.
5. **Messages:** new keys under `agentProfiles.library.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **One picker for both kinds,** opened from either section with that section's group first (drawn), or one picker per section. Recommended as drawn: one search finds a server or a skill without knowing which it is.
2. **Attaching takes effect on `Save profile`** (drawn, as every other edit here), or at once, as the library's `Every profile` switch does. Recommended as drawn: the editor has one save, and `Leave without saving?` already guards it.
3. **An inherited row can't be removed here** (drawn). Recommended: yes, with its `Every profile` chip linking to the item, where an admin turns it off for all.
4. **The group labels** (`Its own`, `From the library`, `On every profile`) or one list with an origin column. Recommended as drawn: three groups read faster than a column, and each group has one way to change it.

## Wrong in the image (build from this file)

- **`Agent and model` and `Instructions` are left out** of all three pictures for room, between the lede and `Skills`; `Approval rules` and the footnote are below the fold. Build them as milestone 3.
- **The picker covers the MCP servers section** in the first two pictures, as a popover does; the section is drawn whole in `agent-profile-library-limit.webp`.
- **`agent-profile-library-limit.webp`** stands for the page scrolled to `MCP servers`; the top bar stays where it is.
- **The properties panel leaves out `Archive`** for room.
- **`Save profile`** is enabled in the limit picture because `pdf` is still unsaved from the first picture's edit. With nothing changed, it's disabled.
