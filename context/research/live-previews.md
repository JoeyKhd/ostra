# Research: live previews of a task's app

**Question:** How could a task's page show a live preview of the app its agent is building (a website, or an API server), in the chat view and in an expanded view, when the app runs in a box on a runner that only dials out? Should tunnels be the default, and how would the proxying work? The maintainer, 2026-11-20: "everything basically runs in our sandbox environment, right? So if I'm working on a website or on an API server or anything like that, it's pretty hard to show a live preview in our dashboard. It would be really nice if in the chat window of our tasks, we are able to preview the website that we're currently building, for example. Perhaps that could then have an expanded view. I'm not sure how we could do this, whether tunnels should be the default or how the proxies and communications would work."
**Status:** Research, 2026-11-20. Feeds F-121 (seeing the running app, Q68), ADR 0034 (the runner protocol), ADR 0029 (executors and boxes), ADR 0030 and ADR 0031 (credentials and the safety minimum) and ADR 0039 (idle boxes). It settles nothing: the designs at the end are for the lead to discuss with the maintainer.
**Method:** Tavily search and page reads (`tavily_search`, `tavily_extract`) of official docs, specs, source code, changelogs and security advisories, on 2026-11-20. Facts about ostra come from this repo. Anything I couldn't confirm on a primary source is marked **unconfirmed**; my own reasoning is marked *(inference)*; proposed numbers are *(working values)*. Secondary sources are labelled.
**Related:** `research/runner-transport.md` (Cloudflare Tunnel and Tailscale DERP, as transports for the runner itself), `research/elastic-sandboxes.md` (the hosted sandboxes), `research/credential-proxy.md`, `research/spike-what-is-inside-a-box.md` (the box's networks), `research/landscape.md` (Vibe Kanban's `preview-proxy` crate).

---

## Summary

- **Every product that ships a live preview gives it an origin of its own, and most give it a site of its own.** Devin serves `https://<port>--<id>.preview.devinapps.com`, Codespaces `https://<codespace>-<port>.app.github.dev`, Replit `<uuid>.<server>.replit.dev`, E2B `<port>-<sandbox>.e2b.app`, Daytona `<port>-<sandbox>.<proxy domain>`, CodeSandbox `<sandbox>-<port>.csb.app` (§1). v0 and Cloudflare tell integrators to put previews on a registrable domain different from their app's ([v0](https://v0.app/docs/api/v2/guides/accessing-previews), [Cloudflare](https://developers.cloudflare.com/sandbox/concepts/security/)).
- **The transport ostra needs is the shape it already has.** The control plane relays the browser's traffic over a connection the workspace dialled out. Coder ("The workspace daemon always dials out to the control plane, never the reverse"), Teleport, Ona and frp all work this way ([Coder](https://coder.com/docs/ai-coder/agents/architecture), [Teleport](https://goteleport.com/docs/reference/deployment/networking)). Node can run HTTP/2 over a WebSocket's duplex stream with no new dependency (§2.1).
- **Third-party tunnels shouldn't be the default.** Every option needs one or more of these, and some also fail on their own terms:
  - a vendor account;
  - an egress exception (cloudflared uses port 7844, not 443);
  - letting the vendor terminate TLS, so it sees the plaintext (Cloudflare, ngrok).

  Cloudflare's no-account Quick Tunnels are "for testing and development", cap at 200 in-flight requests, and don't carry SSE. ngrok's free tier puts an interstitial page in front of browser traffic (§2.2). All of them also skip ostra's own access checks.
- **A live preview asks one thing of a self-hoster: a wildcard DNS name and a wildcard certificate.** Coder, Gitpod, Ona, Teleport and frp ask the same (§3.1). Proxying by path under the panel's domain breaks Vite, React and Next.js dev servers, by Coder's own list ([Coder](https://coder.com/docs/admin/networking/wildcard-access-url)). It would also put agent-written code on the panel's origin, which RFC 6265 §8.6 and Coder's docs warn against (§3.2, §4.1).
- **The advisories are real and recent.**
  - Gitpod CVE-2023-0957: same-site WebSocket hijack, ending in account takeover.
  - Gitpod CVE-2024-21583: cookie tossing from a workspace subdomain.
  - Coder GHSA-5g4w-3vw9-478w (2026): app cookies scoped to the wildcard parent.
  - jupyter-server-proxy CVE-2024-28179 and CVE-2024-35225.

  Each shows what goes wrong when a preview and its control plane share a site or an origin (§4.3).
- **Dev servers are the second wall.**
  - Vite (from 6.0.9) refuses unknown `Host` headers.
  - Next.js (from 16.2) blocks cross-origin dev requests, including `Origin: null` from a sandboxed iframe.
  - webpack-dev-server has `allowedHosts: 'auto'`.

  Devin's preview gets past all three without project changes: it "sets the `Host` and `Origin` headers to `localhost` before the request reaches your app" ([Devin](https://docs.devin.ai/work-with-devin/browser-previews)) (§5).
- **Screenshots and recordings are what most cloud agents ship.** Copilot's coding agent, Codex cloud, Jules and Cursor attach screenshots or videos to the task or the PR. Devin and Replit add video replays. Devin, Replit, Lovable, v0 and OpenHands embed a live preview in the product. Cursor forwards ports to the user's machine. Codex and Copilot publish no live preview (§1, §6).
- **Recommendation (§7):**
  - **Screenshots and recordings in the timeline (F-121) are the default.** They need no setting, work on every executor and carrier, and outlive the box.
  - **The live pane is Design A:** preview hosts through core, on ostra's own runner connection. It turns on when an admin sets a preview domain (one wildcard record and certificate). `ostra preview` forwards a port to the member's own `localhost` with no setting at all.
  - **Design B, a stream of the box's own browser,** is the fallback to keep for installs that can't add a wildcard.
  - **No third-party tunnel is built in.**
  - Either live design needs a new protocol minor.

---

## 1. How comparable products do it

### 1.1 At a glance

| Product | URL shape | Who proxies | Auth | Pane or tab | Which port | When the sandbox sleeps |
|---|---|---|---|---|---|---|
| Devin | `<name>--<id>.preview.devinapps.com`, `<port>--<id>.preview.devinapps.com` | Devin, plus a service worker in the browser | Devin sign-in and the session's access | Preview tab, or a new tab | The agent exposes it | Opening it wakes the machine |
| Cursor cloud agents | Forwarded to the user's machine; shape not published | Cursor | **unconfirmed** | "Internal browser" or the user's browser | Detected listening ports | Not published |
| OpenAI Codex (cloud) | No user-facing preview | n/a | n/a | n/a | The user tells Codex the port, for its own browser | n/a |
| Copilot coding agent | No live preview | n/a | n/a | n/a | n/a | n/a |
| Replit Agent | `<uuid>.<server>.replit.dev` | Replit | Private by default; public toggle | Embedded webview, or a new tab | First opened port, or `.replit` `[[ports]]` | URL live only while you work; may change on reopen |
| Lovable | `preview--<app>.<workspace>.lovable.app` (branded); default host not published | Lovable | Lovable sign-in; expiring share links | Editor pane, or a new tab | Not published | Pauses when you're away |
| Bolt.new / WebContainers | Runs in the user's tab (a service worker); hosted previews on Safari | Nobody: the app runs in the browser | None needed | iframe | `port` / `server-ready` events | n/a |
| v0 | Vercel Sandbox URL behind the integrator's proxy | Vercel; the integrator's proxy for API users | Short-lived `x-v0-preview-token` | iframe | Detected framework | Recreated if expired; loading route meanwhile |
| OpenHands | `DOCKER_HOST_ADDR:<host port>`; `exposed_urls` from the runtime | Docker port mapping, or the runtime's ingress | Session API key on remote runtimes | iframe "App" tab, or a new tab | Two app ports handed to the agent | On Kubernetes, pause deletes the ingress |
| Codespaces | `<codespace>-<port>.app.github.dev` | GitHub | Private by default; 3-hour cookie; org or public | Browser tab, or VS Code's preview | Terminal output, or `forwardPorts` | **unconfirmed** |
| Gitpod (classic) | `<port>-<workspace>.ws-<region>.gitpod.io` | Gitpod | Private by default; public option | Tab, or the IDE's preview | Detected; `.gitpod.yml` | **unconfirmed** |
| Ona | Not published | Ona's gateway, or the customer's load balancer | Creator-only by default; `/auth/port/start` redirect | Built-in browser, or a tab | `ona` CLI opens it | **unconfirmed** |
| Coder | `<port>--<agent>--<workspace>--<user>.<wildcard>` | coderd, over the agent's tunnel | Owner by default; a redirect hands an API key to the app origin | Tab | Detected listening ports | **unconfirmed** |
| Daytona | `<port>-<sandbox>.<proxy domain>`; signed `<port>-<token>.<proxy domain>` | Daytona's proxy | Header token, or a signed URL (60 s default, 24 h max) | iframe through signed URLs | Any port | Preview traffic resets auto-stop |
| E2B | `<port>-<sandbox>.e2b.app` | E2B's proxy | Public on older projects; private by default since 2026-10-30, header token | Header only | Any port | Requests resume a paused sandbox when `autoResume` is set |
| Modal | `<random>.r5.modal.host` | Modal | Unguessable URL; Sandbox Connect Tokens as a header, query or cookie | Either | Declared at create | **unconfirmed** |
| Vercel Sandbox | `sb-<id>.vercel.run` | Vercel | None: "Anyone with the URL can reach the server" | Either | Declared, up to 15 | Stopped sandbox answers `SANDBOX_STOPPED` |
| Cloudflare Sandbox SDK | 0.x: `<port>-<sandbox>-<token>.<your domain>`; 1.0 also path-based | Your Worker and the sandbox's Durable Object | Token in the host (0.x); share links | Either | `exposePort()` | Sleeps after 10 min; next request restarts it (1.0 example) |
| CodeSandbox SDK | `<sandbox>-<port>.csb.app` | CodeSandbox | Private hosts take a signed URL, swapped for a cookie | Either | Any port | HTTP requests wake a hibernated sandbox; WebSockets don't by default |

### 1.2 Agent products

**Devin** ([browser previews](https://docs.devin.ai/work-with-devin/browser-previews), modified 2026-11-12):
- "A browser preview is a private link to an web application that is running on Devin's machine." The id "is random, so the URL can't be guessed", and the URL "stays the same if Devin restarts the app or moves it to another port".
- **Auth:** "Anyone who opens a preview URL must be signed into Devin." Anyone who can message the session can open its preview.
- **Where it opens:** clicking the card opens "the Preview tab of the session"; cmd-click opens a new browser tab. Devin's enterprise docs say its IDE and browser viewer "are loaded in the user's browser via iframes" ([deployment](https://docs.devin.ai/enterprise/deployment/overview)).
- **Which port:** "Devin opens a preview when it starts an app you should look at." Only "ports that Devin has exposed for the preview" are reachable. No auto-detection is documented.
- **The rewrite trick:** "A service worker that the preview installs rewrites these requests in your browser, and WebSocket connections are handled the same way." So a frontend that calls `localhost:8000` reaches the box's port 8000 with no CORS change. "The preview sets the `Host` and `Origin` headers to `localhost`", so host-checking dev servers need no configuration. The cost: "your app can't register" a service worker of its own.
- **Sleep:** "Opening the preview wakes the machine, and the app comes back at the same URL"; it sleeps "about 5 minutes after the last request". "A preview stops working when the session is archived or ends."
- **Longer-lived sharing:** Devin Apps are "never public", with levels for people with access, the organization and the enterprise ([Devin Apps](https://docs.devin.ai/product-guides/devin-apps)). `devin forward` reaches only the computer that runs it.

**Cursor cloud agents** ([setup](https://cursor.com/docs/cloud-agent/setup), [capabilities](https://cursor.com/docs/cloud-agent/capabilities), [self-hosted](https://cursor.com/docs/cloud-agent/self-hosted)):
- **Forwarding:** "Cursor forwards ports from the agent's environment to your machine." Listening ports "appear under Detected", with an Auto-Forward switch and "Open in internal browser".
- **The browser:** a changelog adds forwarding "straight to your browser" ([changelog](https://cursor.com/changelog/start-from-scratch)).
- **Remote desktop:** "You can take control of the agent's remote desktop."
- **Self-hosted workers:** they relay forwarded ports only when "the live workspace" is on, which is "Off by default".
- **Unpublished:** the forward's URL shape and auth model **unconfirmed**; a staff forum reply (secondary) describes forwards landing on `localhost:<port>`.

**OpenAI Codex (cloud):**
- **No user-facing port or preview is documented.** The agent gets "a browser inside the cloud task to inspect your web app", and the user gives it "the command to start the app in the task, the port, and the behavior you want it to check" ([browser](https://developers.openai.com/codex/browser?surface=web)).
- **Screenshots:** it can "attach a screenshot of the result to the task and GitHub PR" ([upgrades](https://openai.com/index/introducing-upgrades-to-codex)).
- **Network:** the legacy agent phase is offline by default ([internet access](https://developers.openai.com/codex/cloud/internet-access)). Newer environments sit "behind an HTTP/HTTPS network proxy" ([cloud environment](https://developers.openai.com/codex/environments/cloud-environment)).

**GitHub Copilot coding agent** publishes no live preview.
- Its Playwright MCP server "can only access web resources in the agent's own environment through localhost or 127.0.0.1" ([MCP](https://docs.github.com/en/copilot/concepts/customizations/mcp)).
- "Copilot can even share screenshots of what it has done in its pull request" ([changelog, 2025-07-02](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser)).
- A firewall limits its internet access by default ([firewall](https://docs.github.com/en/copilot/customizing-copilot/customizing-or-disabling-the-firewall-for-copilot-coding-agent)).

**Replit Agent:**
- **URLs:** dev URLs "follow the format UUID.servername.replit.dev" and are "private by default and require authentication". A toggle makes one public, and machine clients send a bearer token: "Tokens support API traffic, not interactive browser previews" ([development URLs](https://docs.replit.com/core-concepts/project-editor/app-setup/development-urls), modified 2026-10-15).
- **Lifetime:** they "are only live while you actively work on a Replit App", and the URL can change on reopen.
- **Ports:** the first opened port binds to external port 80. More need `[[ports]]` with `localPort` and `externalPort` ([ports](https://docs.replit.com/features/project-setup/ports)).
- **Where it shows:** the Preview tool embeds the app, with a new-tab option ([preview](https://docs.replit.com/features/editor/preview)). Agent self-tests produce an "Interactive video replay" ([app testing](https://docs.replit.com/features/agent/app-testing)).

**Lovable:**
- **URLs:** branded preview URLs "use preview--app-name.workspace-subdomain.lovable.app" ([branded URLs](https://docs.lovable.dev/features/branded-workspace-urls)). The default preview host is **unconfirmed**; `lovableproject.com` appears only in secondary sources.
- **Auth:** opening the preview in a new tab "requires logging in to Lovable". Share links need no account and expire after 7 days on Free and Pro ([preview](https://docs.lovable.dev/features/projects/preview)). Lovable moved the access token out of shared URLs into a short `lovable.dev/preview/…` link ([changelog](https://docs.lovable.dev/changelog)).
- **Sleep:** the preview "pauses after you've been away for a while".

**Bolt.new and StackBlitz WebContainers** run the app inside the user's own tab, so no server proxies anything.
- **The network:** "The virtualized TCP network stack is mapped to the browser's ServiceWorker API and is running completely locally" ([StackBlitz](https://blog.stackblitz.com/posts/webcontainer-api-is-here)).
- **Isolation headers:** the page must be cross-origin isolated (COEP `require-corp` and COOP `same-origin`, or `coep: 'credentialless'`) ([headers](https://webcontainers.io/guides/configuring-headers)).
- **Ports:** the API emits `port` events (`open`/`close`, with a URL) and `server-ready` ([API](https://webcontainers.io/api)). The quickstart mounts that URL "in an iframe" ([quickstart](https://webcontainers.io/guides/quickstart)). Bolt shows "the lowest port if user hasn't selected a preview" ([Preview.tsx](https://raw.githubusercontent.com/stackblitz/bolt.new/main/app/components/workbench/Preview.tsx)).
- **The same cost as Devin's:** an app can't install its own service worker ([troubleshooting](https://developer.stackblitz.com/platform/webcontainers/troubleshooting-webcontainers)).
- **Safari:** Bolt falls back to hosted previews there ([Bolt](https://support.bolt.new/reference/supported-technologies)).
- This design can't run the app's server code in a box, so it doesn't transfer to ostra.

**v0:**
- **The sandbox:** v0's preview now runs in "Vercel Sandbox, a lightweight virtual machine". It replaced "the older browser-based preview, which couldn't run server code". It detects Next.js, Vite and Node and starts "the right command on the right port" ([sandbox](https://v0.app/docs/sandbox)).
- **Through the API:** v0 returns "a preview URL and a short-lived preview token". Because "browsers cannot attach that token as a custom header when loading an iframe", the integrator runs a proxy "on a preview-only origin whose site is different from your host application" ([accessing previews](https://v0.app/docs/api/v2/guides/accessing-previews)).
- **v0's isolation advice:**
  - "if your application runs at `app.example.com`, do not run the preview proxy at `preview.example.com`… [they] can share cookies scoped to `example.com`."
  - The proxy strips incoming `Cookie` and `Authorization` and upstream `Set-Cookie`.
- **Cold starts:** "while the Sandbox spins up, requests fall back to a loading route" ([v0 API](https://vercel.com/blog/introducing-the-new-v0-api)).

**OpenHands** (open source):
- **The tab:** the "App" tab "Displays the web server when OpenHands runs an application" ([features](https://docs.openhands.dev/openhands/usage/key-features)). It's an `<iframe>` with a new-tab button ([served-tab.tsx](https://github.com/OpenHands/OpenHands/blob/0.60.0/frontend/src/routes/served-tab.tsx)).
- **The Docker runtime:** it reserves two app port ranges and builds URLs from `DOCKER_HOST_ADDR` and the mapped host ports ([docker_runtime.py](https://raw.githubusercontent.com/OpenHands/OpenHands/0.59.0/openhands/runtime/impl/docker/docker_runtime.py)).
- **The agent is told:** its prompt names the hosts and asks it to "allow iframes and CORS requests, and allow the server to be accessed from any host (e.g. 0.0.0.0)" ([prompt](https://raw.githubusercontent.com/OpenHands/OpenHands/0.59.0/openhands/agenthub/codeact_agent/prompts/additional_info.j2)).
- **Choosing the port:** the frontend polls each exposed URL every 3 s and shows the first that answers ([use-unified-active-host.ts](https://raw.githubusercontent.com/OpenHands/OpenHands/0.60.0/frontend/src/hooks/query/use-unified-active-host.ts)).
- **Remote runtimes:** these return `work_hosts` and authenticate with an `X-Session-API-Key` header ([remote_runtime.py](https://raw.githubusercontent.com/OpenHands/OpenHands/0.59.0/openhands/runtime/impl/remote/remote_runtime.py)).
- **A pause breaks the iframe:** a user-filed issue reports that on Kubernetes an auto-pause deletes the Service and Ingress. "The iframe loads the old URL", and the user gets a Bad Gateway ([#13987](https://github.com/OpenHands/OpenHands/issues/13987)).

### 1.3 Cloud dev environments

**GitHub Codespaces:**
- **URL:** an app is served at `https://CODESPACENAME-PORT.app.github.dev` ([forwarding ports](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)). The domain moved off `preview.app.github.dev` in 2023 "to improve security, reliability, and performance" ([changelog](https://github.blog/changelog/2023-07-14-codespaces-port-forwarding-domain-name-updates)).
- **Visibility:** private is the default, with `org` and `public` as options. Org visibility needs Team or Enterprise Cloud, and organization owners can cap it.
- **Browser auth:** "authentication cookies with a 3-hour expiry period" ([security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)). Command-line clients send `X-Github-Token`, and a stop and restart makes a new token. A public port "will automatically revert back to private" on restart.
- **Which port:** ports forward when terminal output "contains a localhost URL", or by `forwardPorts` in devcontainer.json.
- **Unconfirmed:** what a stopped codespace's URL returns, any iframe guidance, and the cookie redirect's exact flow.

**Gitpod (classic) and Ona:**
- **Classic URL:** the port is prepended to the workspace host, `3000-yourworkspace.ws-eu45.gitpod.io`, and is `private` by default ([ports](https://ona.com/docs/classic/user/configure/workspaces/ports)). A self-hosted Gitpod's certificate must cover `$DOMAIN`, `*.$DOMAIN` and `*.ws.$DOMAIN`, through DNS-01 ([installer](https://raw.githubusercontent.com/gitpod-io/gitpod/main/install/installer/docs/overview.md)).
- **Ona's admission:** levels are `creator_only` (the default), `organization` and `everyone`. "If the runner is too old to enforce private access, the CLI opens the port for everyone instead" ([Ona ports](https://ona.com/docs/ona/integrations/ports)).
- **Ona's auth:** browsers go "through Ona's `/auth/port/start` flow before loading the port URL".
- **Ona's gateway:** it "discards incoming `Forwarded`, `X-Forwarded-*`, and `X-Real-IP` headers". Services must listen on `0.0.0.0`, and ports 1–1023 can't be exposed.
- **Ona's runner:** its certificate needs both the root and `*.yourdomain.com` ([runner](https://ona.com/docs/ona/runners/aws/enterprise-runner/overview)).

**Coder** is the closest relative: self-hosted, with workspaces that dial out.
- **App URLs:** apps get `8080--main--myworkspace--john.coder.example.com` under `CODER_WILDCARD_ACCESS_URL`. "Applications run in isolated subdomains with separate browser security contexts and prevents access to the Coder API from malicious JavaScript" ([wildcard access URL](https://coder.com/docs/admin/networking/wildcard-access-url)).
- **Dashboard forwarding:** "Proxies traffic through the Coder control plane" ([port forwarding](https://coder.com/docs/admin/networking/port-forwarding)). The control plane reaches the workspace over the tunnel the agent dialled ([architecture](https://coder.com/docs/ai-coder/agents/architecture)).
- **Detecting ports:** the agent "will also detect if apps inside the workspace are listening on ports", on Windows and Linux only ([user guide](https://coder.com/docs/user-guides/workspace-access/port-forwarding)).
- **Sharing:** levels are owner, organization, authenticated and public, and Premium caps them at owner by default.
- **The auth handshake:**
  - The dashboard's `GET /api/v2/applications/auth-redirect` redirects "to URI with encrypted API key" ([API](https://coder.com/docs/reference/api/applications)).
  - The app origin decrypts it, "the cookie is set, and the user is redirected to strip the query parameter" ([proxy.go](https://raw.githubusercontent.com/coder/coder/main/coderd/workspaceapps/proxy.go)).
  - "For subdomain apps, we set the cookie on the whole wildcard so users don't need to re-auth for every subdomain app". GHSA-5g4w-3vw9-478w (§4.3) shows what that choice costs.
- **Path-based apps:** these work without a wildcard and are discussed in §3.4.

### 1.4 Sandbox platforms

**Daytona** ([preview](https://www.daytona.io/docs/en/preview.md), [custom proxy](https://www.daytona.io/docs/en/custom-preview-proxy.md)):
- **URLs:** `https://{port}-{sandboxId}.{daytonaProxyDomain}`, for any port 1–65535. Public sandboxes need no auth. Private ones take the `x-daytona-preview-token` header.
- **The token's reach:** that token "authenticates any port of that sandbox, including the ports that control the sandbox itself". A sandbox that is stopped and started again gets a new token.
- **Signed URLs:** `https://{port}-{token}.{daytonaProxyDomain}` are the path for "embedding previews in iframes". They expire after 60 s by default, 24 h at most.
- **Other behaviour:** a warning page shows the first time a browser opens a link. WebSockets work. The default CORS policy "allows all origins with credentials". Some reserved ports "always require authentication, even on public sandboxes".
- **Timers:** preview requests reset the 15-minute auto-stop timer and not the auto-pause one ([sandboxes](https://www.daytona.io/docs/en/sandboxes.md)). Waking a stopped sandbox is something a custom proxy does.

**E2B:**
- **URL:** the host's first label is the port, as in `https://3000-i62mff4ahtrdfdkyn2esc.e2b.app` ([public URL](https://docs.e2b.dev/network/public-url.md)).
- **Public or private:** URLs were public by default ("Treat a public URL like a credential"), and "since October 30, 2026, newly created projects default to private sandbox traffic". Private traffic needs the `e2b-traffic-access-token` header, otherwise 403 ([restrict access](https://docs.e2b.dev/network/restrict-public-access.md)). No cookie or query form is documented, so a plain iframe can't authenticate *(inference)*.
- **Pause and resume:** with `onTimeout: 'pause'` and `autoResume`, "any request to the preview URL will automatically resume it". Requests don't extend a running sandbox's timeout ([auto-resume](https://docs.e2b.dev/sandbox/auto-resume.md)).

**Modal:**
- `modal.forward` exposes a port "at a secure random URL, and connections have automatic TLS" ([tunnels](https://modal.com/docs/guide/tunnels)).
- Sandboxes take "Sandbox Connect Tokens", sent "in an Authorization header, in a _modal_connect_token query param, or in a _modal_connect_token cookie". A query parameter comes back as a `Set-Cookie`, which is the iframe-friendly handshake ([sandbox networking](https://modal.com/docs/guide/sandbox-networking)).

**Vercel Sandbox:**
- "Each exposed port gets its own public URL. You can expose up to 15 ports". Ports are declared at create or with `sandbox.update()`. "Anyone with the URL can reach the server" ([expose a port](https://vercel.com/docs/sandbox/examples/expose-a-port)).
- WebSockets to the public URL "can close while the sandbox continues running".
- A stopped sandbox answers with the `SANDBOX_STOPPED` error. The SDK resumes it ([error](https://vercel.com/docs/errors/sandbox_stopped)).

**Cloudflare Sandbox SDK:**
- **0.x:**
  - The URL shape is `https://{port}-{sandbox-id}-{token}.yourdomain.com`, routed by calling `proxyToSandbox()` in your Worker ([preview URLs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/)).
  - "The `.workers.dev` domain does not support wildcard subdomains", and a Worker on a subdomain needs a second-level wildcard certificate that Universal SSL doesn't cover ([custom domain](https://developers.cloudflare.com/sandbox/guides/preview-urls-custom-domain/)).
  - Sandboxes sleep after 10 minutes by default ([options](https://developers.cloudflare.com/sandbox/configuration/sandbox-options/)).
- **1.0 adds path-based previews, with the caveats spelled out** ([previews](https://developers.cloudflare.com/sandbox/previews/)):
  - "Links that start with `/` leave the preview".
  - Vite needs `server.allowedHosts`.
  - "A connection that only passes through the Durable Object does not keep the sandbox running".
  - "Code in a preview runs on this hostname and can send requests to this route with the visitor's cookies."
- **Cloudflare's security advice:** "Serve previews on a separate domain that your application does not use" ([security](https://developers.cloudflare.com/sandbox/concepts/security/)).

**CodeSandbox:**
- **Hosts:** `https://$SANDBOX_ID-$PORT.csb.app`. Private sandboxes' hosts take a signed URL, and "we will automatically put the preview token in a cookie" ([hosts](https://raw.githubusercontent.com/codesandbox/docs/main/packages/projects-docs/pages/sdk/sandbox-hosts.mdx)). It recommends "subdomains on a different domain than your main application".
- **Waking:** a hibernated sandbox wakes on an HTTP request to a preview URL. WebSockets no longer wake it by default, because an open HMR connection "would continuously wake the sandbox". This comes from the 2025-04-04 changelog, read in a search excerpt only, and from the SDK's defaults ([types.ts](https://raw.githubusercontent.com/codesandbox/codesandbox-sdk/main/src/types.ts)).

### 1.5 What they agree on

1. **One origin per sandbox and port, on a domain that isn't the product's** (all except WebContainers, which have no server).
2. **Private by default, sharing as an explicit step:** Devin, Replit, Codespaces, Gitpod, Ona, Coder, Lovable, and E2B since 2026-10-30. Vercel Sandbox and Modal's `forward` are the exceptions, with public, unguessable URLs.
3. **For a browser, auth ends up as a cookie on the preview origin,** set by a redirect that carries a one-time or short-lived token (Coder, Ona, Modal, CodeSandbox, Codespaces), or as a token in the host name (Daytona's signed URLs, Cloudflare 0.x). Header-only tokens (E2B, Daytona's default) can't drive an iframe.
4. **Ports are announced by the agent, declared in config, or detected,** and most products do two of the three.
5. **A request wakes a sleeping sandbox where the product supports sleep** (Devin, E2B, CodeSandbox, Cloudflare 1.0). CodeSandbox and Cloudflare both learned that a held HMR WebSocket must not count as activity.

---

## 2. Transports for a runner that only dials out

ostra's constraints, from ADR 0034:
- Every runner and every box's sidecar holds one WebSocket to core on 443, with JSON text frames capped at 1 MiB and credit-based back-pressure (256 frames or 4 MiB).
- The fallback carrier is `POST` up and a 25 s long poll down.
- Bulk data already stays off the session, on chunked HTTPS (ADR 0043).
- Nothing connects in to a runner.

### 2.1 Through core, over the runner's own connection

**The shape.** The member's browser connects to core on a preview host. Core finds the box's sidecar and opens a stream to it over a connection the sidecar dialled. The sidecar opens a TCP connection to the dev server and pipes bytes. This is how Coder's dashboard apps, Teleport's application access and frp work:
- Teleport's application service uses "reverse tunnel connections through the Teleport Proxy Service and cannot expose ports directly" ([networking](https://goteleport.com/docs/reference/deployment/networking)), and serves each app at `app-name.proxy_public_addr.com` with a wildcard certificate ([connecting apps](https://goteleport.com/docs/enroll-resources/application-access/protect-apps/connecting-apps)).
- frp multiplexes "all logic connections to the same frpc… into the same TCP connection" and gives each proxy a subdomain under `subDomainHost`, which needs wildcard DNS ([frp](https://github.com/fatedier/frp)).

**Multiplexing many browser connections over one link.** A page in a Vite dev server makes many requests, plus an HMR WebSocket, so one link has to carry many streams.
- **yamux:** it gives each stream "a 256KB window size" and none to the session, and relies on "an underlying connection to provide reliability and ordering" ([spec](https://github.com/hashicorp/yamux/blob/master/spec.md), [README](https://github.com/hashicorp/yamux)). libp2p prefers it to mplex because mplex "doesn't provide a mechanism to apply backpressure on the stream level" ([libp2p](https://libp2p.io/docs/yamux)).
- **HTTP/2:** its flow control works "for both individual streams and the connection as a whole", with 65,535-octet default windows ([RFC 9113 §5.2, §6.9.2](https://www.rfc-editor.org/rfc/rfc9113.html)).
- **The caveat for both:** over one TCP connection (and so over one WebSocket), "a lost or reordered packet causes all active transactions to experience a stall" ([RFC 9114 §1.1](https://www.rfc-editor.org/rfc/rfc9114.html)).

**Node already has the pieces, with no new dependency:**
- `ws` turns a WebSocket into "a `Duplex` stream" ([ws](https://github.com/websockets/ws/blob/master/doc/ws.md)).
- `http2.connect()` takes a `createConnection` that "returns any `Duplex` stream that is to be used as the connection for this session" ([http2](https://nodejs.org/api/http2.html)).
- An HTTP or HTTP/2 server accepts injected connections: "any `Duplex` stream can be passed" to its `connection` event ([http](https://nodejs.org/api/http.html)).
- So core can be the HTTP/2 client and the sidecar the HTTP/2 server, over one WebSocket. Browser WebSockets (HMR) cross it as RFC 8441 extended CONNECT streams, which Node supports when `enableConnectProtocol` is on (default `false`) ([http2](https://nodejs.org/api/http2.html)). *(inference: not run here. It is the spike's first question.)*

**Libraries and tools, if hand-rolled HTTP/2 doesn't hold up:**
- **`yamux-js`:** MIT, a Node port that is "fully interoperable" with Go's yamux ([repo](https://github.com/th-ch/yamux-js)).
- **`@libp2p/yamux`:** formerly `@chainsafe/libp2p-yamux`, built for js-libp2p's stream types ([repo](https://github.com/ChainSafe/js-libp2p-yamux)). Its maintenance moved into the libp2p monorepo in 2026-09 ([#3603](https://github.com/libp2p/js-libp2p/issues/3603)). Either is a dependency to ask the maintainer about.
- **chisel:** MIT; SSH over WebSocket with reverse forwarding ([chisel](https://github.com/jpillora/chisel)). It's Go, and "proxies which strip `Upgrade` headers cannot carry chisel at all".
- **frp:** Apache-2.0, Go, a separate server and client.
- **inlets:** now commercial ("A valid license key or Gumroad subscription is required", [inlets-pro](https://github.com/inlets/inlets-pro)).
- **rathole:** Apache-2.0, TCP/UDP only, and leaves host routing to nginx ([out of scope](https://github.com/rathole-org/rathole/blob/main/docs/out-of-scope.md)).

None of the tools fits ostra's TypeScript-everywhere rule (ADR 0008) as well as Node's own `http2` does.

**Back-pressure.**
- **Per stream:** yamux and HTTP/2 windows (above), and SSH channel windows for chisel ([RFC 4254 §5.2](https://www.rfc-editor.org/rfc/rfc4254.txt)).
- **For the whole link:** the WebSocket's `bufferedAmount`, as ADR 0034 already does for commands.
- **In the browser:** the WebSocket API has "no way to apply backpressure" on what it receives ([WebSocketStream](https://developer.chrome.com/docs/capabilities/web-apis/websocketstream)). A dev server that floods its HMR socket fills core's buffer for that stream, and the stream's window is what stops it *(inference)*.

**Keep preview bytes off the session.** ostra's session frames are JSON text. Tunnelling bytes inside them would need base64, which turns every 3 bytes into 4 ([RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648)), and every frame would count against the session's credit window. ADR 0034 keeps bulk data off the session for the same reason. A separate preview connection with binary frames fits that rule. The session would carry only the control messages: "open a preview", "these ports are listening".

**More than one core replica.** The browser's request reaches whichever replica the load balancer picks, and the sidecar's preview connection may sit on another.
- ADR 0034 set replica-to-replica forwarding aside for commands, because Postgres routing covers them. It can't carry a byte stream at page-load rates *(inference)*.
- **The precedents forward between replicas:**
  - Coder HA needs `CODER_DERP_SERVER_RELAY_URL`, "accessible by other replicas to relay DERP traffic. Required for high availability" ([HA](https://coder.com/docs/admin/networking/high-availability), [CLI](https://coder.com/docs/reference/cli/server)).
  - Tailscale's DERP servers in a region mesh and forward packets for peers connected elsewhere (`research/runner-transport.md`, "Tailscale DERP").
- **What ostra would need:** a presence row for each preview connection that names its replica's internal address, and a replica that forwards when it doesn't hold the stream. A one-machine install (`ostra-server all`) never forwards.

**The HTTP fallback carrier.**
- **It's possible:** streams can ride a long poll. Engine.IO pairs "long-running `GET` requests" with "short-running `POST` requests" ([Engine.IO](https://socket.io/docs/v4/engine-io-protocol/)). BOSH "emulates the semantics of a long-lived, bidirectional TCP connection" ([XEP-0124](https://xmpp.org/extensions/xep-0124.html)), and GOST's PHT tunnels TCP over GET and POST ([GOST](https://gost.run/en/tutorials/protocols/pht)).
- **The cost:** RFC 6202 bounds it. The "maximal latency is over three network transits", every downlink message waits for "the next long poll request", and headers dominate small messages ([RFC 6202](https://www.rfc-editor.org/rfc/rfc6202.txt)).
- **No measurement:** neither chisel nor frp offers a polling transport, and I found no published measurement of HTTP or WebSocket tunnelling over long polls.
- **For a dev server that serves hundreds of modules on a page load, plus HMR, that is a poor preview** *(inference)*.

### 2.2 Third-party tunnels

| Tunnel | Licence | Account | What a self-hoster runs | Who terminates TLS | Auth on the URL | WebSocket | Limits and catches |
|---|---|---|---|---|---|---|---|
| Cloudflare Tunnel (named) | cloudflared: Apache-2.0 ([LICENSE](https://raw.githubusercontent.com/cloudflare/cloudflared/master/LICENSE)) | Yes, plus "A domain on Cloudflare" ([get started](https://developers.cloudflare.com/tunnel/get-started/)) | `cloudflared` per box or per runner | Cloudflare's edge ([SSL](https://developers.cloudflare.com/ssl)) | Separately, through Access ([concepts](https://developers.cloudflare.com/tunnel/concepts)) | Yes ([WebSockets](https://developers.cloudflare.com/network/websockets)) | Outbound port 7844, not 443 ([firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall)); 1,000 tunnels included, then $4.50 a month each ([changelog](https://developers.cloudflare.com/cloudflare-one/changelog/tunnel)) |
| Cloudflare Quick Tunnel | Apache-2.0 | "You do not need a Cloudflare account or domain" ([quick tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels)) | `cloudflared` | Cloudflare | None, or a one-time email PIN (`--allowed-mail`) | Yes | "for testing and development"; 200 in-flight requests, then 429; "do not support Server-Sent Events"; "no uptime guarantee" ([trycloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare)) |
| ngrok | Current agent's licence not stated (closed source **unconfirmed**); the 1.x open-source agent is unmaintained ([FAQ](https://ngrok.com/docs/faq)) | Yes, and an authtoken ([CLI](https://ngrok.com/docs/gateway/agent/cli)) | The `ngrok` agent | ngrok's cloud ([HTTP endpoints](https://ngrok.com/docs/gateway/endpoints/http)) | Basic, OAuth, OIDC, JWT, IP rules, mTLS through Traffic Policy | Yes | Free tier: "an interstitial page in front of all HTML browser traffic", 1 GB out and 20,000 requests a month ([limits](https://ngrok.com/docs/pricing-limits/free-plan-limits.md)). An iframe can't send the bypass header |
| Tailscale Funnel | Client: BSD-3-Clause ([LICENSE](https://raw.githubusercontent.com/tailscale/tailscale/main/LICENSE)) | A tailnet with MagicDNS and HTTPS | `tailscaled` on the node | The node itself: relays "do not decrypt the traffic" ([Funnel](https://tailscale.com/kb/1223/funnel)) | None documented: public "for anyone to access" | **unconfirmed** | Ports 443, 8443 and 10000 only; names under `tailnet-name.ts.net` only; "non-configurable bandwidth limits"; Headscale lacks Funnel (user report, [#3435](https://github.com/juanfont/headscale/issues/3435)) |
| bore | MIT ([bore](https://github.com/ekzhang/bore)) | No (self-hostable server, or bore.pub) | `bore` client and a server | Nobody: "no further traffic is encrypted by default" | A handshake secret only | TCP only | A new TCP stream per visitor; no HTTP routing |
| frp | Apache-2.0 ([LICENSE](https://raw.githubusercontent.com/fatedier/frp/dev/LICENSE)) | No; you run `frps` | `frps` and `frpc`, wildcard DNS | `frps`' operator, or the app ("frps will not perform TLS termination" for https proxies, [vhost](https://gofrp.org/en/docs/examples/vhost-http)) | HTTP Basic auth | Yes, per a reply in an issue (secondary, [#5291](https://github.com/fatedier/frp/issues/5291)) | Transports: tcp, kcp, quic, websocket, wss; no polling ([example](https://raw.githubusercontent.com/fatedier/frp/dev/conf/frpc_full_example.toml)) |
| localtunnel | MIT | No (public `loca.lt` **unconfirmed**) | The server listens on "any OS-assigned TCP port for client connections" ([server](https://github.com/localtunnel/server)) | A reverse proxy you run in front | A reminder page, bypassed by a header ([#407](https://github.com/localtunnel/localtunnel/issues/407)) | Yes ([server.js](https://raw.githubusercontent.com/localtunnel/server/master/server.js)) | Clients must reach arbitrary ports, not just 443 |
| zrok | Apache-2.0, self-hostable ([zrok](https://github.com/openziti/zrok)) | Yes on zrok.io; none on your own | The OpenZiti controller and router, Caddy, wildcard DNS ([docker](https://github.com/openziti/zrok/blob/main/website/docs/self-hosting/deployment/docker.mdx)) | Caddy, for public shares | OAuth (Google, GitHub, OIDC) ([OAuth](https://netfoundry.io/docs/zrok/1.1/guides/self-hosting/oauth/configuring-oauth)) | **unconfirmed** | Router data port 3022 |

**What this means for a tunnel inside ostra.**
- **The tunnel would run in the sidecar,** since the agent's container holds no credential (ADR 0030). A named tunnel's token is a credential.
- **Its egress needs an exception.** On `docker` the agent's only exit is the sidecar (ADR 0029), so a tunnel there means the sidecar's egress must allow the vendor, and port 7844 for cloudflared.
- **The vendor terminates TLS,** except on Funnel.
- **The vendor's auth replaces ostra's,** so a project member's access to a task no longer decides who sees its preview.
- **None of these vendors was chosen by the maintainer,** and AGENTS.md requires asking first.
- **None fits a box that serves one task and dies.** Each tunnel is a named, accounted resource, or else a testing-only quick tunnel with a random name.

### 2.3 Direct reachability

When the runner's network accepts inbound connections, a box could publish its port: a Docker published port, or a Kubernetes Service with an Ingress. Each has its own catch:
- "Publishing container ports is insecure by default", unless bound to loopback ([Docker](https://docs.docker.com/engine/network/port-publishing/)).
- A Kubernetes Ingress wildcard "only covers a single DNS label", and the project now recommends Gateway over the frozen Ingress API ([Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)).

Both break ostra's rule that nothing connects in to a runner. They also bypass core's access checks unless core's own proxy is in front, and on `docker` they open a door the egress baseline closes. This fits only an operator who wants previews to stay inside a cluster, as an executor option.

### 2.4 Comparison

| | Through core (2.1) | Third-party tunnel (2.2) | Direct (2.3) |
|---|---|---|---|
| Fits "the runner dials out" | Yes, on the existing 443 path | Yes, but to the vendor (7844 for cloudflared) | No |
| Works over the HTTP fallback | Only degraded (RFC 6202's bounds) | Separate from ostra's carrier: works if the vendor's port is open | n/a |
| Extra hops | Browser → core → sidecar → dev server; one more replica hop with several replicas | Browser → vendor edge → tunnel client → dev server | Browser → ingress → box |
| Latency | One round trip to core, plus head-of-line on one WebSocket (no measurement found) | Vendor edge; the only figures found are a vendor's loopback benchmark of rathole and frp ([benchmark](https://github.com/rathole-org/rathole/blob/main/docs/benchmark.md)) and a competitor's throughput test (secondary, [LocalCan](https://www.localcan.com/blog/ngrok-vs-cloudflare-tunnel-vs-localcan-speed-test-2025)) | Lowest |
| Self-hoster's burden | One wildcard DNS name and certificate to core | An account, a domain on the vendor (named tunnels), a token per org | Inbound rules, an ingress, wildcard DNS |
| Access control | ostra's own: project membership, lease, revocation | The vendor's | Whatever the operator adds |
| Who sees plaintext | Core (already trusted with everything) | The vendor (not Funnel) | The ingress |

---

## 3. URL and origin design

### 3.1 Subdomains, and what they ask of a self-hoster

A host per preview (`<port>-<id>.preview.example.com`) gives each preview its own origin. The self-hoster needs:
- **A wildcard DNS record** pointing at the ingress in front of core.
- **A wildcard certificate.** Let's Encrypt issues those only through DNS-01: HTTP-01 "cannot be used to issue wildcard certificates" ([challenge types](https://letsencrypt.org/docs/challenge-types/)). So the ACME client needs API access to the DNS provider, or the admin supplies the certificate.
- **One label under the wildcard.** A wildcard covers a single label, for Ingress rules ([Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)) and for Universal SSL under a subdomain ([Cloudflare](https://developers.cloudflare.com/sandbox/guides/preview-urls-custom-domain/)). That's why Coder packs its fields into one label with `--`, and fails past "63 characters in the hostname" ([port forwarding](https://coder.com/docs/admin/networking/port-forwarding)).
- **Not a bare top-level domain.** Coder warns that "Some browsers consider these 'public' domains and will refuse Coder's cookies" ([wildcard](https://coder.com/docs/admin/networking/wildcard-access-url)).
- **WebSocket upgrades passed through** on those hosts. ADR 0034 already asks this for runners.

Every self-hosted product in §1 that serves apps from its control plane asks for this: Coder, self-hosted Gitpod (`*.$DOMAIN`, `*.ws.$DOMAIN`), Ona's runner (`*.yourdomain.com`), Teleport and frp.

### 3.2 Why path-based proxying under one host breaks apps

Serving `https://ostra.example.com/preview/<id>/` would need no DNS. It breaks two ways.

**Apps break.**
- **Absolute URLs leave the preview:** "Links that start with `/` leave the preview" ([Cloudflare 1.0](https://developers.cloudflare.com/sandbox/previews/)).
- **Vite:** it rewrites imported assets for a `base`, but not URLs an app builds "on the fly" ([build guide](https://vite.dev/guide/build)), so `fetch('/api')` and a router without a basename go to the panel *(inference)*.
- **Next.js:** `basePath` "must be set at build time and cannot be changed without re-building" ([basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)).
- **Coder's list of tools that break:** "Vite dev server: Hot module replacement and asset serving issues with path-based routing", the React dev server, the Next.js dev server, JupyterLab and RStudio ([wildcard](https://coder.com/docs/admin/networking/wildcard-access-url)).
- **Service workers:** an app's service worker would be scoped under the panel's origin *(inference)*. The products that rewrite requests with their own service worker take the app's away (Devin, WebContainers, §1.2).

**Security breaks.**
- **Cookies are scoped by host, not by path:** "servers SHOULD NOT both run mutually distrusting services on different paths of the same host and use cookies to store security-sensitive information" ([RFC 6265 §8.6](https://www.rfc-editor.org/rfc/rfc6265.txt)).
- **Coder makes the same point:** "Path-based apps share the same origin as the Coder API… A malicious workspace could reuse Coder cookies to call the API" ([security best practices](https://coder.com/docs/tutorials/best-practices/security-best-practices)).

### 3.3 A second port on the panel's host

`https://ostra.example.com:8443` is a different origin, but cookies are shared across it: "Cookies do not provide isolation by port" ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265.txt)). Two consequences:
- A preview's JavaScript could overwrite or add cookies the panel reads.
- The two are one site, so the preview's requests to the panel carry the member's `SameSite=Lax` cookies ([same-site](https://web.dev/articles/same-site-same-origin)).

It also needs an inbound port. It's not a safe fallback.

### 3.4 How Codespaces, Coder and Gitpod handle a single domain

- **Codespaces** is hosted only, and always serves ports on GitHub's own `app.github.dev`. There is no single-domain mode.
- **Coder** falls back to path-based apps when no wildcard is set:
  - Its dashboard port forwarding stops working: the wildcard "is necessary for port forwarding via the dashboard" ([wildcard](https://coder.com/docs/admin/networking/wildcard-access-url)).
  - Path apps are owner-only: "Path-based apps share the same origin as the Coder dashboard, so Coder blocks non-owners from accessing them" ([shared workspaces](https://coder.com/docs/user-guides/shared-workspaces)).
  - Sharing them needs `--dangerous-allow-path-app-sharing`, and Coder recommends `--disable-path-apps` once a wildcard exists ([server CLI](https://coder.com/docs/reference/cli/server)).
  - With no access URL at all, Coder's built-in tunnel gives the deployment a public URL and port forwarding works ([port forwarding](https://coder.com/docs/admin/networking/port-forwarding)). That's Coder's own tunnel service, a vendor dependency ostra doesn't have.
- **Gitpod and Ona** document no single-domain mode. Their certificates must carry the wildcard names (§1.3).

### 3.5 Development installs: `*.localhost`

ostra's defaults are local (`OSTRA_PUBLIC_URL=http://localhost:3000`, `docs/configuration.md`).
- **The standards:** an IETF draft notes that RFC 6761 §6.3 "invites developers to 'assume that IPv4 and IPv6 address queries for localhost names will always resolve to the respective IP loopback address'". It would make that a requirement for "any names falling within `.localhost.`" ([draft-west-let-localhost-be-localhost](https://datatracker.ietf.org/doc/html/draft-west-let-localhost-be-localhost-03)).
- **What browsers do:** whether every major browser resolves `*.localhost` to loopback is **unconfirmed** on a vendor page.
- **What Vite does:** it allows "domains under `.localhost`" by default ([server options](https://vite.dev/config/server-options)).
- So a development install could default its preview domain to `preview.localhost` and need no setting *(inference; a spike checks the browsers)*.

---

## 4. Security

The previewed app is untrusted, agent-written code that runs in the member's browser. Everything the member's browser can reach from that origin, the app can reach.

### 4.1 Never the panel's origin

- **The policy:** the same-origin policy keys on scheme, host and port ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)). An app on the panel's origin would read the panel's DOM and call its tRPC API as the member.
- **What cookies don't isolate:**
  - ports (§3.3);
  - paths (§3.2);
  - sibling subdomains, as RFC 6265 §8.6 warns: "Cookies do not provide integrity guarantees for sibling domains (and their subdomains)" ([RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.txt)).

  A subdomain "can set a cookie with the Domain attribute, which gives access to that cookie on all other subdomains" ([MDN cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)).
- **The defence for the panel's own cookie:** the `__Host-` prefix, which must have no `Domain` and `Path=/`, so it is "only sent to the host that set them" (same page).
- **The panel today:** it doesn't turn on better-auth's cross-subdomain cookies (`packages/api/src/auth/create-auth.ts` sets only `trustedOrigins`). Whether its session cookie name carries `__Host-` is unchecked.

### 4.2 Same site, or another site

- **Same site** means the same scheme and eTLD+1 ([web.dev](https://web.dev/articles/same-site-same-origin)). `5173-x.preview.example.com` and `ostra.example.com` are the same site, so requests between them carry `SameSite=Lax` cookies.
- **Why products use another domain:**
  - GitHub moved Pages off its main domain for "mitigating phishing attacks and cross-domain cookie vulnerabilities arising from hosting custom user content in a subdomain of our main website" ([GitHub](https://github.blog/engineering/infrastructure/yummy-cookies-across-domains)).
  - Google's guidance: "Since these two domains are cross-site, any malicious content on exampleusercontent.com can't impact example.com". It also says separate cookies make auth on the sandbox domain "very difficult to do securely", and that user content "isn't isolated from other user content" unless the sandbox domain is on the Public Suffix List ([Google, 2023](https://security.googleblog.com/2023/04/securely-hosting-user-data-in-modern.html)).
  - v0 and Cloudflare say the same (Summary).
- **A self-hoster can't add a domain to the Public Suffix List.** So on a second domain, previews are cross-site from the panel but same-site with each other *(inference)*.

### 4.3 Advisories

| Advisory | What happened | Fix |
|---|---|---|
| Gitpod CVE-2023-0957 ([Snyk](https://labs.snyk.io/resources/gitpod-remote-code-execution-vulnerability-websockets), 2023-02-27) | "the workspace URL is considered to be the same site as gitpod.io". A workspace served JavaScript that opened Gitpod's WebSocket, which had no `Origin` check: full account takeover | WebSocket connections only "from base domains" ([Ona trust](https://trust.ona.com)) |
| Gitpod CVE-2024-21583 ([Snyk](https://labs.snyk.io/resources/hijacking-oauth-flows-via-cookie-tossing)) | JavaScript on a workspace subdomain tossed a cookie onto the OAuth paths: Git integration takeover | The `__Host-` prefix, fixed 2024-07-01 |
| Coder GHSA-5g4w-3vw9-478w ([advisory](https://github.com/coder/coder/security/advisories/GHSA-5g4w-3vw9-478w), 2026) | "App session cookies are scoped to the wildcard parent domain so the browser attaches them to any app subdomain". A shared app forged `X-Forwarded-Host` and read a victim's private app | Trust `X-Forwarded-Host` only from configured proxies; 2.34.2, 2.33.8, 2.32.7, 2.29.17 |
| Coder CVE-2026-55438 ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-55438), 2026-07-08); GHSA-5wg6-jmq2-53pw ([advisory](https://github.com/coder/coder/security/advisories/GHSA-5wg6-jmq2-53pw)) | "the CORS middleware trusted the unverified username in the hostname", so an app's JavaScript could make credentialed requests to the victim's apps. That the CVE and the GHSA are one advisory is my reading | Check the host's owner against the workspace's |
| jupyter-server-proxy CVE-2024-28179 ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-28179)) | Didn't "check user authentication appropriately when proxying websockets": often unauthenticated code execution | 3.2.3, 4.1.1 |
| jupyter-server-proxy CVE-2024-35225 ([GHSA-fvcq-4x64-hqxr](https://github.com/jupyterhub/jupyter-server-proxy/security/advisories/GHSA-fvcq-4x64-hqxr)) | A reflected XSS on `/proxy/<host>`, which "permits extensive access to the user's JupyterLab instance" | 4.2.0, 3.2.4 |
| code-server CVE-2023-26114 ([GHSA-frjg-g767-7363](https://github.com/advisories/GHSA-frjg-g767-7363)) | "Missing Origin Validation in WebSockets handshakes" | 4.10.1 |

JupyterHub's own guidance: "Subdomains are the only way to reliably isolate user servers from each other" ([web security](https://jupyterhub.readthedocs.io/en/stable/explanation/websecurity.html)).

The lessons for ostra *(inference)*:
- Every WebSocket core serves checks `Origin`.
- Nothing that authenticates a member is scoped to the wildcard parent.
- `X-Forwarded-*` from the client is dropped, as Ona's gateway does.
- The panel rejects state-changing requests whose `Origin` isn't its own, whatever site the previews sit on.

### 4.4 Auth for preview URLs

| Pattern | Who | Works in an iframe | Trade-off |
|---|---|---|---|
| Product sign-in, then a cookie on the preview origin through a redirect | Codespaces (3-hour cookie), Coder (encrypted API key handed to the app origin), Ona (`/auth/port/start`), Modal (query becomes a cookie), CodeSandbox (signed URL becomes a cookie) | Yes, if the cookie survives third-party rules (§4.5) | Standard. The cookie must be host-only and kept from the app |
| A token in the host name | Daytona signed URLs, Cloudflare 0.x | Yes, with no cookie | The host name travels in clear: "The SNI extension is carried in cleartext in the TLS 'ClientHello' message" ([RFC 8744 §2](https://www.rfc-editor.org/rfc/rfc8744.html)), and in DNS queries *(inference)* |
| A header token | E2B, Daytona's default, v0's API | No: "Browsers cannot attach that token as a custom header when loading an iframe" ([v0](https://v0.app/docs/api/v2/guides/accessing-previews)) | Needs a proxy in front |
| An unguessable URL only | Vercel Sandbox, Modal `forward` | Yes | Anyone with the link; v0's staff say people "had their accounts compromised by sharing the preview URL with its access token" (vendor forum, [community](https://community.vercel.com/t/where-has-the-preview-url-gone/19859)) |
| Share links that expire | Lovable (7 days), Vercel Shareable Links ([docs](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links)), Devin Apps (never public) | Yes | Sharing beyond the team is a product decision |

Vercel's bypass cookie shows the iframe catch. It is `SameSite=Lax` by default, and for iframes there is `samesitenone` ([bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)).

### 4.5 iframe embedding

**The app may refuse to be framed.**
- **Which header wins:** with an enforced `frame-ancestors`, "the X-Frame-Options header will be ignored" ([CSP 3](https://www.w3.org/TR/CSP3/)), and `frame-ancestors` "will not fall back to the default-src directive's value".
- **Framework defaults that block framing:**
  - helmet: `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` ([helmet](https://github.com/helmetjs/helmet));
  - Rails: `SAMEORIGIN` ([guides](https://guides.rubyonrails.org/configuring.html));
  - Django: `DENY` "for every outgoing HttpResponse" ([clickjacking](https://docs.djangoproject.com/en/stable/ref/clickjacking/));
  - Spring Security: "disables rendering pages within an iframe" ([headers](https://docs.spring.io/spring-security/reference/features/exploits/headers.html)).
- **So a preview proxy has to remove or rewrite these** for the pane to show such an app *(inference)*.

**The `sandbox` attribute.**
- **The breakout warning:** `allow-scripts` with `allow-same-origin` "when the embedded page has the same origin as the page containing the iframe allows the embedded page to simply remove the sandbox attribute" ([HTML](https://html.spec.whatwg.org/multipage/iframe-embed-object.html)). On a different origin the pair keeps the app's own origin without that risk.
- **Without `allow-same-origin`:** the frame gets "an opaque origin" ([HTML](https://html.spec.whatwg.org/multipage/browsers.html)). That breaks cookies and storage for the app, and makes it send `Origin: null`, which Next.js now blocks (§5.1).
- **What else to grant:** `allow-forms`, `allow-popups` and `allow-modals` each lift one restriction. Leaving out `allow-top-navigation` keeps the app from navigating the panel away *(inference)*.

**Third-party cookies in the frame (late 2026).** A preview on another site is cross-site in the panel's frame, so its cookie is third-party.
- **Safari:** "Cookies for cross-site resources are now blocked by default across the board" ([WebKit, 2020](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more)). Safari 26.2 ships partitioned cookies, and "blocks setting and accessing cross-site cookies when partitioning was not requested" ([WebKit 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2)).
- **Firefox:** Total Cookie Protection confines embedded content's cookies to the top site's jar ([Mozilla](https://blog.mozilla.org/en/mozilla/firefox-rolls-out-total-cookie-protection-by-default-to-all-users-worldwide)).
- **Chrome:** it keeps third-party cookies by default and "will not be rolling out a new standalone prompt"; Incognito blocks them ([Privacy Sandbox](https://privacysandbox.google.com/blog/privacy-sandbox-next-steps)). Lax is Chrome's default `SameSite` ([Chromium](https://www.chromium.org/updates/same-site/)).
- **CHIPS:** `Partitioned` cookies are "Baseline 2025", keyed by the cookie's origin and the top-level page's ([MDN](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)).
- **So a preview cookie set inside the panel's frame works in every major browser when it is `Secure; SameSite=None; Partitioned`** *(inference)*. It is a different cookie from the one the same host gets in a top-level tab, so the expanded view in a new tab needs its own handshake.
- **The Storage Access API** requires user activation ("always require user activation", [spec](https://privacycg.github.io/storage-access/)), so it can't be the silent path.

**Framing `localhost`.** Chrome 142 gates "any request from a public website to a local IP address or loopback" behind a permission ([Chrome 142](https://developer.chrome.com/release-notes/142)). Cross-origin iframes need the permission delegated with `Permissions-Policy: local-network=…, loopback-network=…` on the embedding page ([LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)). So a panel that frames `http://localhost:<port>` (a member's local forward) would meet a prompt *(inference from the two pages; iframe navigations specifically are reported in [WICG #69](https://github.com/WICG/local-network-access/issues/69))*.

**Defence in depth.**
- Google: `Content-Security-Policy: sandbox` "Sandboxes the content as if it was served on a separate domain". It's "likely a sufficient solution" when Spectre and renderer compromise are outside the threat model ([Google](https://security.googleblog.com/2023/04/securely-hosting-user-data-in-modern.html)).
- That gives an opaque origin, with the same breakage as above.

### 4.6 ostra's panel today

- **It can't be framed:** `apps/web/src/proxy.ts` sends `frame-ancestors 'none'` and `apps/web/next.config.ts` sends `X-Frame-Options: DENY`. A preview can't frame the panel to clickjack it. Keep both.
- **It can't frame anything:** the panel's CSP has `default-src 'self'` and no `frame-src` or `child-src` (`apps/web/src/proxy.ts`). Any preview iframe needs `frame-src https://*.<preview domain>` added, and nothing wider.
- **It already allows images from `blob:` and `data:`,** which a stream of screenshots (Design B) would use.

---

## 5. Dev-server realities

### 5.1 Host and origin checks

**Vite:**
- **Why the check exists:** GHSA-vg6x-rcgg-rjx6 (CVE-2025-24010) found that "Vite did not perform validation on the Host header", so DNS rebinding could read a dev server. The fix shipped in 6.0.9, 5.4.12 and 4.5.6 with `server.allowedHosts` ([advisory](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6)). The same release added a token check on the HMR WebSocket and made `server.cors` default to `false` ([CHANGELOG](https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/CHANGELOG.md)).
- **What passes by default:** `localhost`, names under `.localhost`, and IP addresses, with no option set. "When using HTTPS, this check is skipped" ([server options](https://vite.dev/config/server-options)). A proxy that ends TLS and speaks HTTP to Vite is still checked *(inference)*.
- **Allowing more hosts:** `.example.com` allows every subdomain, and `true` allows any host, which the docs warn against.
- **Without editing the project:** `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` adds hosts, comma-separated.
- **What a blocked host sees:** "Blocked request. This host (…) is not allowed." ([hostCheck.ts](https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/src/node/server/middlewares/hostCheck.ts)).
- **The HMR socket:** it checks the host the same way, and needs the token whenever an `Origin` is present ([ws.ts](https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/src/node/server/ws.ts)).

**Next.js:**
- **The advisory:** `allowedDevOrigins` came with GHSA-3h52-269p-cp9r (CVE-2025-48068), cross-site WebSocket hijacking of the dev server, fixed in 15.2.2 as an opt-in ([advisory](https://github.com/advisories/GHSA-3h52-269p-cp9r)). Next 15 only warned ([v15 docs](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/allowedDevOrigins)).
- **Blocking by default:** the current docs say Next "blocks cross-origin requests to dev-only assets and endpoints during development by default" ([docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins)). The switch is PR #91507, in v16.2.0-canary.103 ([PR](https://github.com/vercel/next.js/pull/91507)). That 16.2.0 stable carries it is my inference from its notes.
- **What is matched:** the `Origin` header's host name, or the `Referer` for no-cors requests.
- **The `Origin: null` advisory:** GHSA-jcc7-9wpm-mj36 (CVE-2026-27977) closed `Origin: null` "as a bypass case" in 16.1.7 ([advisory](https://github.com/vercel/next.js/security/advisories/GHSA-jcc7-9wpm-mj36)). An opaque-origin iframe now loses HMR and dev assets *(inference)*.
- **Binding:** `next dev` binds to `0.0.0.0` by default ([CLI](https://nextjs.org/docs/app/api-reference/cli/next)).
- **Server Actions:** they check origin in production too, and need no entry "as long as the proxy forwards the public host in `x-forwarded-host`" ([serverActions](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)).

**webpack-dev-server:**
- `allowedHosts` defaults to `'auto'`, which allows `localhost`, `host` and `client.webSocketURL.hostname` ([docs](https://webpack.js.org/configuration/dev-server/)).
- CVE-2025-30359 and CVE-2025-30360 were fixed in 5.2.1 ([GHSA-9jgg-88mc-972h](https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-9jgg-88mc-972h)). Later 2026 advisories go up to 5.2.6 ([GHSA-79cf-xcqc-c78w](https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-79cf-xcqc-c78w)).
- Create React App answers "Invalid Host header", and its escape hatch is `DANGEROUSLY_DISABLE_HOST_CHECK` ([CRA](https://create-react-app.dev/docs/proxying-api-requests-in-development/)).
- Angular's `allowed-hosts` "sets the Vite option of the same name" ([Angular](https://angular.dev/cli/serve)).

**Devin's answer to all of this:** rewrite `Host` and `Origin` to `localhost` before the request reaches the app (§1.2). Every check above passes then, because `localhost` is always allowed.
- **What it removes:** the dev server's own defence. That defence exists for a dev server reachable from the member's browser at `localhost`. Behind ostra's proxy, the dev server is reachable only through the proxy, whose own auth takes that defence's place *(inference)*.
- **What the proxy must also do:** rewrite `Location` headers that point at `http://localhost:<port>`. An app that builds absolute URLs from `Host` (an OAuth redirect URI, for example) will still produce `localhost` ones *(inference)*.
- **The alternative:** inject `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` into the agent's environment. Next.js has no environment equivalent that I found.

### 5.2 HMR through a proxy

- **Vite:** "With the default configuration, reverse proxies in front of Vite are expected to support proxying WebSocket" ([server options](https://vite.dev/config/server-options)). The client's fallback connects directly to Vite's port, which from a member's browser can't work. Vite 8.1 moved the HMR network options from `server.hmr` to `server.ws` (CHANGELOG, above).
- **Next.js 16:** it renamed the HMR path from `/_next/webpack-hmr` to `/_next/hmr` ([upgrade guide](https://nextjs.org/docs/pages/guides/upgrading/version-12)). Which 16.x minor made the change is **unconfirmed**, so a proxy should pass upgrades on every path.
- **webpack-dev-server:** `client.webSocketURL: 'auto://0.0.0.0:0/ws'` takes the page's own host ([docs](https://webpack.js.org/configuration/dev-server/)). CRA has `WDS_SOCKET_HOST`, `WDS_SOCKET_PORT` and `WDS_SOCKET_PATH`.
- **The default case:** a proxy on 443 that passes WebSocket upgrades on the same host is what the defaults expect.

### 5.3 Binding inside a box

- **`docker`:** a container has its own loopback: "its port 3000 and your machine's port 3000 are two different things" ([Docker](https://docs.docker.com/learn/content/run-your-first-container)). On a bridge network, a container's ports "are accessible from the Docker host and other containers connected to the same network" ([networking](https://docs.docker.com/engine/network/)), on the container's bridge address. A dev server bound to `127.0.0.1` in the agent's container is out of the sidecar's reach *(inference from namespaces)*. Vite and Angular bind `localhost` by default; Next.js binds `0.0.0.0`.
  - `--network container:` would share the namespace, but would put the sidecar's egress inside the agent's container and undo ADR 0029's internal network *(inference)*.
  - A forwarder in the agent's container (the box's init already runs there, ADR 0029's bridge) can listen on the box's internal address and dial `127.0.0.1:<port>`. Then the agent's defaults work.
  - Ona and OpenHands ask the app to bind `0.0.0.0` instead (§1).
- **`kubernetes`:** "containers that belong to the Pod can communicate with one another using `localhost`" ([Pods](https://kubernetes.io/docs/concepts/workloads/pods/)). The sidecar dials `127.0.0.1:<port>`.
- **`host`:** the runner dials `127.0.0.1:<port>` on the same machine. Two tasks on one machine share its ports, and Vite moves to the next free port when one is taken.

### 5.4 Which port: declared, detected or announced

- **Declared:**
  - devcontainer.json's `forwardPorts` and `portsAttributes`, with `onAutoForward`, `label` and `protocol` ([spec](https://containers.dev/implementors/json_reference/));
  - `.gitpod.yml`'s `ports`, with `onOpen` and `visibility` ([reference](https://ona.com/docs/classic/user/references/gitpod-yml));
  - Replit's `[[ports]]`;
  - Vercel Sandbox's create-time ports.
- **Detected:**
  - VS Code's `process` source reads `/proc/net/tcp` and `/proc/net/tcp6`, keeps rows in state `0A` (listen), maps their inodes to processes, and polls at least every 2 s ([extHostTunnelService.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/api/node/extHostTunnelService.ts)). It falls back to watching terminal output after 20 auto-forwarded ports ([settings](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/remote/common/remote.contribution.ts)).
  - Coder's agent reads listening sockets, IPv6 too, because "Many dev servers (e.g. Next.js, Node's default http.Server) bind to the IPv6 wildcard address" ([ports_supported.go](https://raw.githubusercontent.com/coder/coder/main/agent/ports_supported.go)). It skips a list of non-HTTP ports such as 22, 3306, 5432 and 27017 ([workspacesdk.go](https://raw.githubusercontent.com/coder/coder/main/codersdk/workspacesdk/workspacesdk.go)), on Linux and Windows only.
  - Cursor detects listening ports; WebContainers emit `port` events; OpenHands polls.
- **Announced:** Devin's agent opens a preview "when it starts an app you should look at"; OpenHands tells its agent the ports; Codex is told the port by the user. I found no first-party MCP tool in a major agent product for announcing a port (**unconfirmed**).
- **Within a box:** a listening-port scan is per network namespace *(inference)*.
  - On `kubernetes` the sidecar sees the pod's sockets.
  - On `docker` the scan runs in the agent's container (the init).
  - On `host` it sees the whole machine and must be filtered to the task's processes. ADR 0029's job object or cgroup gives the set on Windows and Linux; macOS has neither, and Coder doesn't detect ports there either.

### 5.5 API servers with no UI

- **Built-in docs:** FastAPI serves `/docs` (Swagger UI) and `/redoc` by default ([FastAPI](https://fastapi.tiangolo.com/tutorial/first-steps/)), so many API servers bring their own console.
- **Editor clients:** Postman's VS Code extension sends "HTTP, raw WebSocket, and gRPC requests" ([Postman](https://learning.postman.com/docs/reference/vs-code-extension/overview)), and Thunder Client is another.
- **Sandbox products:** I found none with a built-in API console for a forwarded port (**unconfirmed**). Cloudflare lists testing endpoints "from external tools" as a use of `exposePort` ([ports API](https://developers.cloudflare.com/sandbox/sdk/api/ports)).
- **For ostra *(inference)*:** the pane can open an API's root or its `/docs`, and the `ostra preview` forward lets a member point their own tools at it.

---

## 6. Screenshots and recordings

| Agent | How | Where it lands | Source |
|---|---|---|---|
| Devin | Computer use in testing mode; a screen recording | "sends it to you as a message attachment" | [testing and recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings) |
| Cursor cloud agents | Computer use in the VM: screenshots and videos | "These artifacts are attached to the PR", by "long, unguessable URLs that are viewable without authentication" | [capabilities](https://cursor.com/docs/cloud-agent/capabilities) |
| Copilot coding agent | Playwright MCP | Screenshots in the PR | [changelog](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser) |
| OpenAI Codex | Its own browser in the task | "attach a screenshot of the result to the task and GitHub PR" | [upgrades](https://openai.com/index/introducing-upgrades-to-codex) |
| Jules | Playwright in its base image | "Jules will send you a screenshot of the front end along with any code changes" | [changelog 2025-08-07](https://jules.google/docs/changelog/2025-08-07) |
| Replit Agent | Self-testing in a browser | A video replay in the Agent pane | [app testing](https://docs.replit.com/features/agent/app-testing) |
| Claude Code (Desktop, local sessions) | Its browser pane: screenshots and DOM | The local session; `.claude/launch.json` names each dev server's port | [desktop](https://code.claude.com/docs/en/desktop) |

Cursor's public artifact URLs are worth noting: a screenshot can show what the app holds. ostra's blob store links need a sign-in (ADR 0043), which is the safer default *(inference)*.

F-121 already plans this: "An environment says how to start the app, and the base image carries a headless browser. A task can start the app in its box, take screenshots, and attach them to its draft, its findings or its PR through the blob store" (`context/features.md`). The answer to Q68 puts it after v1, "first in line".

---

## 7. Designs for ostra

### What the pane would show

Beside the chat on a task's page sits a preview pane with:
- a port menu, with each port's source shown: declared, announced by the agent, or detected;
- a path field;
- reload;
- a width preset;
- "Open in a new tab".

The expanded view is the same pane at full width. Moving an iframe element in the DOM reloads it, so the expanded view should resize the same frame rather than move it *(inference, untested)*. The pane always says where the box stands (ready, idle, stopped), and why a live view isn't offered when it isn't (no preview domain, a runner on the HTTP carrier, a runner below the needed minor). When there's no live view, it shows the latest screenshot.

### Design A: preview hosts through core (the live pane)

**Path:** member's browser → `https://5173-<id>.<preview domain>` → the ingress → core (any replica, forwarding to the one that holds the stream) → the box's preview connection → sidecar → dev server.

- **URL.** `<port>-<previewId>.<preview domain>`, one label. `previewId` is random (128 bits) and belongs to the task, not the box, so the URL survives a reopen on a fresh box, as Devin's does. It's not a secret.
- **Auth: a per-origin cookie, set by a handshake** (the Coder, Ona, Modal and CodeSandbox pattern):
  1. The panel calls a tRPC procedure with the task and port. Core checks that the member can open the task, as for every task read.
  2. Core mints a one-time code: single use, 60 s *(working value)*, bound to the member, the task, the port and the lease epoch. It returns `https://<host>/.ostra/enter?code=…`.
  3. On that host, core sets `__Host-ostra-preview` (HttpOnly, Secure, and `SameSite=None; Partitioned` when the preview domain is another site, `Lax` when it's the panel's site). Then it redirects to the path.
  4. Every request checks the cookie. Its lifetime is capped by the member's panel session and the lease. Core re-checks membership and the lease on each new connection and every few minutes *(working value)*.
- **What the proxy does on every request:**
  - Removes its own cookie and any `X-Forwarded-*` from the client.
  - Never passes the member's identity to the app.
  - Checks `Origin` on WebSocket upgrades (§4.3).
  - Rewrites `Host` and `Origin` to `localhost:<port>`, and `Location` back, as Devin does (§5.1).
  - Removes `X-Frame-Options` and replaces any `frame-ancestors` with the panel's origin only, and the pane says it did. So helmet, Rails, Django and Spring apps show, and no other site can frame the preview.
- **Why not a token in the host:** the host travels in clear in SNI and DNS (§4.4).
- **The iframe:** `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`, with no `allow-top-navigation`. `allow-same-origin` is safe because the origin isn't the panel's, and without it Next.js blocks the app (§4.5, §5.1). The panel's CSP gains `frame-src https://*.<preview domain>`.
- **The data path.**
  - Control rides the session: an event with the box's listening and declared ports, and commands to open and close a preview connection. The sidecar opens its preview connection only when someone is looking, so an idle box holds nothing extra.
  - Bytes ride a separate binary WebSocket, `wss://<core>/runner/v1/preview`, authenticated with the box's task token (ADR 0034; on `host`, the runner's own token), off the session as bulk data is.
  - Over it, HTTP/2 with core as client and the sidecar as server, and extended CONNECT for browser WebSockets (§2.1), all from Node's own modules.
  - Flow control comes from HTTP/2's windows and the socket's `bufferedAmount`.
  - With several core replicas, a presence row for the stream and replica-to-replica forwarding are needed (§2.1). One replica needs neither.
- **The protocol.** A new minor carries the event, the commands, the endpoint and a capability in `hello`. 6 is the next one; milestone 7's ticket 01 reserved it and is on hold. A runner below it gets no preview, and the pane says the runner needs upgrading.
- **On each executor:**
  - **`docker`:** a forwarder in the agent's container, run by the init, reaches the agent's `127.0.0.1`, so the app's default binding works (§5.3). Detection runs there too.
  - **`kubernetes`:** the sidecar dials the pod's `127.0.0.1`.
  - **`host`:** the runner dials `127.0.0.1` on its machine.
  - The preview may reach only ports that belong to the task: declared, announced, or found by a scan filtered to the task's processes. It never reaches the sidecar's own ports (the key proxy, the git proxy, its control API) or OpenCode's loopback port. Without that rule, a preview on `kubernetes` (shared `localhost`) or on `host` (the whole machine's loopback) could reach things that aren't the app. Daytona's reserved ports are the same idea.
  - On macOS `host` runners, which can't scan per task, only declared and announced ports work. That's a runner-parity question to record.
- **The HTTP fallback carrier.** No live preview over it in the first version. The pane says the runner reaches the server over HTTP only, and shows screenshots. That's a difference by network, not by executor, but AGENTS.md's parity rule would want it written down.
- **Idle and stopped boxes (ADR 0039).**
  - While a member has the pane open, the panel's heartbeat, not the app's HMR WebSocket (CodeSandbox's and Cloudflare's lesson), holds the box past the 15-minute idle timer, up to a cap of another 15 minutes after the last heartbeat *(working value)*.
  - When the box stops, the dev server is gone (and on `kubernetes` the pod). The pane shows the last screenshot and offers to start the app again. That needs F-121's "how to start the app" and a box started without an agent turn, which is an open question.
  - A new lease points the task's `previewId` at the new box, and core refuses preview connections from a stale epoch, as it refuses events.
- **What a self-hoster configures:**
  - one setting, the preview domain (working name `OSTRA_PREVIEW_DOMAIN`, unset by default);
  - one wildcard DNS record to the ingress in front of core;
  - a wildcard certificate (DNS-01 with Let's Encrypt);
  - WebSocket upgrades passed through on those hosts, as runners already need.

  Several core replicas also need each replica's internal address. Unset, there's no live pane, and screenshots and `ostra preview` still work. In development it could default to `preview.localhost` (§3.5). The docs recommend a registrable domain of its own (v0, Cloudflare, Google) and allow a subdomain of the panel's domain with a warning. That's Coder's own layout, with §4.3's lessons applied.
- **Cost.** Preview bytes cross core only while someone watches. That's bounded by open panes, not by running tasks, unlike the model traffic ADR 0030 kept off the server.

### Design B: the box's browser, streamed (pixels, not code)

The box's headless browser, which F-121 already puts in the base image, loads the dev server at `localhost`. The sidecar streams it to the pane and the member's input back.
- **The stream:** Chrome DevTools Protocol `Page.startScreencast` sends frames as `jpeg` or `png`. `quality`, `maxWidth`, `maxHeight` and `everyNthFrame` set its cost, and `maxFramesInFlight` (default 3) with `screencastFrameAck` gives back-pressure ([Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)).
- **Input:** `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` and `imeSetComposition` carry it back ([Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)).
- **The precedents:** Cursor's remote desktop and Devin's browser viewer are this kind of view (§1.2).

What it gets:
- **No untrusted code in the member's browser.** It draws images, which the panel's `img-src blob: data:` already allows.
- **No new origin, no DNS, nothing to configure.**
- **No dev-server host checks to satisfy,** since the browser is local to the app.
- **The same view on every executor.**
- **The HTTP carrier works,** if slowly: frames go up in batches and input rides commands down the long poll *(inference)*.

What it costs:
- **A browser running in the box while someone watches,** against the box's size (small is 2 vCPU and 4 GB, ADR 0029).
- **Bandwidth through core** that depends on size, quality and frame rate. Not measured here.
- **Input lag of a round trip to the box.**
- **No devtools for the member.**
- **No real check on the member's own device, clipboard or file uploads,** short of more protocol work.

It needs a new minor too, since frames and input are new messages.

### Design C: a tunnel the organization brings

The sidecar runs a tunnel client (cloudflared, ngrok, Tailscale Funnel) with the organization's own account, and the pane frames the vendor's URL.
- **What it gets:** little ostra code.
- **What it costs:**
  - the vendor sees plaintext (except Funnel);
  - the vendor's auth replaces ostra's;
  - the sidecar needs an egress exception (port 7844 for cloudflared);
  - quick tunnels are testing-only and ngrok's free interstitial blocks iframes;
  - it adds a vendor the maintainer hasn't chosen (§2.2).
- **Where it fits:** if wanted, as an adapter kind that ADR 0025 would have to gain, never as the default.

A self-hoster whose core sits behind NAT can still put core itself behind their own tunnel. That's an ingress choice ADR 0013's docs already mention. Whether a named Cloudflare Tunnel routes a wildcard host is **unconfirmed**. Funnel can't, since it serves only `tailnet-name.ts.net` names *(inference)*.

### Shared by every design

- **Screenshots and recordings (F-121).** Playwright in the box, run by the agent through an ostra MCP tool, or after a turn for the environment's declared routes. The images go to the timeline through the blob store and are linked from the PR. They need no setting, work on every executor and carrier, survive the box stopping, and make the review screen better whether or not anyone watched live.
- **`ostra preview <task> [port]`.** The CLI (`ostra login`, F-103) opens the same preview connection and serves the port at the member's own `http://localhost:<port>`, as `coder port-forward`, `devin forward` and Cursor's forwarding do.
  - No DNS and no host-check trouble, since the host is `localhost`.
  - It opens in a tab. Framing it in the panel meets Chrome's local-network permission (§4.5).
  - It needs Design A's data path, not its domain.

### Comparison

| | A: preview hosts through core | B: the box's browser, streamed | C: the org's tunnel |
|---|---|---|---|
| Live in the pane | Yes, a real browser on the member's machine | Yes, as pixels | Yes |
| Self-hoster's setting | Preview domain, wildcard DNS and certificate | None | A vendor account and egress exception |
| New protocol minor | Yes | Yes | Yes (a tunnel spec in the dispatch) |
| `docker` / `kubernetes` / `host` | All three; a forwarder in the agent's container on `docker`; per-task port filtering on `host` | All three; a browser in the box or on the host | All three, if egress allows |
| HTTP fallback carrier | Not in the first version | Works, slowly | Separate from ostra's carrier |
| Box idle or stopped | Heartbeat holds it; then the last screenshot and "start the app" | Same | The tunnel dies with the box |
| Untrusted code runs in the member's browser | Yes, on its own origin | No | Yes, on the vendor's origin |
| Who decides access | ostra | ostra | The vendor |

### Recommendation

1. **Default, with no setting: screenshots and recordings in the timeline (F-121).** It's what most cloud agents ship (§6). It works everywhere ostra runs, and it's the fallback for every case where a live view can't work.
2. **The live pane: Design A, on when an admin sets a preview domain.** The panel's setup page names the one record and the certificate to add. The same data path powers `ostra preview` with no setting at all. Through core is the right transport: it already dials out on 443, it keeps ostra's own access rules, and it needs no vendor.
3. **Keep Design B as the follow-up** for installs that can't add a wildcard but want a live pane. Most of it (the browser in the box) comes with F-121 anyway.
4. **No built-in third-party tunnel,** and no tunnel as the default.
5. **Spike before the ADR:**
   - HTTP/2 with extended CONNECT over a `ws` duplex;
   - the `docker` forwarder;
   - a Vite and a Next.js 16 app through the Host and Origin rewrite;
   - a partitioned preview cookie in an iframe on Safari, Firefox and Chrome;
   - `*.localhost` in each browser;
   - the extra latency of a page load through core, measured and not guessed.

---

## Open questions for the maintainer

1. **Is one wildcard DNS name and certificate an acceptable ask for the live pane,** with screenshots as the no-setting default? Or must a live view work with no setting, which points to Design B first?
2. **A registrable domain of its own for previews, or a subdomain of the panel's domain?** The first is what v0, Cloudflare and Google advise. The second is Coder's layout and easier for a self-hoster. Allow both, recommend the first?
3. **Should watching a preview keep a box warm past the 15-minute idle timer,** and for how long? It costs compute, and ADR 0042's budgets count model spend only.
4. **May "start the app again" start a box with no agent turn,** from the branch, the hidden ref and the environment's start command (F-121), to serve a preview of a stopped task?
5. **Sharing:** members of the project only (each with their own handshake), or also expiring links for people outside it, as Lovable and Vercel do? If yes, who may make them?
6. **Several core replicas:** accept replica-to-replica forwarding for preview streams (ADR 0034 set it aside for commands), or require previews to be served by one replica?
7. **The HTTP fallback carrier:** no live preview over it, recorded as a known limit? Or a degraded mode over long polls?
8. **Is rewriting `Host` and `Origin` to `localhost` acceptable as the default?** It's Devin's answer, and it removes the dev server's own DNS-rebinding defence behind ostra's proxy. The other choice is configuring each framework (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, `allowedDevOrigins`).
9. **Where does F-121 move?** A live pane depends on the box's browser and the start command that F-121 brings. Q68 put it after v1, "first in line".

## Unconfirmed, listed together

- **Hosted products:**
  - Cursor's forward URL shape and auth model;
  - Lovable's default preview host (`lovableproject.com`);
  - Ona's port URL shape;
  - the Codespaces behaviour of a stopped codespace's port URL, and its iframe guidance;
  - Gitpod's and Coder's behaviour when a workspace is stopped;
  - Modal's wake on request;
  - whether an HTTP request wakes a stopped Vercel Sandbox (its error page implies not);
  - the CodeSandbox changelog of 2025-04-04, read in a search excerpt only.
- **Tunnels:**
  - the current ngrok agent's licence;
  - Tailscale Funnel's WebSocket support and any auth on a Funnel URL;
  - the public `loca.lt` service;
  - zrok's WebSocket support;
  - whether a named Cloudflare Tunnel routes a wildcard host.
- **Browsers and frameworks:**
  - whether every major browser resolves `*.localhost` to loopback;
  - that Next.js 16.2.0 stable blocks dev origins (the canary does), and which 16.x minor renamed the HMR path;
  - a first-party MCP tool in a major agent product that announces a port;
  - a sandbox product with a built-in API console.
- **Repo:** the prefix of ostra's own session cookie name.
- **Ideas no source tested:**
  - Node's HTTP/2 with extended CONNECT over a `ws` duplex, end to end;
  - Design A's and B's latency and bandwidth;
  - reparenting an iframe without a reload.

## What this means for ostra

- **The shape ostra already has is the right one for previews.** Core relays the browser's traffic to the box over a connection the box dialled out, like Coder and Teleport. No tunnel vendor sits in the middle, and ostra's own membership and lease rules decide who sees an app.
- **The one thing ostra can't avoid asking a self-hoster for a live in-browser preview is a wildcard name and certificate.** Every self-hosted product in this field asks the same. Path-based proxying breaks dev servers, and on the panel's origin it hands agent code the member's session.
- **What needs nothing and works everywhere is screenshots and recordings in the timeline.** F-121 already plans them. They should come first, and a live pane on a preview domain should follow. A streamed view of the box's browser (Design B) is the answer if installs without a wildcard want a live pane too.
- **Either live design is a new protocol minor** and an ADR covering the preview connection, the preview domain, the idle rule and the HTTP-carrier limit. The open questions above are what the maintainer would settle first.
