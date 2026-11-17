"""Write the five screen prompts for the first ostra screen concepts (GPT Image 2)."""

from pathlib import Path

HERE = Path(__file__).resolve().parent

STYLE = (
    "Style: a straight-on, full-screen screenshot of a real production web app, crisp and realistic, built with "
    "shadcn/ui components. No device frame, no perspective, no browser chrome. Dark mode. Colors: page background "
    "deep blue-green near-black #0C1D21; raised panels #13272B with 1px borders #2F4A47; primary text warm off-white "
    "#F3F0E8; secondary text #CFD8D4 at lower emphasis. The ONLY accent color is amber #FFB224, used solely to mark "
    "things that need a person; primary buttons are filled #F3F0E8 with dark #0C1D21 text. No gradients, no glow, no "
    "purple, no illustrations, no emoji. Type: headings in Manrope ExtraBold, body in IBM Plex Sans, ticket keys, "
    "branch names, file paths and commands in IBM Plex Mono. Corners rounded about 8px. Calm, dense, professional. "
    "Every word perfectly legible and spelled exactly as given."
)

SIDEBAR = (
    "Left sidebar 240px wide on the same dark background with a 1px right border: at the top the attached logo mark "
    "(a light rounded square with one diagonal channel) next to the lowercase wordmark \"ostra\" in Manrope ExtraBold; "
    "under it a team switcher \"Acme\"; nav items with thin line icons: Home, Tasks, Inbox, Runners, Boards, Settings; "
    "at the bottom a member row \"Alex Kim\" with an initials avatar."
)

PROMPTS = {
    "01-home": f"""A desktop web app screen of ostra, a control panel for coding agents. {STYLE}
{SIDEBAR} The nav item "Home" is selected.
Top bar: a search field "Search tasks…" with a "⌘K" hint, and a primary button "New task".
Main content, page title "Home".
Section "Needs you" with a small amber count badge "3". Three rows, each with a thin amber left edge:
1) mono "ENG-142" then "Retry webhook delivery on 5xx", second line "Claude Code wants to run pnpm db:migrate", buttons "Deny" (outline) and "Approve" (filled amber with dark text).
2) mono "ENG-155" then "Add CSV export to invoices", second line "Plan ready for review", button "Review plan" (outline).
3) mono "ENG-131" then "Fix timezone bug in reports", second line "PR #418 ready for review", button "Open PR" (outline).
Section "Running" with count "4": a compact table with columns Ticket, Repo, Runner, Driver, Time, Activity. Rows:
"ENG-160 Rate-limit login attempts | acme/api | build-01 · remote | Sam Rivera | 12m | Editing src/auth/limiter.ts";
"ENG-161 Paginate the audit log | acme/web | alex-macbook · local | Alex Kim | 4m | Running pnpm test";
"ENG-158 Upgrade Prisma client | acme/api | build-02 · remote | Priya Shah | 27m | Reading prisma/schema.prisma";
"ENG-163 Fix broken invite email | acme/web | build-01 · remote | Sam Rivera | 2m | Preparing workspace".
Each running row has a small steady off-white dot, not amber.
Section "Recent": three rows with small muted status pills: "ENG-150 Add audit log filters · Merged", "ENG-149 Cache team settings · In review", "ENG-147 Drop legacy export · Stopped".""",
    "02-task": f"""A desktop web app screen of ostra showing one running task. {STYLE}
{SIDEBAR} The nav item "Tasks" is selected.
Header across the main area: breadcrumb "Tasks / ENG-142"; title "Retry webhook delivery on 5xx" in Manrope ExtraBold; a meta line in IBM Plex Mono "acme/api · eng-142-retry-webhook-delivery · build-01 · remote · Claude Code"; a small status pill "Running". On the right: an avatar with "Sam Rivera is driving", an outline button "Take over" and an outline button "Stop".
Left column, about 60% wide, the session's activity in time order:
- a plain agent message: "I'll add exponential backoff to the delivery worker and cap retries at 5."
- three compact tool rows with small icons, mono text: "Read  src/webhooks/deliver.ts", "Edited  src/webhooks/retry.ts  +42 −8", "Ran  pnpm test webhooks  ·  18 passed".
- a card with a 1px amber border and a small amber label "Approval needed": text "Claude Code wants to run:" and a mono code box "pnpm db:migrate"; buttons "Deny" (outline), "Approve once" (filled amber with dark text), "Approve for this task" (outline).
- at the bottom of the column a message composer with placeholder "Message Claude Code…" and buttons "Interrupt" (outline) and "Send" (filled off-white).
Right column, about 40% wide, a panel with tabs "Changes" (selected), "Ticket", "Details". It lists changed files with counts in mono: "src/webhooks/retry.ts +42 −8", "src/webhooks/deliver.ts +6 −2", "test/webhooks/retry.test.ts +55". Below, a short unified diff excerpt in IBM Plex Mono with added lines tinted a muted green and removed lines tinted a muted red, and a small "Comment" button next to one line. At the bottom of the panel, small muted text "182k tokens · 14 min".""",
    "03-inbox": f"""A desktop web app screen of ostra showing the ticket inbox with a side drawer open. {STYLE}
{SIDEBAR} The nav item "Inbox" is selected.
Main area: page title "Inbox", subtitle "Open tickets from your boards". A filter bar: a select "Board: Platform · Linear", and filter chips "Label", "Priority", "Assignee".
A table with columns Ticket, Title, Labels, Priority, Status, and a right-aligned outline button "Start task" in every row. Rows:
"ENG-170 | Add SSO login button | auth | High | Todo";
"ENG-171 | Speed up dashboard query | performance | Medium | Todo";
"ENG-172 | Document webhook retries | docs | Low | Backlog";
"ENG-173 | Remove legacy export endpoint | cleanup | Medium | Todo";
"ENG-174 | Fix flaky invoice test | tests | High | Todo".
The row ENG-171 is highlighted. A right-side drawer about 420px wide is open over the table, titled "Start task", with the line in mono "ENG-171 · Speed up dashboard query". Form fields with labels: "Repo" select showing "acme/web"; "Agent profile" select showing "Default · Claude Code"; "Runner" select showing "Auto · remote runners"; a switch "Plan first" turned off with helper text "The agent proposes a plan and waits for your approval". A muted box "The agent receives: title, description, 2 comments, labels". At the bottom of the drawer: "Cancel" (outline) and "Start task" (filled off-white with dark text).""",
    "04-setup": f"""A desktop web app screen of the ostra first-run setup. {STYLE}
No sidebar. A single centered column about 720px wide on the dark background. At the top the attached logo mark next to the lowercase wordmark "ostra". Heading "Set up ostra" in Manrope ExtraBold, then the line "About 30 minutes to your first agent-made pull request." A thin progress bar with the label "3 of 7 done".
A vertical checklist of seven steps, each a row with a status circle on the left:
1. "Create the admin account" — completed, check mark.
2. "Connect GitHub" — completed, check mark, muted detail "GitHub App ostra-acme · installed on 3 repos".
3. "Connect Linear" — the current step, expanded into a panel card: text "Create your Linear app with our pre-filled link, then paste its credentials here." An outline button "Open Linear" with a small external-link icon. Two text inputs with labels "Client ID" and "Client secret" (the secret masked with dots). A filled off-white button "Connect Linear".
4. "Attach a board and link repos" — upcoming, muted.
5. "Add an environment" — upcoming, muted, detail "Setup script, variables and .env files".
6. "Connect a runner" — upcoming, muted, detail in mono "npx ostra-runner login".
7. "Start your first task" — upcoming, muted.""",
    "05-phone": f"""A straight-on phone-width screenshot of the ostra web app in a mobile browser viewport, 390 points wide, portrait, without any device frame or status bar. {STYLE}
Top: a compact header with the attached logo mark at the left, the title "Needs you" with a small amber count badge "3", and a menu icon at the right.
A vertical list of cards with thin amber left edges. The first card is expanded: mono "ENG-142", title "Retry webhook delivery on 5xx", text "Claude Code wants to run:", a mono code box "pnpm db:migrate", a small muted line "build-01 · remote · Sam Rivera is driving", and two large buttons side by side "Deny" (outline) and "Approve" (filled amber with dark text).
Below it two collapsed cards: "ENG-155 · Plan ready for review" with a chevron, and "ENG-131 · PR #418 ready for review" with a chevron.
At the bottom a tab bar with icons and labels: Home (selected), Tasks, Inbox, More.""",
}

for name, text in PROMPTS.items():
    (HERE / f"{name}.txt").write_text(text + "\n", encoding="utf-8")
    print(name, len(text), "chars")
