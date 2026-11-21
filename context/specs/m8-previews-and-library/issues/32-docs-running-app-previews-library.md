# 32: Docs: the running app, previews, the preview domain and the library

Status: done
Builder: core
Blocked by: 17, 21, 24, 26, 31
Features: F-121, F-140, F-141, F-142, F-143, F-144, F-145, F-146 (their docs)
Packages: `apps/docs/content/`, `docs/configuration.md`
Spec: `../spec.md`, sections 1 and 6; ADR 0068, ADR 0069

## What to build

Pages on the docs site (ADR 0063), written as Markdown both of its paths render. Every `run` block is checked in the proof job as milestone 7's are.

- **`using-ostra/the-running-app.mdx`:**
  - declaring app processes, and onboarding's proposals;
  - the one-origin convention, with a Vite `server.proxy` and a Next.js rewrite as examples;
  - screenshots and recordings, and what the after-turn ones take;
  - what the box's browser can reach on each executor;
  - a frontend that calls its API by an absolute URL, and why that breaks outside the box.
- **`using-ostra/previews.mdx`:**
  - the pane and its expanded view;
  - warm while watched, and "Start the app";
  - the four levels, links and the viewer page, and watch-only;
  - `ostra preview`;
  - the HTTP carrier's limits;
  - webhooks into the app through forwarders (Stripe CLI, `gh webhook forward`, smee), with why ostra has no entry point, and that on `docker` they wait for network allowlists;
  - OAuth callbacks at `localhost` in the box's browser and through `ostra preview`, and with the native preview's `hostRewrite` off.
- **`install/preview-domain.mdx`:**
  - a domain of its own, recommended, or a subdomain of the panel's, with its warning;
  - the wildcard DNS record, the wildcard certificate through DNS-01, and passing WebSocket upgrades, for compose behind a proxy and for the Helm chart;
  - `preview.localhost` for development;
  - several replicas and `OSTRA_CORE_REPLICA_URL`;
  - "the panel's settings page checks it".
- **`agents-and-models/library.mdx`:**
  - installing by reference, with each form;
  - pins and hashes, and how the hash matches `skills-lock.json`;
  - the allowlist;
  - MCP servers from a registry, secrets, the test call, and what isn't installable yet and why;
  - attaching and every profile;
  - updates and their diffs;
  - suggestions;
  - the marketplace browser, its switch, and that skills.sh's search endpoint is undocumented.
- **`security/the-box.mdx`, grown:** the box's browser holds nothing secret; what a preview may reach; the preview origin and the panel's own cookie; links are bearer secrets; library items are untrusted text the agent reads.
- **`reference/cli.mdx`, grown:** `ostra preview` (ticket 24 writes its reference entry; this page links it from the guide).
- **The configuration reference** renders the new settings from `docs/configuration.md`, which tickets 05 and 06 wrote.

## Done when

- [x] The pages exist, are in the site's navigation, and build. *`pnpm --filter @ostra/docs build` and `check:export` pass, 2026-11-21.*
- [x] The configuration reference lists every new setting, and `packages/domain`'s settings test passes. *Tickets 05, 06 and 11 wrote all nine lines; nothing was missing.*
- [x] Each `run` block parses, and the proof job's run of them is recorded or marked as waiting. *The `docs-commands` job's run waits for the launch-gate Proof run (the maintainer, 2026-11-21).* *No page gained a `run` block: every new command needs the reader's own values. `scripts/check-docs-commands.test.ts` passes, 2026-11-21.*
- [x] Committed as `📝 document previews and the library`.

## Comments

- 2026-11-21, core: committed as `📝 document previews and the library`. Written from the code and the tickets' comments, not the plan:
  - **New pages:** `using-ostra/the-running-app.mdx` (app processes and their fields, the in-box addresses, the four ways into the list, one origin with Vite's `server.proxy` and a Next.js rewrite, the absolute-URL table, the dev-server notes, screenshots and recordings, the box's browser on each executor), `using-ostra/previews.mdx` (the pane, the browser view, warm while watched, "Start the app", the four levels, links, the link's page, the native preview, `ostra preview`, the HTTP carrier's and minor 6's limits, webhook forwarders, OAuth callbacks), `install/preview-domain.mdx` (a domain of its own or a subdomain, why HTTPS, the record, the DNS-01 certificate, routing with `Host` kept and upgrades passed, compose with an nginx block and Helm with an Ingress matching `deploy/`'s commented examples, replicas, `preview.localhost`, the handshake and its cookie, the proxy's rewrites, the check on Instance › Previews; the panel links this page from `instance.previews`) and `agents-and-models/library.mdx` (install by reference with each form, pins and the `skills-lock.json` hash, the allowlist, registry servers, secrets and the test call, what isn't installable, attaching and every profile, repo skills against library skills, updates, suggestions, the marketplace, the server's calls). All four are in the navigation.
  - **Grown:** `security/the-box.mdx` (the box's browser, what a preview may reach, the preview origin and the panel's cookie, links as bearer secrets, library items as untrusted text), `reference/cli.mdx` (links the guide from `ostra preview`, which ticket 24 wrote), `runners/http-fallback.mdx` (previews over HTTP; its stale note that the fallback comes with milestone 5 is gone), `runners/executors.mdx`, `reference/ports.mdx`, `agents-and-models/agent-profiles.mdx`, `using-ostra/tasks.mdx` and `start/what-ostra-is.mdx`, and `README.md`'s milestone 8 row.
  - **Vite's `server.allowedHosts`:** with "Rewrite the host" on, the default, the proxy sends `Host: localhost:<port>` and Vite, Next.js and webpack-dev-server need nothing (spike 08). With it off, the app gets the preview's host, so the page names Vite's `server.allowedHosts`, Next.js's `allowedDevOrigins` and webpack-dev-server's `allowedHosts`. On `preview.localhost` none is needed.
  - **Where the code differs from the plan, as documented:** named people get the preview in the API, but no notification and no page of their own to watch from (ticket 20's open point), so the page says so and points at links; "Allow public preview links" is only on Instance › Previews, a page the instance admin alone opens, since no Organization › Settings page exists (ticket 26); the library is Organization › Skills and MCP (`/organization/skills`); an environment's own base image needs Chromium at `/usr/bin/chromium` (`OSTRA_BOX_BROWSER` isn't a setting, ticket 11); the update's dismiss reads `Keep <pin>`.
  - **Found, not fixed (code, outside this ticket):** the setup checklist's docs links in `packages/api/src/routers/setup.ts` (`#3-connect-github`, `#5-create-a-project`, `#6-connect-a-runner`) miss the docs site's step anchors, which drop the number (`#connect-github`).
  - **Checks:** `pnpm --filter @ostra/docs build`, `check:export`, its typecheck, lint and tests; `scripts/check-docs-commands.test.ts`; `packages/domain`'s `settings-docs-reference.test.ts`; `apps/runner`'s `cli-docs-reference.test.ts`; every internal link and anchor of the export resolves.
