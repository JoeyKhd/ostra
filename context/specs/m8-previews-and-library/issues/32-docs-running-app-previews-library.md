# 32: Docs: the running app, previews, the preview domain and the library

Status: ready-for-agent
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

- [ ] The pages exist, are in the site's navigation, and build.
- [ ] The configuration reference lists every new setting, and `packages/domain`'s settings test passes.
- [ ] Each `run` block parses, and the proof job's run of them is recorded or marked as waiting. *The `docs-commands` job's run waits for the launch-gate Proof run (the maintainer, 2026-11-21).*
- [ ] Committed as `📝 document previews and the library`.

## Comments
