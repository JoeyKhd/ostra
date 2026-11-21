# Target: the native preview in the task's pane (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. Both render from `html/task-preview.html?pane=native`, the same page as the approved pane (`task-preview.md`), with the panel's own tokens and fonts. The app in the frame is `html/app-fixture.js`'s "Tally", demo data in the customer app's own colours. Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `preview-native.webp` | Acme Corp's install has a preview domain (`preview.acme.dev`). `CALC-192`'s pane shows `web :5173` **in your browser**: the app itself, framed from `5173-k3f9d2.preview.acme.dev`. The app sent `X-Frame-Options`, so a notice under the toolbar says ostra replaced it. The footer names the mode and the host, and offers `Use the box's browser`. |
| `preview-native-light.webp` | The same in the light theme. The app keeps its own colours. |

- **Route:** unchanged, the task page (`task-preview.md`). The mode joins the pane's URL state: `?pane=preview&preview=web&path=/history&view=native` (`view=stream` for the box's browser).
- **Shell:** the double sidebar (`app-shell.md`): the Projects space, the project panel, the task's live row selected. The page is the approved `task-preview-pane`, and only the pane's notice and footer change.
- **Features:** F-144 (the preview domain: "a preview opens in the member's own browser on `<port>-<previewId>.<domain>`, in the pane's frame and in a new tab"), beside F-141 (the pane, whose browser view stays one click away). The milestone 8 spec's section 13, target 8, and its demo's step 10. Facts: ADR 0068, "The native preview", and `context/research/live-previews.md`, sections 4 and 5.
- **Status: a proposed target, waiting for the maintainer's approval.** Ticket 26 builds it once it's approved.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

Without a preview domain, the pane streams pictures of the box's own browser (`task-preview.md`). That works on every install, but it's pictures: no devtools, no extensions, the box's fonts, and some lag. When the instance admin sets a preview domain (`instance-preview-domain.md`), the app can run in the member's own browser instead. The pane has to say:
1. **Which view this is:** the app itself in your browser, or the box's browser streamed. Both are live, and they look alike, so the words carry the difference.
2. **Where it really runs:** its own host, which a member can open in a tab and use devtools on.
3. **What ostra changed:** a framing header replaced so the panel can frame it, which a developer would otherwise chase as a bug.

## Layout (`preview-native.webp`)

The pane is the approved one (`task-preview.md`, "The pane"), 636 wide at 1440, with three changes:

1. **The toolbar** is unchanged. Two of its buttons act differently in this mode:
   - **`external-link`** (`Open in a new tab`) opens `https://5173-k3f9d2.preview.acme.dev/history` in a new tab, after its own one-time code (a cookie set in the frame is partitioned, so a tab needs its own handshake; ADR 0068). Its tooltip: `Open in a new tab · it signs you in on the preview's own host`.
   - **`camera`** (`Take a screenshot`) still asks the box's browser for the picture, so a screenshot is the same in both modes and lands in the thread as the member's (`task-attachments.md`).
2. **The framing notice,** under the toolbar, only when the proxy replaced a header on this preview's responses: 34px, padding `0 6px 0 12px`, a 1px `--line` under it, 13px `--muted`, one line, ellipsis.
   - `shield-check` 14px `--faint`, then `web sent X-Frame-Options. ostra replaced it: only this panel can frame the preview.` The header's name is Plex Mono 12.5px `--text-2`. When the app sent a CSP `frame-ancestors`, it reads `web sent a frame-ancestors policy. ostra replaced it: only this panel can frame the preview.`
   - At the right, a 24px `x` (`Dismiss`). Dismissed, it stays away for this preview in this browser (`localStorage`, per preview).
   - The full sentence, with the header's value, is its `title`.
3. **The viewport** holds an `<iframe>` in place of the stream's `<canvas>`, in the same frame element (1px `--line-2`, 8px radius, padding 10px on `--surface`):
   - `src` is the preview host's `/.ostra/enter?code=…`, which sets the preview's cookie and redirects to the path;
   - `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`, with no `allow-top-navigation`;
   - named `web :5173 at /history, in your browser`.

   The app runs in the member's browser: its pointer, keys, scroll and devtools are the browser's own, with no input relay. "Expand" resizes this same element and never moves it in the DOM, so the app keeps its state (ticket 26).
4. **The footer,** 32px, as the pane's:
   - **Left:** the green dot, `Live` in `--text` 500, then `--faint` `· in your browser ·` and the host in Plex Mono 12.5px `--muted` (`5173-k3f9d2.preview.acme.dev`), which ellipsizes in the middle when the pane is narrow.
   - **Right:** a ghost 26px button in `--teal`, `monitor` 14px and `Use the box's browser`. It switches this pane to the stream, and keeps the choice per member and per preview. In the stream, the same place reads `Open it in your browser` (`app-window`), only when a preview domain is set and its check has passed.
   - **No watchers' count** in this mode: each member's browser runs its own page, so there's no shared page to count. The box still stays warm while the pane is open and visible, as in the stream (F-141).
   - The runner's name and the view's size leave the footer in this mode; the app's own devtools show its size.

## The two views side by side

| | The box's browser (`task-preview.md`) | In your browser (this target) |
|---|---|---|
| Needs | nothing | `OSTRA_PREVIEW_DOMAIN`, its DNS record and certificate, and the check passed |
| Where the app runs | the box's Chromium, one page shared by every watcher | each member's own browser, a page of their own |
| Input | relayed: mouse, wheel, keys, pasted text | the browser's own, devtools included |
| Footer | `Live · the box's browser, streamed`, watchers, size, runner | `Live · in your browser · {host}` |
| On the HTTP carrier | 2 frames a second | not offered (ADR 0068) |
| The default | with no preview domain | with a preview domain whose check passed |

## Every state

| State | Picture | What shows |
|---|---|---|
| **Live, in your browser** | `preview-native` | As above |
| **Signing in** (the one-time code in flight) | not drawn | The frame shows the pane's starting block, shortened: spinner, `Opening web :5173 in your browser`, `Signing you in on 5173-k3f9d2.preview.acme.dev`. It lasts one redirect; after 10 s it turns into the failure below |
| **The handshake failed** (the code expired or was refused) | not drawn | The pane's none block: `circle-alert` `--red`, `Couldn't open it in your browser.`, the reason in `--muted` (`The sign-in code expired. Try again.`), `Try again` (outline), and `Use the box's browser` (teal) |
| **The browser keeps no cookie in a frame** (a partitioned cookie refused, ADR 0068's third spike outcome) | not drawn | In the frame: `This browser won't keep the preview's sign-in inside the panel.`, `Open in a new tab` (outline), and `Use the box's browser` (teal). The member's choice isn't changed for other browsers |
| **The app stopped answering** | not drawn | As the stream's: a top banner `web :5173 stopped answering at 14:58`, with `Restart web` and `Show the log`. The frame keeps whatever the app last drew |
| **The box is asleep, or the task ended** | not drawn | As the stream's (`task-preview-stopped`): the last screenshot behind the card, `Wake to preview` or `Start the app`. Once it's live, the pane comes back in the member's chosen view |
| **The runner on the HTTP carrier** | not drawn | No native preview over it (ADR 0068). The pane shows the stream, and the footer's right reads `In your browser isn't available: build-fleet-03 reaches ostra over HTTP only.` in `--faint`, with no button |
| **The preview domain's check failing** | not drawn | The pane shows the stream, and `Open it in your browser` isn't offered. Instance admins see a teal `Previews in settings` there instead (`instance-preview-domain.md`) |
| **No framing header replaced** | not drawn | No notice: the viewport starts under the toolbar |
| **A link with input, on the viewer page** | not drawn | `preview-viewer.md`: the viewer page frames the native preview the same way |
| **Light** | `preview-native-light` | `../m7/light-home.md`'s tokens. The app's own colours don't change |

## Phone

As the pane's phone layout (`task-preview.md`, "Phone"), under the shell's top bar with its menu button (`app-shell.md`, "Phone"). The frame takes the phone's width, the notice wraps to two lines, and the footer's host moves under `Live · in your browser` on its own line. `Use the box's browser` moves into the pane's `ellipsis` menu.

## Keyboard

- The toolbar, the notice's `x` and the footer's button are in the pane's tab order: toolbar → notice → frame → footer.
- **The frame** is an ordinary focusable `iframe`. While it has focus, keys go to the app and the panel's single-key shortcuts are off, as in the stream. ⌘. (Ctrl+. elsewhere) hands focus back to the toolbar: the panel listens for it on its own document, and the frame's document is the app's, so the pane moves focus out when the frame's `blur` follows that chord. *(The panel can't read keys inside a cross-origin frame. If the chord can't be caught there, Shift+Tab out of the app is the way back; the `?` sheet says so for this mode.)*
- `f` and `esc` for Expand, and `p` for Preview and Properties, are unchanged.

## Components (shadcn/ui names)

- **From the repo:** the pane (`components/tasks/preview-pane.tsx`), `Button`, `Tooltip`.
- **New:**
  - `preview-frame.tsx` (from `task-preview.md`) gains its `iframe` branch behind the same interface as the `<canvas>`: `{ kind: "stream" } | { kind: "native", host, enterUrl }`, with an exhaustive `switch`;
  - `preview-framing-notice.tsx`;
  - the pane's view choice, `"stream" | "native"`, kept per member and preview.
- **Icons** (Lucide, stroke 1.75): `shield-check`, `x`, `monitor`, `app-window`, `external-link`, `circle-alert`.

## Tokens

`globals.css`'s, both themes, as the pane's. The notice is `--bg` with `--muted` text and `--text-2` for the header's name. `--teal` is `Use the box's browser` and the frame's focus outline; `--green` is live. No amber.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--muted` on `--bg` (the notice, the host) | 9.6:1 | 8.1:1 | 4.5 |
| `--text-2` on `--bg` (the header's name) | 13.5:1 | 13.2:1 | 4.5 |
| `--faint` on `--bg` (`· in your browser ·`) | 5.9:1 | 5.6:1 | 4.5 |
| `--teal` on `--bg` (`Use the box's browser`) | 8.4:1 | 6.1:1 | 4.5 |
| `--green` on `--bg` (the live dot, beside its word) | 7.4:1 | 5.5:1 | 3 |
| The app inside the frame | the customer's own; ostra doesn't check it | | |

## Data it needs

1. **Whether a preview domain is set and its check passed** (the instance's, `instance-preview-domain.md`), and the runner's carrier.
2. **`previews.enter`** (ticket 26): for a member who can open the task, the one-time code (60 s, single use, bound to the member, the task, the port and the lease) and the preview host's `/.ostra/enter?code=…` URL. A second call for "Open in a new tab".
3. **The framing report:** the proxy records, per preview, which framing header it replaced (`X-Frame-Options`, `frame-ancestors`) and its value. Names and values of the app's own headers only, never a cookie or a body.
4. **The member's view choice** per preview.

## Differences from the current code

1. **The pane doesn't exist yet** (`task-preview.md`, ticket 21). This target adds its second view.
2. **The panel's CSP** gains `frame-src https://*.{preview domain}` only when the domain is set (ADR 0068). Today it frames nothing.
3. **Messages:** new keys under `task.preview.native.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The default view with a preview domain:** in your browser (recommended, as drawn), or the box's browser with "Open it in your browser" one click away. In your browser is the reason to set a domain.
2. **The watchers' count** isn't shown in this mode (as drawn), since nobody shares a page. Or count everyone with the pane open in either view. Recommended: as drawn; a count beside a page nobody else sees reads as if they did.
3. **The framing notice** shows until dismissed, per preview (recommended), or once per member ever.
4. **`Take a screenshot`** uses the box's browser in both views (recommended, as drawn in the spec), so screenshots are comparable and keep the browser's name; or it captures the member's own frame, which a cross-origin frame doesn't allow without the app's help.

## Wrong in the image (build from this file)

- **`external-link`'s tooltip** isn't drawn: it would cover the notice at this width. Build it as written above.
- **The footer's host** isn't truncated in the picture because it fits at 636. Build the middle ellipsis for narrower panes.
- **The app's own scrollbars** aren't drawn. In the build they're the member's browser's, inside the frame.
