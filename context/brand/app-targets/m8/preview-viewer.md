# Target: the preview viewer page (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. All three render from `html/preview-viewer.html`, a query string choosing the state, with the panel's own tokens and fonts and the horizontal lockup from `apps/web/public/brand/`. The app in the frame is `html/app-fixture.js`'s "Tally", demo data in the customer app's own colours. Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `preview-viewer.webp` | Someone outside Acme Corp opened a watch-only link to `web :5173` in a signed-out browser. The page shows the lockup, the preview's label, `a preview from Acme Corp`, `Watch only` and `Expires in 23 h`, then the shared page at its own size (Desktop 1280 × 800, at 100%), and the footer's line. The pointer rests on the app, and its tooltip says nothing is sent. |
| `preview-viewer-light.webp` | The same in the light theme, which a signed-out page takes from the browser's `prefers-color-scheme`. The app keeps its own colours. |
| `preview-viewer-states.webp` | Three 390×844 screens: (1) a link that allows input, on a phone, with `You can use it` and the shared page at Phone 390; (2) an expired link; (3) a revoked one. |

- **Route:** new, `apps/web/src/app/p/[token]/page.tsx`, outside the `(panel)` group, so it loads none of the shell: no rail, no panel, no palette, no shortcuts. Its server side (ticket 20) resolves the link by its token's hash and gives the page only the preview's label, the organization's name, the expiry and whether input is allowed. The page reads the same stream and input routes as the pane (`/api/previews/<viewId>/stream` and `/input`), with the link's token instead of a session, and reaches no other tRPC procedure.
- **Shell:** none. This is the one m8 screen without the double sidebar.
- **Features:** F-142 (sharing a preview: "a link opens a viewer page that a signed-out person can open, showing only the preview's picture, its label, the organization's name and the link's expiry"), on F-141's browser view, and F-144's native preview for a link that allows input when a preview domain is set. The milestone 8 spec's section 13, target 7, and its demo's step 8. Facts: ADR 0068, "Who can open a preview".
- **Status: a proposed target, waiting for the maintainer's approval.** Ticket 21 builds it once it's approved.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

A member sends a link to someone outside the project (a designer, a client, a teammate without access) so they can see the app the agent is building. The page has to:
1. **Show the app and nothing else of ostra's:** not the task, its title, its thread, its repo or who made the link. The organization's name is the only "who" (ticket 09: "it says who shared it only by the organization's name").
2. **Say what the visitor can do:** watch, or use the app, and until when.
3. **End cleanly:** an expired or revoked link, or one the organization no longer allows, shows no picture of the app and says why.

## Layout (`preview-viewer.webp`)

The page fills the window, top to bottom, on `--bg`:
1. **The top bar,** 56px, padding `0 20px 0 22px`, a 1px `--line` under it, one line, `nowrap`:
   - **The lockup:** `lockup-horizontal-shell.svg` (`lockup-horizontal-abyss.svg` in light), 95×20, `role="img"`, `aria-label="ostra"`. It isn't a link: the visitor has nowhere in ostra to go.
   - **A divider:** 1px × 20px `--line-2`, 14px gaps either side.
   - **The label:** the preview's label in Plex Mono 500 14.5px `--text`, a space, and the port in mono 400 `--faint` (`web :5173`). Then 14px `--muted` `a preview from Acme Corp`, which ellipsizes first.
   - **At the right,** 8px apart, two chips (26px, 1px `--line-2`, 6px radius, padding `0 9px`, 13px 500 `--muted`, a 14px Lucide icon in `--faint`):
     - the mode: `eye` `Watch only`, or `mouse-pointer-click` `You can use it` in `--text-2` for a link that allows input;
     - the expiry: `clock` `Expires in 23 h` (`in 52 min` under an hour, `in 6 days`), its `title` the exact time in the visitor's time zone (`Expires 22 Nov at 14:50`). A public link has no expiry chip.
2. **The stage:** the rest of the height, `--surface`, padding `18px 20px`, the frame centred in it.
   - **The frame** has a 1px `--line-2` edge and an 8px radius, and draws the shared page's pictures at their own size: 1280 × 800 at 100% here.
   - **The size is the shared page's,** the last width a member chose in the pane (F-141: one shared page per preview). The visitor can't change it. When it doesn't fit, it scales down to fit, never up.
   - **Watch only:** the frame takes no input. A pointer over it keeps the arrow and shows a `Tooltip` after 500 ms: `Watch only: clicks and keys aren't sent`. Nothing is sent: the page has no input route to call without `allowInput`.
   - **You can use it:** the frame has `tabindex="0"`, takes the mouse, wheel, keys and pasted text as the pane does, and shows the 2px `--teal` focus outline while it has focus.
3. **The footer,** 40px, padding `0 22px`, a 1px `--line` above it, 13px:
   - **Left:** the state's dot and word in `--text` 500, then its line in `--faint`: `Live` · `streamed from the app's box` (the browser view), or `Live` · `in your browser` (the native preview).
   - **Right:** mono 12.5px `--faint`, the size and the scale: `1280 × 800 · 100%`.
   - Nothing else: no runner, no watchers' count, no task key.

The page's `<title>` is `web :5173 · Acme Corp`. It has `<meta name="robots" content="noindex">` and `Referrer-Policy: no-referrer`, so the token never leaves in a `Referer`.

## Phone (`preview-viewer-states.webp`, picture 1)

At 390 wide, with every control at least 44px tall (F-075):
- **The top bar,** 54px: the lockup, and at the right the expiry chip.
- **Under it,** a 46px line: the label (`web :5173`), `from Acme Corp`, and the mode chip at the right.
- **The stage,** padding 12px: the shared page scaled to the width (Phone 390 here, so about 93%). Pinch-zoom works on the picture.
- **The footer** wraps to two lines: the live line, then, for a link that allows input, 12.5px `--faint` `Taps and typing reach the app. Whoever else watches sees them too.`
- **Typing on a phone:** a tap on the frame focuses a hidden text field, which raises the phone's keyboard; its keys go to the app as the pane's do.

## Every state

| State | Picture | What shows |
|---|---|---|
| **Watch only, live** | `preview-viewer` | As above |
| **Input allowed, live** | `preview-viewer-states`, 1 | `You can use it`. The frame takes input, and the footer adds the line on who sees it |
| **Input allowed, with a preview domain** | not drawn | The native preview (`preview-native.md`): the app itself in an iframe on its preview host, after the link's own one-time code. The footer reads `Live` · `in your browser`. A watch-only link never gets a code, and stays the browser view (ticket 26) |
| **Starting** | not drawn | The stage shows the pane's starting block without its log: spinner, `Opening web :5173`, `It appears here when the app answers.` |
| **Not running** (the box asleep, or the task ended) | not drawn | The last frame, grayscale at 10% (35% in light), behind a 380-wide block on `--raise`: `moon`, `The app isn't running right now`, `It shows here again when someone at Acme Corp starts it. This page picks it up by itself.` A visitor can't start it: only a member who can open the task can (F-141) |
| **The stream dropped** | not drawn | The last frame stays, with the pane's pill: spinner and `Reconnecting…`; after 30 s, `Lost the stream.` and `Retry` |
| **Expired** | `preview-viewer-states`, 2 | The stage gives way to a block 380 wide on `--bg`: a 36px icon box with `clock`, `This link has expired` (600 17px), `It opened web :5173 from Acme Corp until 14:50 on 22 Nov. Ask whoever sent it for a new one.` (14.5px `--muted`), and under a hairline, 13px `--faint` `Nothing of the app is shown after a link ends.` No footer, no picture |
| **Revoked** | `preview-viewer-states`, 3 | The same block: `link-2-off`, `This link was revoked`, `Someone at Acme Corp revoked it at 15:02 today. Ask them for a new link.` The words are the m8 spec's demo's, step 8 |
| **The level changed** (narrowed away from links) | not drawn | As revoked: `This link was revoked`. A narrowed level ends every viewer who no longer qualifies (`task-preview.md`, the share menu's rules) |
| **Public links turned off** (an organization admin turned the setting off after a public link was made) | not drawn | The same block: `lock`, `This link isn't allowed any more`, `Acme Corp no longer allows public preview links. Ask whoever sent it for another way in.` |
| **The runner can't serve it** (below protocol minor 7) | not drawn | The same block: `server-off`, `This preview can't be shown right now`, `Ask whoever sent the link.` It names no runner and no version to the visitor |
| **An unknown token** | not drawn | The same block: `link-2-off`, `This link doesn't open anything`, `Check that you copied all of it.` It never says whether the token once existed |
| **Light** | `preview-viewer-light` | `../m7/light-home.md`'s tokens and the abyss lockup. The app's colours don't change |

A visitor's open page that crosses an end (the expiry, a revoke, a narrowed level) loses the stream at once and shows that block. Core ends the view; the page doesn't wait for a reload.

## Keyboard

- **Tab order:** the chips' tooltips (each chip is a focusable `button` that only shows its `Tooltip`), then the frame when input is allowed. A watch-only frame isn't a tab stop.
- **With input:** the frame is named `web :5173, live` and takes keys while it has focus. Escape is sent to the app; Tab leaves the frame only with ⌘. (Ctrl+. elsewhere), as in the pane, so a form in the app keeps its own Tab.
- **The end blocks** are `role="status"`, so a screen reader hears the change while the page is open.
- The page has no shortcuts of its own, and none of the panel's.

## Components (shadcn/ui names)

- **From the repo:** `Tooltip`, the lockup (`components/auth/auth-frame.tsx`'s `logo-lockup`), and the pane's frame (`preview-frame.tsx`, `task-preview.md`), which draws the stream onto a `<canvas>` or frames the native preview behind one interface.
- **New:**
  - `app/p/[token]/page.tsx`, the server side that resolves the link (ticket 20);
  - `components/previews/viewer-page.tsx`: the top bar, the stage and the footer;
  - `components/previews/viewer-ended.tsx`: the end blocks.

  The page's state is a union `"live" | "starting" | "not-running" | "dropped" | "expired" | "revoked" | "not-allowed" | "runner-too-old" | "unknown"`, with an exhaustive `switch` (`satisfies never`). The mode is `"watch" | "input"`.
- **Icons** (Lucide, stroke 1.75): `eye`, `mouse-pointer-click`, `clock`, `link-2-off`, `moon`, `lock`, `server-off`.

## Tokens

`globals.css`'s, both themes. `--bg` for the bars and the end blocks, `--surface` for the stage, `--line` for the hairlines, `--line-2` for the frame, the chips and the icon box, `--raise` for the tooltip and the not-running block. `--text`, `--muted` and `--faint` for the words, `--text-2` for `You can use it`. `--green` for live, `--teal` only for the frame's focus outline. No amber: nothing here waits on anyone. No `--primary`: the page has no main action.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--text` on `--bg` (the label, `Live`, the end block's title) | 17.4:1 | 17.5:1 | 4.5 |
| `--muted` on `--bg` (`a preview from Acme Corp`, the chips, the end block's body) | 9.6:1 | 8.1:1 | 4.5 |
| `--faint` on `--bg` (the port, the footer's line, the size) | 5.9:1 | 5.6:1 | 4.5 |
| `--text` on `--raise` (the tooltip) | 16.0:1 | 18.3:1 | 4.5 |
| `--green` on `--bg` (the live dot, beside its word) | 7.4:1 | 5.5:1 | 3 |
| `--teal` on `--surface` (the frame's focus outline) | 8.0:1 | 5.7:1 | 3 |
| The app inside the frame | the customer's own; ostra doesn't check it | | |

## Data it needs

From ticket 20's server side, and nothing more:
1. **The link:** resolved by the SHA-256 of its token. Its state (`active | expired | revoked`), its expiry (none for public), `allowInput`, and the organization's `publicPreviewLinks` for a public one.
2. **What the page may show:** the preview's label and port, the organization's name, the expiry and the mode. Not the task, its key, its project, its runner, or who made the link.
3. **The view:** a `viewId` for the stream and input routes, opened for the link, which ends when the link does. The first use writes `preview.link_first_used` once (F-073).
4. **For a link with input and a preview domain:** the one-time code and the preview host's `/.ostra/enter?code=…` URL (ticket 26).

## Differences from the current code

1. **No `/p/` route,** and no page outside the panel that streams anything.
2. **No signed-out page but sign-in, invitations and resets** (`app/sign-in`, `app/invite`, `app/reset`), which use `auth-frame.tsx`. This page uses only its lockup.
3. **Messages:** new keys under `previewViewer.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The visitor's width.** The shared page keeps the width a member chose, and a phone visitor sees it scaled (as drawn). Or a link with input may also pick a width preset, which changes it for everyone watching. Recommended: as drawn; input is clicks and keys, not the page's size.
2. **Named people** (members picked by name, F-142) open the same viewer layout, signed in, at a route that checks their session (`/previews/{previewId}`), rather than the task page they can't open. Recommended: yes, the same component with the same words, so a named person sees that preview and nothing else of the task.
3. **The lockup** on a page a client sees: kept, as drawn, since the link is ostra's own URL. A self-hoster's own logo on this page would be a later setting.
4. **An unknown token** says nothing about whether it ever existed (drawn as a separate state), while expired and revoked say which. Recommended: yes; the holder of a real token already knows it existed.

## Wrong in the image (build from this file)

- **`preview-viewer.webp`:** the tooltip shows at once on the pointer. Build it after 500 ms of hover, as every tooltip.
- **`preview-viewer-states.webp`, picture 1:** the frame's bottom corners show the app's own white under its grey body. That's the fixture app, not the frame; build the frame as specified.
- **The phone screens** are drawn without the browser's own chrome and without the safe-area insets. Pad the footer by `env(safe-area-inset-bottom)`.
