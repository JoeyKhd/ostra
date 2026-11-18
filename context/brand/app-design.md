# App design: the console

How every screen of ostra's panel is laid out. This is the direction from 2026-11-18. The maintainer: "i really like northflanks ui". The **structure** is learned from Northflank's console. Colours, logo, type and voice stay ostra's own (`brief.md`).

**Status:** a direction with six concept screens. These are not approved targets yet. A screen becomes a target, in `app-targets/`, when its milestone starts and the maintainer approves it (`build-order.md`).

## The structure

1. **Top bar: breadcrumb switchers.** The mark, then `Organization ▾` / `Project ▾` / the current section. Each crumb switches with one click. On the right: search (⌘K), the needs-you bell (an amber count), help, one primary **"+ Create new"** button (task, project, pool, provider), and the avatar.
2. **A tab bar per level, under the top bar:**
   - organization: Dashboard, Projects, Runner pools, Models, Insights, Members, Audit log, Settings
   - project: Dashboard, Tasks, Inbox, Environment, Automations, Repos, Settings

   The selected tab gets a tinted background (`#1B3A39`) with a thin off-white marker.
3. **Every resource (organization, project, task, environment, pool) opens with a header and a status strip:**
   - the header: an icon tile, the name in Manrope, its ID in mono with a copy button, and chips (tracker, branch)
   - the strip: one line of the resource's live facts, separated by thin rules (box, agent and model, status pill, driver, tokens and cost, a resource bar)
4. **A left sub-menu, only inside a resource** (task, environment, pool), grouped under small uppercase mono labels: SESSION / CONTEXT / OBSERVE, or SETUP / RUN / HISTORY. Organization and project dashboards use only tabs.
5. **Dashboards are a grid of cards.** Each card has an icon, a title and a "View all" outline button, with dense rows inside. "Needs you" is always the first card.
6. **Tables, logs and code are dense and in mono:** IDs, branches, commits, times, model IDs, log lines.

## Colours (from `brief.md`, plus the status colours)

| Role | Colour |
|---|---|
| Background | Abyss `#0C1D21` |
| Cards | `#10262A` with 1px Kelp `#2F4A47` borders |
| Text, secondary text | Shell `#F3F0E8`, Mist `#CFD8D4` |
| Selected tab or menu item | `#1B3A39` + an off-white marker |
| **Healthy / success** (new) | muted green `#4FB286`, always with an icon |
| **Needs you** (only this) | Buoy Amber `#FFB224` |
| Primary button | filled Shell, with Abyss text |
| Error | to be defined with the first error states. Never amber |

## Concept screens (2026-11-18)

They're in `app-concepts/` and are made by `app-concepts/prompts/make-prompts-v2.py` (GPT Image 2.6 through Higgsfield). Model names and prices come from models.dev on 2026-11-18. Everything else is demo data.

| Screen | File |
|---|---|
| Organization dashboard | `06-org-dashboard.png` |
| Project dashboard ("calculator") | `07-project-dashboard.png` |
| A running task | `08-task.png` |
| The project's environment | `09-environment.png` |
| Runner pools | `10-runner-pools.png`. **Its left menu (Billing, Images, Deployments, Traces, Policies) was invented by the image model** and isn't part of the product. Organization pages use tabs only (rule 4) |
| Models and providers | `11-models.png` |

The first round (`01`–`05`) used a left sidebar and is superseded by this direction.
