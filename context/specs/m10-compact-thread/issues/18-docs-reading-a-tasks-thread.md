# 18: Docs: reading a task's thread

Status: ready-for-agent
Builder: core
Blocked by: 04, 10, 11, 12, 13, 14, 15, 16
Features: F-151
Packages: `apps/docs` (`content/using-ostra/tasks.mdx`, `steering.mdx`, `review-loops.mdx`, `budgets.mdx`, and any page that names the thread's old rows)
Spec: `../spec.md`, section 1

## What to build

The docs describe the thread as it is built, in the panel's words (ticket 04's), with no screenshot of the old one.

- **`tasks.mdx`** gains "Reading a task": a member's and ostra's messages, the agent's prose, a run's line and what opens under it, the live step, failures (one red word when the agent fixed it, its own line when not), what a turn made, receipts, where a turn's numbers are (the opened run's footer, the time's tooltip, the properties panel, the Event log), and the box in the status line.
- **`steering.mdx`:** answering a question with `Something else…`, and the pill when a block is scrolled away.
- **`review-loops.mdx`:** checks (the environment's, in the box, before the push) and CI (the code host's, on the PR, in jobs), and the CI round's failing jobs; a review task's page and its repeat hand-in.
- **`budgets.mdx`:** a turn's spend in its footer and tooltip, the task's in the panel.
- **Every other page** that names `Show the output`, the token line, `Work saved after turn …` or CI counted in checks, found by a search and changed.
- The docs' build and link check pass.

## Done when

- [ ] Each page above describes the built thread in ticket 04's words, and a search of `apps/docs/content` finds none of the old rows' words and no CI counted in checks.
- [ ] The docs site's build and its link check pass.
- [ ] Committed as `📝 document the compact thread`.

## Comments
