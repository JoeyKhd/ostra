# 37: The first-run checklist and setup screens

Status: resolved
Builder: web
Blocked by: 31, 32, 35
Features: F-076, F-002, F-088, F-006, F-086, F-050, F-112, F-014 (device approval)
Packages: `apps/web`
Spec: `../spec.md`, section 3 (steps 2 to 6)

## What to build

The screens of ticket 34 (or the concepts until they're approved), on ticket 30 to 32's routers.

- **Create the first admin:** shown only while no account exists; the setup token, username, email, password, organization name. A wrong token gets one clear line and nothing else.
- **The checklist** on Home for a new organization, from `setup.status`, in F-076's order: admin, model provider, GitHub App, first project, runner online, first task. Linear is shown as "milestone 2" and skipped.
- **Model providers** (Organization › Models): the form (base URL, token, format with the detected one preselected and correctable), Test connection's result, the models with their names, logos (served by ostra), limits and prices, custom models editable, the sessions cap, **Allow on personal runners** (off by default, with a line saying a key sent to a member's machine can be read by that member), and "Use as default model".
- **Connect GitHub:** "Use an existing App" (App ID, private key, webhook secret; the result shows the slug and the permissions) and "Create a new App" (the manifest flow; when the panel has no public address, it says the App will have no events until one exists).
- **Create a project:** name, the repo picker from the installation, then the environment draft with its reasons, editable (setup script, variables and secrets per repo, files), and Save.
- **Connect a runner:** the command to run, the device page (`/device`: enter or confirm the code, approve), and the runner appearing online, labelled "personal, not isolated".
- Optimistic writes with TanStack Query's `onMutate`, rolled back on error; the change notices from the stream confirm them.

## Done when

- [x] A Playwright run on a fresh dev stack, with the stub model endpoint and the fake GitHub, goes from "Create the first admin" to a runner approved, and every step ticks. (`apps/web/e2e/01-shell`, `02-setup` and `03-first-run`; the runner is the real `ostra runner`, see the 2026-11-19 comment.)
- [x] Each form shows the router's typed failures in words (a 401 from the endpoint, missing App permissions, a repo the App can't see).
- [x] No form echoes a secret back after it's saved.
- [x] Package checks pass.
- [x] Committed: the screens with the panel shell and the tickets after it, and the Playwright run as `cbb89a3` (`🐛 fix review findings in context/specs/m1-first-pr + apps/web`).

## Comments

- 2026-11-18 (web): built every screen: "Create the first admin", the checklist on Home (`setup.status`, Linear as milestone 2), Models (test connection with format detection and catalog matches, the detected format preselected and correctable, custom models editable, the sessions cap, "Allow on personal runners" off by default with its warning, "Use as default model"), GitHub ("Use an existing App" and "Create a new App" posting the manifest; the callback is `/api/github/manifest/callback`), Create a project (installation and repo picker), the environment editor (draft with detection's reasons, services marked "not on host", secrets write-only), Runners (the `pnpm ostra runner --server <OSTRA_CORE_PUBLIC_URL>` command, your runners appearing online labelled "personal, not isolated", pools and join tokens for admins) and `/device` (enter or confirm the code, approve or deny; sign-in returns to it). Optimistic writes with `onMutate` and rollback on the provider settings and the default model; the stream's change notices invalidate the views. Playwright covers the first admin, the provider form against the stub model endpoint (a 401 in words, the models matched, the token never shown back, the default model) and a refused GitHub App in words.
- Not yet: the one Playwright run from the first admin to a runner approved. It needs a fake GitHub reachable over HTTP from the panel (adapter-github's `fake-github.ts` isn't exported, and the panel has no setting for GitHub's API address) and a runner in the e2e stack. Ticket 39's demo runs the same path for real.
- 2026-11-19 (web): the Playwright run is written, and the two things it was waiting for exist. `OSTRA_GITHUB_API_URL` (default `https://api.github.com`, in `docs/configuration.md`) is a server setting that the panel and core hand to the GitHub adapter, which is also how a GitHub Enterprise Server is reached. `@ostra/adapter-github/testing` exports the fake GitHub. The e2e stack (`apps/web/e2e/stack.ts`) starts the fake with one org and one repo, and core, both pointed at it. `03-first-run.spec.ts` then connects the fake's App with "Use an existing App" (the key and the secret never come back to the page), creates the project from its repo, saves the environment draft, and starts the real `ostra runner` on the `host` executor (a minimal environment, its own folder), types its device code at `/device`, approves it, and sees it online, "personal", `host`, "not isolated". The checklist then shows every step ticked but "first task", which needs a model; the run before it (`02-setup`) did the first admin and the provider against the stub endpoint. A real runner stands in for a fake one: it needs no Docker, and it checks the device flow and core's register end to end. Ran at desktop width, 8 of 8 in the three specs, and the whole suite (24 tests, 8 skipped at phone width) passes. The task page's specs moved to `04-task.spec.ts`, because Home stops showing the checklist once a task exists.
- 2026-11-19 (web): the "Create the first admin" form and the `01-shell.spec.ts` run that covers it are built for the setup-token flow. The maintainer has since decided that a fresh install creates its first admin from settings (`demo@demo.com` / `demo` by default; `app-targets/m1/README.md`). When that is built, the form, the `needsFirstAdmin` redirect and the first test of `01-shell.spec.ts` change with it; `03-first-run.spec.ts` does not depend on the form, only on an admin who can sign in.
