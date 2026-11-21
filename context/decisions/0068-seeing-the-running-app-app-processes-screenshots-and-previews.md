# Seeing the running app: app processes, screenshots and previews through core

**Status:** accepted (2026-11-21). The maintainer said "yes" to the three features of milestone 8 on 2026-11-21, moved F-121 forward into v1, and answered three of `research/live-previews.md`'s questions on 2026-11-20 and 2026-11-21:
- the preview domain is welcome but optional;
- who can open a preview is configurable;
- a frontend and its API are app processes the environment declares, with the dev-server proxy pattern.

The lead's five recommendations got the maintainer's "yes" as a group the same day: a box stays warm while someone watches, up to 60 minutes; a stopped task's app can start without an agent turn; links for people outside the project are watch-only unless the link allows input; webhooks come in through forwarders that dial out; and no third-party tunnel is built in. The lead settled the research's technical questions by its recommendations (the `Host` rewrite, several replicas, the HTTP carrier, and the rest under "Decided by the lead" below). The maintainer can still change any of them. Settles Q68's placement and Q296 to Q314. Covers F-121, F-140, F-141, F-142, F-143 and F-144. **Amends** ADR 0025 (an executor declares `boxBrowser` and `appReach`), ADR 0029 (what the box's browser is on each executor, with no new allowed difference), ADR 0034 (a second connection for a preview's bytes, and forwarding between replicas for it), ADR 0035 (one more streamed response while a preview pane is open), ADR 0038 (the environment's app processes), ADR 0039 (the idle timer while someone watches, and a box started for the app alone) and ADR 0043 (screenshots and recordings as blobs). **Amended 2026-11-21** after the two spikes: the box's app is dialled at `localhost`, trying IPv6 and IPv4, not at `127.0.0.1`; and webpack-dev-server's HMR in the native preview needs `client.webSocketURL` when a project sets its port.

**Two spikes gate the numbers,** not the shape (milestone 8's tickets 07 and 08):
- `spikes/box-browser-stream/` measures the browser view on a small box;
- `spikes/preview-through-core/` runs HTTP/2 over a WebSocket through core to a real Vite and Next.js 16 dev server.

What each one does if it fails is under "If a spike fails".

**Both ran on 2026-11-21, on Windows, and passed** (`research/spike-box-browser-stream.md`, `research/spike-preview-through-core.md`):
- **The browser view:** 15 frames a second at 1280×800 while typing, with a click back through core in 56 ms at p95, and the box's browser on 0.5 to 0.8 vCPU.
- **The tunnel:** Vite's and Next.js 16's pages and HMR through Node's `http2` over the WebSocket, with the rewrite on and no project change. A cold page load took 30 ms more than direct. The partitioned cookie held in a cross-site frame on Chrome, Edge and Firefox.

Neither fallback is needed, and `yamux-js` isn't added. The Linux container and Safari parts wait for their jobs.

## Why

Everything a task builds runs in its box, on a runner that only dials out. A reviewer today sees the diff and never the app. The research found that every comparable product either ships screenshots and recordings (Copilot's coding agent, Codex cloud, Jules, Cursor) or a live preview on an origin of its own (Devin, Replit, Codespaces, Coder, E2B, Daytona), and that self-hosted products ask for a wildcard name and certificate to give an app its own origin (`research/live-previews.md`, summary and §1). The maintainer wants it working on every install with no setting, and the wildcard optional.

So there are four layers, each working without the next:
1. **Screenshots and recordings** in the task's timeline (F-121). No setting, every executor, every carrier, and they outlive the box.
2. **The browser view** (F-141): the box's own browser streamed into the task's pane as pictures, with the member's input sent back. No setting.
3. **`ostra preview`** (F-143): a port of the box served on the member's own `localhost`. No setting.
4. **The native preview** (F-144): the app itself in the member's own browser, on its own host under the preview domain. Only when an admin sets one.

Sharing (F-142) works across the second and fourth.

## The app's processes

**The environment gains a list of app processes** (F-140), beside ADR 0038's services. A service is a container from an image, such as a database. An app process is the project's own program, run from its repo:
- `name`: lowercase letters, digits and dashes, unique in the environment;
- the repo it runs in, and a `folder` inside it (repo-relative, `.` by default);
- the `command` that starts it and must keep running;
- the `port` it listens on;
- a `ready` check: an HTTP path that answers below 500, a command that exits 0, or the port accepting a connection. It's tried every 2 s for at most 120 s *(working values)*;
- a `label` for people ("Web", "API", "Docs");
- `primary`: at most one process is the **primary preview**, which the pane and the screenshots open first;
- `hostRewrite`: on by default (below).

**A service can be a preview too.** A service gains an optional preview label, for one with a web UI, such as Mailpit's 8025 or Adminer. It's private by default, like every preview.

**The runner owns the processes.** It starts them in the box, in order of the list, with the repo's variables and secrets as the setup script gets them (ADR 0038), and keeps each one's output in `.ostra/app/<name>.log` in the task's config folder, never in a repo. A process that exits is reported with its exit code and the log's last lines, kept as a task blob and never logged. The runner stops them with the box. The agent starts them with the `start_app` tool, and the runner starts them itself for the after-turn screenshots, for a preview someone opens, and for "Start the app".

**Each process gets the others' in-box addresses**, as Railway's references and Codespaces' variables do (§8.1):
- `OSTRA_APP_<NAME>_URL`, such as `http://localhost:3001`, for each app process;
- `OSTRA_SERVICE_<NAME>_URL`, such as `http://mailpit:8025` on `docker` and `http://localhost:8025` on `kubernetes`, for each service with a port.

`<NAME>` is the name upper-cased with dashes as underscores. These are right for server-side calls under every design and for the box's own browser. **No browser-facing URL is injected:** an inlined client variable can't point at the API for the member's browser and the box's browser at once (§8.2).

**One origin is the convention.** ostra's instructions to the agent say: keep the browser on the primary's origin, and put the API behind the frontend's dev-server proxy (Vite's `server.proxy`, Next.js rewrites). It's the only pattern that works in screenshots, the browser view, `ostra preview` and the native preview alike (§8.2). Onboarding proposes it. The native preview offers no cross-host CORS between a task's previews in this milestone (Q310).

**Three ways a process gets in the list:**
1. **Declared** by a project admin on the environment page.
2. **Proposed by onboarding** (F-113). Detection (F-112) reads `devcontainer.json`'s `forwardPorts` and `portsAttributes` (a label, and `onAutoForward: openPreview` as the primary's hint), `.gitpod.yml` and `.replit` ports, `package.json`'s `dev` and `start` scripts, and the port and `server.proxy` keys of a Vite config, which are read as text, never run. The onboarding task starts each process, checks its ready check, takes a screenshot of the primary, and hands the list in through `propose_environment`. A project admin accepts it, as the rest of the environment (ADR 0038).
3. **Announced by the agent** mid-task, with the `show_preview` tool, for a port it started itself: a port, a label, a path and whether it's the primary. It's scoped to the task. "Keep it" on the pane turns it into an environment proposal for a project admin.

**Detected ports come later** (Q313). A scan of listening sockets is per network namespace, and on a macOS `host` runner there's no per-task set to filter it by (§5.4). Previews reach declared and announced ports only, on every executor alike.

## The box's browser

**Chromium, beside the app** (Q311). It must share the app's network namespace, so `http://localhost:5173` and the frontend's own calls to `localhost` work in it (§8.2's table):
- **`docker` and `kubernetes`:** in the agent's container, from the base image. The init starts it with `--remote-debugging-pipe`, so only the init holds the DevTools connection and the agent can't attach to it. The sidecar drives it over the bridge, on a channel of its own, so frames never queue behind a kill's reply (ADR 0029, "The bridge has deadlines"). The base image gains Debian's `chromium` package at a pinned version, with its notices (F-039).
- **`host`:** a process in the task's containment unit (ADR 0029), driven by the runner over the same pipe. The runner uses `OSTRA_RUNNER_BROWSER` when set, else the first Chromium-family browser it finds (Chrome, Chromium, then Edge, which every Windows machine has). With none, it downloads Chrome for Testing's `chrome-headless-shell` at the version pinned in its release, checks its SHA-256, and keeps it in its data folder. `OSTRA_RUNNER_BROWSER_DOWNLOAD=false` turns the download off; the runner then reports no browser, and the panel says how to fix it.
- **An organization's own base image** may lack it. The runner reports "no browser in this box", the tools say so to the agent, and the environment page warns.

**In a box, the browser runs without Chromium's own sandbox, inside the box's** (amended 2026-11-21 by milestone 8's ticket 11). Chromium's Linux sandbox makes each renderer's PID and network namespaces through an unprivileged user namespace or a setuid helper, and refuses to start without one. A box allows neither: Docker's default seccomp profile and containerd's `RuntimeDefault` refuse a namespace flag to `clone` and refuse `unshare` without `CAP_SYS_ADMIN`, and `no-new-privileges` (`allowPrivilegeEscalation: false` in a pod) makes a setuid helper gain nothing. Granting either would loosen the box for every process in it, the agent's shell included, and a renderer that escaped would be the agent's user in the agent's container, which the agent's shell already is (ADR 0031: only a box contains the agent). So the init adds `--no-sandbox`, and `--disable-dev-shm-usage` for a container's 64 MiB `/dev/shm`, and nothing else (`adapter-executor-docker/src/init/box-browser-flags.ts`, with its sources). On `host` the machine's browser keeps its own sandbox. The base image pins Debian's `chromium` by version, with Debian's snapshot archive as its fallback source once bookworm-security moves on, and the `host` download pins Chrome for Testing's headless shell by version and SHA-256 per platform (`adapter-executor-host/src/headless-shell.ts`).

**This adds no allowed difference to ADR 0029.** The task does the same thing on every executor: the same tools, the same events, the same blobs, the same view. On `host` the browser is the machine's, as every tool on `host` is the machine's, so a picture's fonts or rendering can differ. Each attachment records the browser's name and version.

**What the browser can reach is what the box can reach.** On `docker` that's the box's network only: a page that loads fonts or scripts from a public host shows without them in a screenshot and in the browser view. On `kubernetes` and `host` it reaches public hosts. That follows from ADR 0029's fourth difference and adds none. The native preview loads them, since it runs in the member's own browser.

**It holds nothing secret.** No cookie of ostra's, no token, no profile from the machine: a fresh profile in a temporary folder per box, removed with it.

## Screenshots and recordings (F-121)

**The agent takes them** with ostra's MCP tools, served by the sidecar like `set_pull_request_text` (ADR 0049):
- `take_screenshot`: a process or a port, a path, a width preset (desktop 1440×900, tablet 834×1112, phone 390×844) or a size, full page or not, and a caption. It returns the attachment's number.
- `record_app`: the same target, up to 20 steps from a closed list (`goto`, `click` on a CSS selector or text, `fill`, `press`, `scroll`, `wait` for a selector or a time), at most 30 s *(working values)*, and a caption.

They run in a page of their own, never the shared page a member watches.

**ostra takes them after a turn** when the environment's "Screenshots after each turn" is on, which it is by default once the environment declares a primary. After a turn that changed a repo, the runner starts the app processes that aren't running, waits for the primary to be ready, and takes each of the environment's routes (up to 5, the primary's `/` by default) at the environment's widths (desktop, and phone if chosen). A process that doesn't get ready is reported with its log, and the turn's end isn't held by it.

**What's kept:**
- A screenshot is a PNG of at most 8 MiB and 10,000 px high *(working values)*.
- A recording is a **frame reel** (Q312): its JPEG frames at up to 10 a second, their times and its steps, in one blob of at most 32 MiB *(working values)*. The panel plays it. There's no video encoder in the box, so no MP4 or WebM yet.
- Both go up on the bulk path (ADR 0043) as blobs of the task, purposes `app-screenshot` and `app-recording`. An `attachment.added` event names the blob, the kind, the source (`agent`, `after-turn` or `member`), the process or port, the path, the size, the browser and the caption. The caption is the agent's text, so it's never logged.
- At most 20 attachments a turn *(working value)*. Past that the tool says so.

**Where they show:**
- **In the thread,** at their place in the turn, with a lightbox and the recording's player. They survive the box stopping, a reload and a reopen in a fresh box, because they are blobs, not files in the box.
- **On the PR:** a line in the body, "Screenshots: N in ostra", linking to the task's attachments. GitHub has no API to put an image in a PR body, and ostra's blob links need a sign-in (ADR 0043), so a screenshot never becomes a public URL.
- **In a refine draft and in findings:** "Add to draft" puts one among the draft's images (milestone 6's `RefineDraftImage`). A finding may name an attachment (`attachmentIds` on the finding, at minor 7), and the review screen shows it beside the finding.

**Members can take one too,** from the browser view, with the source `member`.

## The browser view (F-141)

**The pane** sits beside the thread on the task's page. It holds the task's previews, primary first, each with its label and its source (declared, proposed, announced); a path field; reload; a width preset; "Expand", which widens the same pane to the page's width without reloading it; "Take a screenshot"; and a line that says where the box stands and which view this is. When no view can run, it says why and shows the latest screenshot.

**How it works:** the box's browser loads the preview at `localhost`, and the sidecar streams it with DevTools' `Page.startScreencast` (JPEG, quality 60, at most 1440×900 and 15 frames a second *(working values)*), with `maxFramesInFlight` and frame acks as the back-pressure. The member's mouse, wheel, keys and text go back as `Input.dispatchMouseEvent`, `dispatchKeyEvent` and `insertText` (§7, Design B). Pasting text into the page works; files and the member's clipboard don't.

**One page per preview, shared by everyone watching it** (Q314). Two members see the same page, like a shared screen, and the width is the last one chosen. Any member who can open the project may click and type in it. It's the app, not the agent: the agent's own screenshots use their own page. A count shows how many are watching.

**Nothing of the app runs in the member's browser.** The pane draws pictures, which the panel's `img-src blob: data:` already allows. So it needs no origin, no DNS and no host check.

**The bytes stay off the session.** The panel opens one streamed response per open pane, `GET /api/previews/<viewId>/stream` on the web app, which relays core's stream: length-prefixed JPEG frames, read with `fetch`'s body reader. Input goes up as batched `POST`s. This is one more connection beside ADR 0035's one stream per tab, only while a pane is open. Next.js route handlers can't upgrade to a WebSocket, so it isn't one (ADR 0035).

## What a preview may reach

A preview reaches only ports that belong to the task:
- its app processes' ports;
- the ports it announced;
- its services marked as previews.

It never reaches the sidecar's ports (the key proxy, the git proxy, the MCP proxy, its control API), OpenCode's loopback port, the browser's own, or ports below 1024 *(working value)*. Without that rule a preview on `kubernetes` (one shared `localhost`) or on `host` (the machine's loopback) could reach what isn't the app (§7). A service is reached by its name on `docker`, at `localhost` on `kubernetes`, and not at all on `host`, which runs none (ADR 0029's first difference).

## Who can open a preview (F-142)

**A level per preview,** set by a member who can open the task, and failing closed:
- **The project's members**, the default. A restricted project's preview is its members' and the organization's admins' (ADR 0026).
- **Named people:** members of the organization a member picks. They see that preview and nothing else of the task, even when the project is restricted.
- **An expiring link:** anyone with it, until it expires (24 hours by default, 7 days at most *(working values)*) or is revoked.
- **Public:** a link that doesn't expire, only where an organization admin has allowed public links (off by default). Revoking it ends it.

**A link is watch-only unless it allows input** (Q301). Someone outside the project sees the browser view on a viewer page the panel serves to signed-out people: the picture, the preview's label and the link's expiry, nothing else of the task. A link that allows input lets them click and type in the shared page. When a preview domain is set, a link that allows input opens the native preview instead.

**Fail closed.** A runner below protocol minor 7, a level the organization doesn't allow, or an expired or revoked link gives no view, and the page says why. ostra never opens wider than asked, unlike Ona's CLI, which "opens the port for everyone instead" when a runner can't enforce privacy (§7).

**Audited** (ADR 0054): a level changed, a link made or revoked, and each link's first use.

**A link is a bearer token,** 32 random bytes kept as a hash. It never goes in a log line.

**As built (ticket 20, 2026-11-21):**
- **One level at a time.** The share menu's four levels are the row's `members` or `named`, plus the preview's links. Setting the level to the members or named people narrows the preview away from its links, so their active links are revoked, each audited, and every view of someone who no longer qualifies closes in the same transaction. Revoking a link closes its views at once, and turning public links off closes every public link's view; turned on again, a public link not revoked works again.
- **Who may share:** any member who can open the task, as above. (`task-preview.md`'s open point 4 recommends the driver and the project's admins; the targets' approval can still narrow it.)
- **A named person** gets `previews.open` for that preview, watch-only, and the heartbeat and close of their own view. Every other procedure of the task answers them as it answers anyone the project doesn't list: NOT_FOUND.
- **The viewer page** reaches only `previews.link.*` (open, heartbeat, close), each with the link's token, and the stream and input routes with the token in `x-ostra-preview-link`. A token that opens nothing counts against its address: 20 a minute, then the address waits out the minute; the page's opens count apart, 30 a minute *(working values)*. An unknown token says nothing of whether it existed; an expired or revoked one says which.
- **The routes** check the member's session or the link's token, that the view is the one they opened, and their access again on every request, then ask core with a panel token for that one view and viewer. A watch-only viewer's input stops at the panel, before core, which drops it again. Input is JSON from the panel's own origin only.

## Warm while watched, and starting the app

**A watched box stays warm, up to 60 minutes** (Q299, ADR 0039 amended). While a pane or a viewer page is open and visible, the panel sends a heartbeat every 30 s *(working value)*. The box's 15-minute idle timer doesn't end it while a heartbeat came in the last 2 minutes, for at most 60 minutes after its last turn ended or its app started (`OSTRA_PREVIEW_WARM_MINUTES`). The app's own HMR socket never counts as watching: CodeSandbox and Cloudflare both learned that it keeps a sandbox awake for nobody (§1.5). Past the cap, the box idles out as ADR 0039 says, and the pane shows the last frame and "Start the app". The compute isn't counted: budgets count model spend only (ADR 0042).

**"Start the app" starts a box with no agent turn** (Q300). It's a dispatch with the purpose `app`:
- The box starts as for a reopen, from the snapshot, the task's branches and its hidden ref (ADR 0039).
- It runs the setup and starts the app processes.
- It launches no agent and makes no model call, so the key proxy counts nothing.
- It's admitted like any of the task's boxes, so it takes a slot.

Any member who can open the task may start it, and each start is an audit entry. A member's message while it runs starts an ordinary turn in that box. Nobody's message makes it idle out as above.

**How core holds them** (amended 2026-11-21, ticket 19, building on the code as it is):
- **The open view is the hold.** The idle timer is the runner's (`limits.idleMinutes`, between turns, ADR 0039), and no command moves it, so the runner doesn't end a box at its idle timer while one of the box's views is open (a `preview.open` with no `preview.close` yet; ticket 18). Core decides when views close: `preview.views-sweep`, once a minute by the `Clock`, closes a view after 2 minutes with no heartbeat, and every view of a box past the warm cap, each with `preview.close` to the box's runner. Once the last one closes, the runner's timer counts from the turn's end as before, so a box past it stops at once. A new view of a box past the cap is refused, so it can't hold the box again. Only `previews.heartbeat` writes `Box.previewWatchedAt`: the frames and the app's own sockets never do.
- **"Start the app" doesn't move the task.** The `app` lease is a box beside the task's state (in review, needs you, stopped): its session starts with no agent, and the dispatch passes no budget gate and no provider's hold or cap, and goes only to a runner at minor 7. It's admitted at once or not at all: with no runner to take it now, nothing is written and the pane says so (`no-runner`, or the runner needing an upgrade). A declined or timed-out offer ends the lease with no requeue. Pressed while the box runs, it sends `app.start`.
- **A message on an `app` lease** turns that same lease and session into a turn: the lease's purpose becomes `turn`, the message goes to the box as a `steer` (the runner launches the agent then), and the task moves as a reopen would (queued, then preparing, then running at the turn's start), through the budget gate as any turn. A merged task reopens as before, in a fresh box.

## The preview connection (ADR 0034 amended)

**A preview's bytes never ride the session.** The session carries only control: the task's previews (`preview.list`), and the commands that open and close a view. The sidecar, or the runner on `host`, opens a second connection only when someone opens a view: `wss://<core>/runner/v1/preview?view=<viewId>`. It authenticates with the box's task token (on `host`, the runner's own access token) and the lease epoch, so a stale epoch is refused, as events are. It carries binary frames, never JSON-in-base64 (§2.1). An idle box holds nothing extra.

**Two modes on it:**
- **`stream`**, for the browser view: JPEG frames up; viewport, navigation and input down; acks both ways.
- **`tunnel`**, for `ostra preview` and the native preview: one HTTP/2 connection with core as the client and the sidecar as the server, from Node's own `http2` over the WebSocket's duplex stream (§2.1).
  - A native preview's request is an HTTP/2 request, and a browser WebSocket is an RFC 8441 extended CONNECT.
  - `ostra preview`'s connections are plain HTTP/2 `CONNECT` streams to the port, raw bytes.
  - HTTP/2's per-stream windows and the WebSocket's `bufferedAmount` are the back-pressure.

**On `docker`,** the agent's container has its own loopback, so the init runs a forwarder for the tunnel: it listens on the box network at a port it picks, takes connections only from the sidecar's address, and dials `localhost:<port>`. The app's default binding to `localhost` then works (§5.3). On `kubernetes` the sidecar dials the pod's `localhost`. On `host` the runner dials `localhost`. Each tries IPv6 and IPv4, since a dev server told `localhost` may listen on `::1` only: Vite and webpack-dev-server did in spike 08 (amended 2026-11-21; `research/spike-preview-through-core.md` §4.2).

**Several core replicas forward preview streams** (Q305). ADR 0034 set replica-to-replica forwarding aside for commands, which Postgres routes. A byte stream at page-load rates can't go through Postgres. So:
- each preview connection writes a presence row naming its replica's internal address (`OSTRA_CORE_REPLICA_URL`; by default the replica's first non-loopback address and core's port; the Helm chart sets the pod's IP);
- a replica that gets a viewer's, a CLI's or a preview host's request for a view another replica holds forwards it there, signed with an HMAC under the secrets key every replica shares;
- a replica refuses a forwarded request it can't verify;
- a one-machine install never forwards.

As built (ticket 19): the presence is the view's `PreviewView.replicaUrl`, written by the replica that takes the box's connection (on the HTTP carrier, the first frames) and cleared when it goes. A forwarded request carries `x-ostra-replica-signature` and is taken on that alone, since the forwarding replica checked the panel's token; a signed request is never forwarded again. A frame is acked to the box once every stream on the holding replica took it, a forwarded stream among them, so a slow member slows the box's browser rather than queueing frames in core.

**The HTTP fallback carrier** (Q306). A runner on the carrier gets no tunnel: no native preview and no `ostra preview`, because RFC 6202's bounds make a dev server's hundreds of module requests over long polls a poor preview (§2.1). The browser view works over it at 2 frames a second at most *(working value)*: frames go up in `POST /runner/v1/preview/frames` and input comes down the long poll as `preview.input` commands. The pane says the runner reaches the server over HTTP only. This is a difference by network, not by executor, so it isn't one of ADR 0029's.

## `ostra preview` (F-143)

`ostra preview <task> [port] [--local <port>]` serves a preview's port on the member's own `http://localhost:<port>`, as `coder port-forward`, `devin forward` and Cursor's forwarding do (§7).
1. The CLI session (F-103) asks the web app for a one-time ticket (60 s, bound to the member, the task and the port), and the address of core.
2. The CLI opens `wss://<core>/cli/v1/tunnel?ticket=…`. Core is where runners already connect, so the member's machine reaches it the same way.
3. Each local TCP connection becomes one `CONNECT` stream through core to the box.

It defaults to the primary's port, and to the same local port when that's free. It's for members who can open the task, never for a link. No DNS and no host check are involved, since the host is `localhost`. It needs the tunnel, not the preview domain. It opens in a tab, never framed in the panel, which Chrome's local-network permission would block (§4.5).

## The native preview (F-144)

**Only with a preview domain.** `OSTRA_PREVIEW_DOMAIN` is unset by default (Q296). With it unset, the pane shows the browser view, and screenshots and `ostra preview` work as before. A self-hoster who sets it adds:
- one wildcard DNS record to the ingress in front of core;
- a wildcard certificate (Let's Encrypt issues those only through DNS-01);
- WebSocket upgrades passed on those hosts, as runners already need.

The docs recommend a registrable domain of the preview's own, as v0, Cloudflare and Google advise, and allow a subdomain of the panel's domain with a warning (Q307). A development install can use `preview.localhost` (§3.5). The spike checks how browsers treat it.

**The host:** `<port>-<previewId>.<preview domain>`, one label. `previewId` is 128 random bits in lowercase base32. It belongs to the task, not the box, so the URL survives a reopen on a fresh box. It isn't a secret. Core answers a preview host only with the preview proxy, and never serves its own routes on one.

**The handshake** (the Coder, Ona, Modal and CodeSandbox pattern, §4.4):
1. The panel asks for the preview. Core checks that the member can open the task, or that the link is valid.
2. Core mints a one-time code: single use, 60 s, bound to the member or the link, the task, the port and the lease epoch.
3. The browser goes to `https://<host>/.ostra/enter?code=…`. Core sets `__Host-ostra-preview` there: HttpOnly, Secure, and `SameSite=None; Partitioned` when the preview domain is another site, `Lax` when it's the panel's site. Then it redirects to the path.
4. Every request checks the cookie. It lives at most as long as the member's panel session, or the link, and at most 12 hours *(working value)*. Core checks membership and the lease again on each new connection and every 5 minutes.

The cookie set inside the pane's frame is a partitioned one, so "Open in a new tab" makes its own handshake (§4.5).

**What the proxy does on every request:**
- It removes its own cookie and every `X-Forwarded-*` the client sent.
- It never passes the member's identity to the app.
- It checks `Origin` on WebSocket upgrades: it must be the preview's own host.
- It rewrites `Host` and `Origin` to `localhost:<port>`, and `Location` back to the preview host, as Devin does (Q304, §5.1). So Vite, Next.js and webpack-dev-server pass their host checks with no project change. Vite's and Next.js's HMR follow the page's host. webpack-dev-server's follows it only with `client.webSocketURL: "auto://0.0.0.0:0/ws"`: when a project sets its port or host, its client dials that port directly, past the proxy, and the docs say so (spike 08, `research/spike-preview-through-core.md` §3.3). A process with `hostRewrite` off gets the real host in `Host` and in `X-Forwarded-Host` and `X-Forwarded-Proto`, for an app that builds its OAuth callback from the host (§8.3).
- On a link for people outside the project, it keeps the browser's `Origin` on WebSocket upgrades, so a dev server's own check still guards a channel that writes files, such as Storybook's.
- It removes `X-Frame-Options`, and sets `frame-ancestors` to the panel's origin only, replacing any the app sent. The pane says it did. So helmet, Rails, Django and Spring apps show, and no other site can frame the preview.

**The panel's side:**
- The CSP gains `frame-src https://*.<preview domain>` when the domain is set, and nothing wider.
- The panel keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY` for itself.
- The iframe is `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`, with no `allow-top-navigation`. `allow-same-origin` is safe because the origin isn't the panel's, and without it Next.js refuses the app's `Origin: null` (§4.5, §5.1).

**The panel's own defences, checked by the same tickets:**
- its session cookie carries `__Host-` or is host-only;
- nothing that authenticates a member is scoped to the wildcard parent;
- the panel refuses a state-changing request whose `Origin` isn't its own;
- every WebSocket core serves checks `Origin`.

These are the lessons of Gitpod's CVE-2023-0957 and CVE-2024-21583 and Coder's GHSA-5g4w-3vw9-478w (§4.3).

## Webhooks into the app, and tunnels

**Webhooks come in through forwarders that dial out** (Q302): `stripe listen --forward-to localhost:4242/webhook`, `gh webhook forward`, smee, the Svix CLI. ostra has no entry point that forwards the internet to a task's port, because that would open a door into agent-written code. The forwarder's login or key is an environment secret, which the code under test can see (ADR 0030). A forwarder needs public egress from the agent's container, so it runs on `kubernetes` and `host`. On `docker` it waits for network allowlists (F-052, later). That follows from ADR 0029's fourth difference and adds none. The docs say so. This is about the webhooks the app under development receives (a payment provider calling the app's handler), not webhook automations (F-139), which start a task from a request to an ostra URL and never reach a task's app.

**No third-party tunnel is built in** (Q303). cloudflared, ngrok and Tailscale Funnel each need an account, an egress exception or the vendor ending TLS, and each puts the vendor's access rules in place of ostra's (§2.2). A self-hoster whose core sits behind NAT can still put core itself behind a tunnel of their own, which the docs already allow. A tunnel adapter kind stays possible later, never as the default.

## Decided by the lead

On the research's recommendations, 2026-11-21, which the maintainer can change:
- **The `Host` and `Origin` rewrite is on by default,** off per app process, and the browser's `Origin` is kept on WebSocket upgrades for links for outside people (Q304).
- **Replicas forward preview streams** to the one that holds them (Q305).
- **The HTTP carrier** gets the browser view at 2 frames a second and no tunnel (Q306).
- **A preview domain of its own is recommended,** and a subdomain of the panel's is allowed with a warning (Q307).
- **App processes are a second list** beside services, and a service can be a preview (Q309).
- **Agents are told to keep one origin;** there's no cross-host CORS in this milestone (Q310).
- **The browser is Chromium:** Debian's in the images, the machine's or a pinned download on `host` (Q311).
- **Recordings are frame reels** (Q312).
- **Detected ports come later** (Q313).
- **One shared page per preview** in the browser view, with input from any project member (Q314).

## If a spike fails

- **The browser view costs too much on a small box** (2 vCPU, 4 GB), or the frames can't keep a readable rate through core: lower the defaults first (8 frames a second, quality 50, 1280×800). If it still fails, the pane refreshes a screenshot every 2 s and the member's clicks go through a "click here" overlay. The levels, the links and the warm rule stay.
- **HTTP/2 over the WebSocket doesn't carry Vite's or Next.js's HMR,** or extended CONNECT fails: the tunnel uses `yamux-js` (MIT, interoperable with Go's yamux) instead of `http2`, which needs the maintainer's yes for the dependency. Until then, `ostra preview` and the native preview wait, and the browser view, the screenshots and sharing ship without them.
- **A partitioned cookie doesn't hold in a frame** on one major browser: the pane shows "Open in a new tab" there instead of framing it, and the browser view stays its default.

## Considered options

- **Path-based previews under the panel's domain.** Rejected: they break Vite, React and Next.js dev servers, and put agent-written code on the panel's origin with the member's cookies (§3.2, §4.1).
- **A second port on the panel's host.** Rejected: cookies aren't isolated by port, and it needs an inbound port (§3.3).
- **A third-party tunnel as the default,** or any tunnel built in. Rejected above.
- **Publishing the box's port** (a Docker published port, a Kubernetes Ingress). Rejected: it breaks "nothing connects in to a runner" and skips ostra's access checks (§2.3).
- **Preview bytes inside the session's JSON frames.** Rejected: base64 grows them by a third, and every frame would count against the session's credit window (§2.1, ADR 0034).
- **A token in the preview host.** Rejected: the host travels in clear in SNI and DNS (§4.4).
- **Playwright in the runner.** Rejected for now: a dependency, and the browser view and the tools need a handful of DevTools calls, which ostra's own client over the pipe makes. A spike that finds the pipe client too costly brings the question back with an ADR 0007 line.
- **A video encoder in the base image** (ffmpeg) for recordings. Rejected for now: the image's size, and the panel plays a frame reel. MP4 export can come with a reason.
- **Detecting listening ports.** Later (Q313).
- **One page per viewer in the browser view.** Rejected: each viewer would need their own renderer in a small box, and two members looking at the same thing is the point.

## Consequences

- **Protocol minor 7** carries the environment's app processes and screenshot settings, the `app` tools, the dispatch's `app` purpose, `attachment.added`, `app.process`, `preview.list`, the view commands, the preview connection and its HTTP endpoint, and the runner's browser in `hello`. A minor-6 runner gets none of it: no app processes, no tools, no previews, and the pane says the runner needs upgrading (milestone 8's spec, section 5.1).
- **The base image grows by Chromium.** The images' check (`pnpm check:images`) pins it and lists its notices.
- **The panel's CSP changes only when a preview domain is set.**
- **Core grows a preview proxy and a forwarder between replicas.** The launch gate's security review of the box (milestone 7's tickets 27 and 28) covers both, the viewer page and the links.
- **The environment page grows app processes, routes and widths.** The onboarding task proposes them.
- **A warm watched box costs compute that budgets don't count.** The 60-minute cap bounds it.
