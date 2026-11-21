# 05: Domain: app processes, attachments, previews and sharing

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: 01, 04
Features: F-121, F-140, F-141, F-142, F-143, F-144
Packages: `packages/domain`, `context/domain-model.md`, `docs/configuration.md`
Spec: `../spec.md`, section 5.4 (ticket 05's half) and the settings table; ADR 0068

## What to build

The pure rules and the use-case signatures that core, the API and the runner's tickets call. Bodies that need the database are core's and the API's tickets; this ticket gives each one its input check, its result union and its tests.

- **Schemas:**
  - `appProcessSchema` for the environment's form and the proposal, with the rules: one primary, unique names and ports, no port below 1024, no reserved port, a folder that stays inside its repo;
  - the ready check;
  - the screenshot settings;
  - a service's preview label.
- **Lifecycles,** each a discriminated union with exhaustive tests, drawn in `context/domain-model.md` beside the box's:
  - an app process in a box: `stopped` → `starting` → `ready` | `failed`, then `ready` → `exited` | `stopped`;
  - a view: `opening` → `open` → `closed`;
  - a link: `active` → `expired` | `revoked`;
  - a lease's purpose: an `app` lease that a member's message turns into a turn.
- **Rules:**
  - `previewTargets(environment, announced)`: the previews in order, primary first, each with its key, label and source;
  - `mayReach(port, targets, reserved)`;
  - `previewAccess(viewer, task, project, access, organizationSettings, now)` → `allowed { input }` | `refused { reason }`. A viewer is a member or a link. It fails closed on anything it doesn't know;
  - `warmHold(box, now, settings)` → `hold` | `idle`, with the app's own sockets never counted;
  - `previewHost(port, previewId, domain)` and `parsePreviewHost(host, domain)`, which give a key to look up, never a decision;
  - `rewriteRequest(headers, { port, hostRewrite, outsideLink })` and `rewriteResponse(headers, { panelOrigin, previewHost })`, pure over header maps: the strips, the `Host`, `Origin` and `Location` rewrites, the kept `Origin` on an outside link's WebSocket upgrade, `X-Frame-Options` removed and `frame-ancestors` replaced (ADR 0068);
  - `appAddresses(processes, services, executor)` → the `OSTRA_APP_*_URL` and `OSTRA_SERVICE_*_URL` variables;
  - detection's readers: `forwardPorts` and `portsAttributes`, `.gitpod.yml` and `.replit` ports, `package.json`'s `dev` and `start` scripts, and a Vite config's `server.port` and `server.proxy` keys. Each reads the file as text and never runs it, and `detect.ts` calls them.
- **Tokens,** each with its tests for single use, binding and expiry:
  - a link's token: 32 random bytes, stored as a SHA-256, and compared in constant time;
  - the one-time code and the CLI ticket: single use, 60 s, bound to the member or link, the task, the port and the lease epoch;
  - the panel's preview token to core, modelled on `panel-blob-token.ts`: one view, one member or link, a minute, an HMAC under the secrets key;
  - the replica signature: an HMAC over the method, the path, the view and the time, refused after 30 s.
- **Use-case signatures:** those of spec section 5.4, ticket 05's list.
- **Jobs' names and keys:** `preview.views-sweep` and `preview.codes-sweep`.
- **Audit actions:** `app.started`, `preview.level_changed`, `preview.link_created`, `preview.link_revoked`, `preview.link_first_used`.
- **Settings:** `OSTRA_PREVIEW_DOMAIN`, `OSTRA_PREVIEW_WARM_MINUTES`, `OSTRA_PREVIEW_LINK_MAX_DAYS`, `OSTRA_CORE_REPLICA_URL`, `OSTRA_RUNNER_BROWSER` and `OSTRA_RUNNER_BROWSER_DOWNLOAD`, each with its default and its line in `docs/configuration.md`.

## Done when

- [ ] Tests named for `F-140`:
  - the environment's rules, with a near miss for each;
  - the readers over each file kind, with a file that holds a command line that would write a marker if run, and doesn't;
  - the addresses per executor.
- [ ] Tests named for `F-141`:
  - `mayReach` refuses every reserved port (break-it: drop the reserved list, and the case fails);
  - `warmHold` holds to the cap and not past it, and ignores the app's own sockets.
- [ ] Tests named for `F-142`: each level for a member, a named person, an outsider, an expired link, a revoked link, and a public link where the organization forbids it, each with its reason, and none allowed by default.
- [ ] Tests named for `F-144`:
  - the rewrites for `hostRewrite` on and off, and for an outside link's upgrade;
  - the framing header replaced;
  - a client's `X-Forwarded-Host` stripped;
  - `parsePreviewHost` with a malformed or too-long label.
- [ ] The tokens' tests pass, and none of them appears in a log line in any test (the log guard).
- [ ] `domain-model.md` draws the new lifecycles, and `packages/domain`'s settings test passes with the new lines in `docs/configuration.md`.
- [ ] Checks for the touched packages pass (spec section 10).
- [ ] Committed as `✨ add the previews and app processes domain`.

## Comments
