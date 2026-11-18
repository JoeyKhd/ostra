"""Prompts for the second round of screen concepts (2026-11-18).

Direction: Northflank's console structure (breadcrumb switchers, a tab bar per level,
resource header plus status strip, grouped left sub-nav, card grid with "View all",
mono IDs and logs), in ostra's own brand, at a real company's scale. Model names and
prices come from models.dev (fetched 2026-11-18). All data is invented demo data.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent

STYLE = (
    "A straight-on, full-screen screenshot of a real production web app called ostra. No device frame, no browser "
    "chrome, no perspective, no shadows on the page. A dense, calm, professional infrastructure-console layout. Dark "
    "mode. Colors: page background deep blue-green near-black #0C1D21; cards #10262A with 1px borders #2F4A47; text "
    "warm off-white #F3F0E8; secondary text #CFD8D4. The selected tab and the selected left-menu item have a tinted "
    "background #1B3A39 with a thin off-white marker. Healthy and success statuses use a muted green #4FB286 with a "
    "small icon. Amber #FFB224 is used ONLY for things that need a person. The primary button is filled #F3F0E8 with "
    "dark #0C1D21 text. No gradients, no glow, no purple, no blue accents, no emoji. Type: headings in Manrope "
    "ExtraBold; interface text in IBM Plex Sans; IDs, branch names, commit hashes, times, model IDs, code and small "
    "uppercase section labels in IBM Plex Mono. Thin line icons. Every word perfectly legible and spelled exactly as given."
)


def top_bar(crumbs: str) -> str:
    return (
        "Top bar 56px high: at the far left the attached logo mark (a light rounded square with one diagonal channel), "
        f"then breadcrumb switchers separated by thin slashes: {crumbs}. On the right: a search field \"Search  ⌘K\", a "
        "bell icon with a small amber badge \"5\", a help icon, a filled off-white button \"+ Create new\", and a round "
        "avatar \"AK\"."
    )


ORG_TABS = "Dashboard, Projects, Runner pools, Models, Insights, Members, Audit log, Settings"
PROJECT_TABS = "Dashboard, Tasks, Inbox, Environment, Automations, Repos, Settings"


def tab_bar(tabs: str, selected: str) -> str:
    return (
        f"Below it a tab bar with small icons: {tabs}. The tab \"{selected}\" is selected (tinted background)."
    )


PROMPTS = {
    "06-org-dashboard": f"""A desktop screen of ostra, the organization dashboard. {STYLE}
{top_bar('"Acme Corp ▾"')}
{tab_bar(ORG_TABS, "Dashboard")}
Resource header: a square icon tile with a building icon, the title "Acme Corp" in Manrope, under it mono "org: acme" with a copy icon. Below the header a thin status strip with separated items: "42 members", "18 projects", "186 tasks running", "238 of 412 runner slots busy", "37 PRs merged today".
A grid of cards, three columns, each card with an icon, a title and a small outline button "View all" in its header:
Card "Needs you" with an amber count badge "5", rows with thin amber left edges: "CALC-142  Retry webhook delivery on 5xx · calculator · approval: pnpm db:migrate" with a small amber button "Approve"; "BIL-88  Prorate seat changes · billing-platform · plan ready"; "WEB-311  Fix cart badge count · web-storefront · PR #2213 ready".
Card "Projects", rows with project name, tracker chip and running count: "calculator · Linear CALC · 12 running"; "billing-platform · Linear BIL · 31 running"; "web-storefront · Linear WEB · 44 running"; "mobile-app · Linear MOB · 19 running"; "data-pipeline · Linear DATA · 8 running"; each with a small green "Healthy" pill and a mono time on the right.
Card "Runner pools", rows with a thin capacity bar: "build-fleet · Fixed · Docker · 186/200 slots"; "e2b-elastic · Elastic · E2B · 112 running, max 400"; "k8s-gvisor · Elastic · Kubernetes · 64/300"; "laptops · Personal · 9 online".
Card "Models", rows with small provider logos: "Claude Sonnet 5.5 · Anthropic · default"; "GPT-6.2 Sol · OpenAI"; "Gemini 4 Carbon · Google"; "Kimi K3.1 Pro · OpenRouter"; "qwen-coder · internal-vllm".
Card "Throughput, last 7 days": a small bar chart in off-white and muted green, with three numbers: "1,284 PRs opened", "1,031 merged", "23 min median time to PR".
Card "Recent activity", rows with mono times: "PR #2207 merged · web-storefront · 3m"; "Snapshot rebuilt · calculator · 12m"; "Runner build-17 joined build-fleet · 20m"; "Model GPT-6.2 Sol enabled · 1h".""",

    "07-project-dashboard": f"""A desktop screen of ostra, the dashboard of one project. {STYLE}
{top_bar('"Acme Corp ▾" / "calculator ▾"')}
{tab_bar(PROJECT_TABS, "Dashboard")}
Resource header: a square icon tile with a cube icon, the title "calculator" in Manrope, under it mono "project: calculator" with a copy icon, and a chip "Linear · CALC".
A thin status strip with separated items: "repos: acme/calculator-web · acme/calculator-api"; a small green pill "Snapshot ready · built 2h ago"; "pools: build-fleet, e2b-elastic"; "12 running · 3 queued"; and at the right a thin bar with the label "default box 4 vCPU / 8 GB".
A grid of cards with icon titles and "View all" buttons:
Card "Needs you" with amber badge "2": rows with amber left edges: "CALC-142  Retry webhook delivery on 5xx · approval: pnpm db:migrate" with a small amber "Approve" button; "CALC-150  Export history as CSV · plan ready" with an outline "Review plan" button.
A wide card "Running tasks" spanning two columns, a compact table with columns Task, Repo, Box, Agent and model, Driver, Time, Activity. Rows:
"CALC-161 Add history panel | calculator-web | e2b-elastic · e2b-7f3a | OpenCode · Claude Sonnet 5.5 | Sam Rivera | 12m | Editing src/history/panel.tsx";
"CALC-158 Fix rounding in percent mode | calculator-api | build-fleet · build-07 | OpenCode · GPT-6.2 Sol | Priya Shah | 27m | Running pnpm test";
"Prompt: Add a /health endpoint | calculator-api | e2b-elastic · e2b-91c0 | OpenCode · Kimi K3.1 Pro | Alex Kim | 3m | Preparing workspace".
Card "Environment": "Snapshot ready · 2h ago" with a green pill, "Base image ostra/base:node22", "Services postgres:16 · redis:7", "Secrets 7 · per repo", "Checks pnpm lint · pnpm test", and an outline button "Rebuild snapshot".
Card "Recent pull requests": "#483 Add history panel · draft"; "#481 Fix percent rounding · in review"; "#479 Upgrade Prisma · merged".
Card "Automations": "Label agent → start task (Default profile)"; "Weekdays 07:00 → triage stale bugs"; "CI failure → send to the agent".""",

    "08-task": f"""A desktop screen of ostra showing one running task. {STYLE}
{top_bar('"Acme Corp ▾" / "calculator ▾" / "Tasks"')}
{tab_bar(PROJECT_TABS, "Tasks")}
Resource header: a square icon tile with a lightning icon, the title "CALC-161 Add history panel" in Manrope, under it mono "task: t_8f2k1" with a copy icon, a chip "Linear CALC-161" and a chip in mono "calc-161-add-history-panel".
A thin status strip with separated items: "e2b-elastic · box e2b-7f3a"; "OpenCode · Claude Sonnet 5.5" with a tiny provider logo; a small green pill "Running"; "Sam Rivera is driving" with a small outline button "Take over"; "214k tokens · $1.82 · 14 min"; at the right a thin bar labelled "4 vCPU / 8 GB".
A left menu 240px wide with small uppercase mono group labels: "SESSION": Activity (selected), Changes, Checks; "CONTEXT": Ticket, Environment; "OBSERVE": Events, Logs, Usage, Audit log.
Main column, the session in time order:
- a plain agent message: "I'll add a history panel that stores the last 50 results and lets you click one to reuse it."
- compact tool rows with small icons and mono text: "Read  src/calculator/state.ts"; "Edited  src/history/panel.tsx  +118"; "Edited  src/calculator/state.ts  +24 −6"; "Ran  pnpm test history  ·  12 passed".
- a card with a 1px amber border and a small amber label "Approval needed": "OpenCode wants to run:" and a mono code box "pnpm db:migrate"; buttons "Deny" (outline), "Approve once" (filled amber with dark text), "Approve for this task" (outline).
- at the bottom a message box with placeholder "Message the agent… sending interrupts the current turn" and buttons "Interrupt" (outline) and "Send" (filled off-white).
Right column, about 380px: a card "Pull request" with "#483 · draft" and a line "Checks: lint passed, test running", and a card "Changes" listing files in mono with counts: "src/history/panel.tsx +118", "src/calculator/state.ts +24 −6", "src/history/panel.test.tsx +61".""",

    "09-environment": f"""A desktop screen of ostra showing a project's environment, the computer every task runs in. {STYLE}
{top_bar('"Acme Corp ▾" / "calculator ▾"')}
{tab_bar(PROJECT_TABS, "Environment")}
Resource header: a square icon tile with a chip or server icon, the title "Environment" in Manrope, under it "calculator · applies to every task".
A thin status strip with separated items: a small green pill "Snapshot ready"; mono "built 2h ago from main@9c41e2a"; "base image ostra/base:node22"; "boots in about 2 s on e2b-elastic"; at the right a thin bar labelled "default box 4 vCPU / 8 GB".
A left menu 240px wide with small uppercase mono group labels: "SETUP": Overview (selected), Base image, Setup script, Services, Variables and secrets; "RUN": Box size, Network, Checks; "HISTORY": Snapshots, Build logs.
Main area, two columns of cards:
Card "Setup script" with a code block in IBM Plex Mono, three lines: "corepack enable", "pnpm install --frozen-lockfile", "pnpm --filter calculator-api prisma generate".
Card "Services": rows "postgres:16 · healthy" and "redis:7 · healthy" with small green status dots.
Card "Variables and secrets": a compact table with columns Name, Kind, Repo: "DATABASE_URL | secret •••• | calculator-api"; "STRIPE_TEST_KEY | secret •••• | calculator-api"; "NEXT_PUBLIC_API_URL | variable | calculator-web"; under it small muted text "Secrets are added when a task starts. They are never stored in snapshots."
A wide card "Latest snapshot build" with a log panel in IBM Plex Mono with timestamps: "12:04:11 Cloning acme/calculator-web and acme/calculator-api"; "12:04:19 pnpm install --frozen-lockfile · 1,284 packages"; "12:05:58 Starting services postgres:16, redis:7"; "12:06:20 Running checks · pnpm lint passed"; "12:06:52 Snapshot saved · 1.9 GB · 2m 41s". In the card header a filled off-white button "Rebuild snapshot".""",

    "10-runner-pools": f"""A desktop screen of ostra showing the organization's runner pools. {STYLE}
{top_bar('"Acme Corp ▾"')}
{tab_bar(ORG_TABS, "Runner pools")}
Resource header: a square icon tile with a stacked-servers icon, the title "Runner pools" in Manrope, and at the right a filled off-white button "+ Add pool".
A thin status strip with separated items: "412 slots"; "238 busy"; "41 queued"; "3 providers: Docker, E2B, Kubernetes".
A wide card with a table of pools, columns Pool, Kind, Provider, Capacity, Queue, Version, Join token. Rows:
"build-fleet | Fixed | Docker on 50 hosts | a thin bar 186/200 slots | 12 queued | v0.4.2 | •••• Copy";
"e2b-elastic | Elastic | E2B | 112 running, max 400 | 0 queued | v0.4.2 | pause after 15 min";
"k8s-gvisor | Elastic | Kubernetes agent-sandbox · gVisor | a thin bar 64/300 | 29 queued | v0.4.2 | managed";
"laptops | Personal | members' machines | 9 online | none | v0.4.1–v0.4.2 | device code".
Below, two cards side by side:
Card "Busy slots, last 24 hours": a line chart with three lines in off-white, light grey-green and muted green, labelled build-fleet, e2b-elastic, k8s-gvisor, mono time labels along the bottom.
Card "Runners in build-fleet": rows with a small green dot: "build-01 · 4/4 busy · linux/x64 · v0.4.2"; "build-02 · 3/4 busy · linux/x64 · v0.4.2"; "build-17 · joined 20 min ago · 0/4 busy"; "build-23 · offline 3 min · tasks will resume" with a grey dot.""",

    "11-models": f"""A desktop screen of ostra showing the organization's model providers and models. {STYLE}
{top_bar('"Acme Corp ▾"')}
{tab_bar(ORG_TABS, "Models")}
Resource header: a square icon tile with a sparkle-free chip icon, the title "Models" in Manrope, and at the right a filled off-white button "+ Add provider".
A thin status strip with separated items: "5 providers"; "14 models enabled"; "catalog from models.dev · updated 1h ago".
Left column 360px: a card "Providers" with rows, each with a small provider logo, a name and a small green pill "Connected": "Anthropic"; "OpenAI"; "Google"; "OpenRouter"; and "internal-vllm" with a server icon and mono "https://llm.acme.internal/v1".
Main: a card "Enabled models" with a table, columns Model, Provider, Context, Input $/M, Output $/M, Tools, Used by. Rows:
"Claude Sonnet 5.5 | Anthropic | 1M | $2.00 | $10.00 | yes | default · 9 projects";
"Claude Opus 5.5 | Anthropic | 1M | $4.00 | $20.00 | yes | 3 projects";
"GPT-6.2 Sol | OpenAI | 1.05M | $2.00 | $10.00 | yes | 4 projects";
"Gemini 4 Carbon | Google | 1M | $2.00 | $10.00 | yes | 1 project";
"Kimi K3.1 Pro | OpenRouter | 1M | $2.00 | $10.00 | yes | 2 projects";
"DeepSeek V4 Flash | OpenRouter | 1M | $0.15 | $0.60 | yes | reviews";
"qwen-coder | internal-vllm | 256k | — | — | yes | data-pipeline".
A right-side drawer 420px wide is open, titled "Add provider", with labelled fields: "Name" showing "internal-vllm"; "API base URL" showing mono "https://llm.acme.internal/v1"; "Bearer token" masked with dots; "Model catalog" select showing "Custom (no models.dev entry)"; buttons "Test connection" (outline) and "Save provider" (filled off-white).""",
}

for name, text in PROMPTS.items():
    (HERE / f"{name}.txt").write_text(text + "\n", encoding="utf-8")
    print(name, len(text), "chars")
