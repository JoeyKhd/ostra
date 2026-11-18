# 37: The first-run checklist and setup screens

Status: ready-for-agent
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
- [ ] Each form shows the router's typed failures in words (a 401 from the endpoint, missing App permissions, a repo the App can't see).
- [ ] No form echoes a secret back after it's saved.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the first-run checklist and setup`.

## Comments
