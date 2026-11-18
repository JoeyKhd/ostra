# Screen concepts

The first pictures of ostra's panel, made on 2026-11-18 to check that the maintainer and the plan picture the same product. **These are concepts, not approved targets.** A screen becomes a target (`brand/app-targets/`) only when its milestone starts and the maintainer approves it (`build-order.md`).

All data is invented demo data: the team "Acme", tickets "ENG-…", people and repos.

| Screen | File | Features it shows |
|---|---|---|
| Home, with "needs you" first | `01-home.png` | F-062, F-036, F-026, F-024 |
| A running task | `02-task-v2.png` (the first attempt, `02-task.png`, had garbled text and an amber "Running" pill) | F-023, F-024, F-025, F-026, F-027, F-072, F-084 |
| Inbox with "Start task" open | `03-inbox.png` | F-010, F-064, F-063, F-069 |
| First-run setup | `04-setup-v2.png` (the first attempt, `04-setup.png`, used amber outside "needs you") | F-076, F-005, F-006, F-050, F-013 |
| Phone: approving from "needs you" | `05-phone.png` | F-075, F-026 |

## How they're made

- **Prompts:** `prompts/make-prompts.py` writes the prompts. Each states the screen's real copy and controls and the brand (`brand/brief.md`), and attaches the Shell mark as a reference image (`kit/logo/export/ostra-hinge-single-color-2048.png`).
- **Model:** GPT Image 2.6 through the Higgsfield CLI: `higgsfield generate create gpt_image_2_6 --aspect_ratio 3:2 --resolution 2k --quality high --image <mark>`. That's about 2.75 credits a screen (2026-11-18).
  - Desktop screens come out at 2048×1360 and phone screens at 1520×2688.
  - GPT Image 2.0 (`01`, `03`, `05`, and the first attempts) costs about 6.5 credits and is less reliable with small text.
- **Known slips** still in the v2 files, to fix when they become targets:
  - the task meta line is missing a "·" before "Claude Code"
  - setup says "3 of 7 done" with two steps checked

## Round 2 (2026-11-18): the console direction

The maintainer liked Northflank's console, so round 2 learns its structure and keeps ostra's brand, at a real company's scale. The direction and its rules are in `brand/app-design.md`. The screens are `06-org-dashboard.png`, `07-project-dashboard.png`, `08-task.png`, `09-environment.png`, `10-runner-pools.png` and `11-models.png`, made by `prompts/make-prompts-v2.py` with GPT Image 2.6 at about 2.75 credits each. **In `10-runner-pools.png` the left menu is invented by the image model** and isn't part of the product. Round 1 (`01`–`05`) is superseded.

## Round 3 (2026-11-18): real HTML, two directions

The maintainer rejected round 2 ("the ui is FUCKING ugly"). The diagnosis: everything was too big and chunky, there were boxes inside boxes, the murky teal background made the whole app feel muddy, and image-model mockups look clumsy. So round 3 is real HTML, with real fonts and Lucide icons, at a 1440×900 laptop size, rendered at 2×. It uses neutral chrome with brand colours only as accents, 12.5–13.5px text, and few borders. The data is the same in both.

| Direction | File | In short |
|---|---|---|
| A, console | `html/task-a-northflank.html` / `.png` | Navy. Northflank's structure: breadcrumb switchers, a tab bar, a resource header, a status strip, a left sub-menu |
| B, graphite | `html/task-b-graphite.html` / `.png` | Near-black graphite, Linear-like: a sidebar of projects, a document-style task, a properties panel |
