# 37: The first-run checklist and setup screens

Status: in-progress
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

- [ ] A Playwright run on a fresh dev stack, with the stub model endpoint and the fake GitHub, goes from "Create the first admin" to a runner approved, and every step ticks.
- [x] Each form shows the router's typed failures in words (a 401 from the endpoint, missing App permissions, a repo the App can't see).
- [x] No form echoes a secret back after it's saved.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the first-run checklist and setup`.

## Comments

- 2026-11-18 (web): built every screen: "Create the first admin", the checklist on Home (`setup.status`, Linear as milestone 2), Models (test connection with format detection and catalog matches, the detected format preselected and correctable, custom models editable, the sessions cap, "Allow on personal runners" off by default with its warning, "Use as default model"), GitHub ("Use an existing App" and "Create a new App" posting the manifest; the callback is `/api/github/manifest/callback`), Create a project (installation and repo picker), the environment editor (draft with detection's reasons, services marked "not on host", secrets write-only), Runners (the `pnpm ostra runner --server <OSTRA_CORE_PUBLIC_URL>` command, your runners appearing online labelled "personal, not isolated", pools and join tokens for admins) and `/device` (enter or confirm the code, approve or deny; sign-in returns to it). Optimistic writes with `onMutate` and rollback on the provider settings and the default model; the stream's change notices invalidate the views. Playwright covers the first admin, the provider form against the stub model endpoint (a 401 in words, the models matched, the token never shown back, the default model) and a refused GitHub App in words.
- Not yet: the one Playwright run from the first admin to a runner approved. It needs a fake GitHub reachable over HTTP from the panel (adapter-github's `fake-github.ts` isn't exported, and the panel has no setting for GitHub's API address) and a runner in the e2e stack. Ticket 39's demo runs the same path for real.
