# 17: Docs: files for the agent

Status: done
Builder: core
Blocked by: 14
Features: F-148, F-149, F-150 (their docs)
Packages: `apps/docs`, `docs/configuration.md` (checked, not re-added: ticket 05 adds the lines)
Spec: `../spec.md`; ADR 0070

## What to build

Pages in the docs site (ADR 0063), in its voice, each command run by `check-docs-commands` where it has one:
- **Attaching files to a task:** the three ways in, any type, the limits and their settings, what the agent gets (the files outside the repos and their place, images as images where the model can see them, a document's text beside it), the model's note and how an admin turns on "Reads images" for a custom model, who can download a file, and that unsent uploads go after a day.
- **A ticket's files:** what a task gets from its ticket, the ticket's limits, links not fetched, what left out and failed mean and Retry, a reopen reading the ticket again, Send ticket updates, a follow-up's files, and what a tracker without `ticketFiles` does. The ticket template page: `{{#images}}`'s path is now under the workspace's root.
- **Documents ostra reads:** the four kinds, what each gives, what it can't read and why, the switch, and that reading runs in core, never in a box.
- **For adapter authors:** `promptImages` and `ticketFiles`, in the adapter guide, with the contract suites' cases.
- **Security:** files are untrusted data, served as downloads with their headers, never run; extraction's limits.

## Done when

- [x] The pages exist, link from the docs' navigation, and the docs build and its commands' check pass.
- [x] The configuration reference's seven lines read as the pages say.
- [x] Checks for `apps/docs` pass (spec section 10).
- [x] Committed as `📝 document files for the agent`.

## Comments

- 2026-11-21, core: committed as `📝 document files for the agent` (`a6ad567e`), started before ticket 14 on the lead's word, from the spec, ADR 0070 and the code on `main`. What it holds, and the readings:
  - **The pages:** `using-ostra/files.mdx` (Attaching files), `using-ostra/ticket-files.mdx` (A ticket's files, with the ticket template's `{{#images}}` and `{{#links}}`: the site has no template page of its own, so the section lives here), `using-ostra/documents.mdx` (Documents ostra reads) and `security/files.mdx` (Files and documents), each in its section's `meta.json`. The adapter guide gains the tracker suite's files hooks and cases, and an agent section, "Files and images", with the `files` probes, the four cases and the parity row. Short links from Tasks, Steering, Reopening, Model providers (a new "Images" section: the catalog's inputs and "Reads images"), OpenCode (the capability row, and the inputs written into its config) and Linear. README's milestone 9 row moves from "specced" to "being built".
  - **Ticket 12 had landed** when I checked before pushing (`c3425e7e`, the same as the local `42aeb58f` the pages were written against): the ticket pages follow it (the start's limits as a file downloads, Retry's and an update's words, the driver-only press on a running or waiting task, a reopen without the changes when the tracker doesn't answer, `none`'s prompt line, the built-in template without `## Images` and with `{{#links}}`).
  - **The panel's words** come from `apps/web/messages/en.json` where tickets 15 and 16's phase A put them, and from the approved targets for what isn't wired yet ("Send ticket updates", "Reads images", "Nothing new on the ticket since the agent read it."). Words with a placeholder are given with example values, since MDX reads braces as code.
  - **The configuration reference's seven lines** read as the pages say, and weren't touched. The pages also name what no setting holds: the unsent cap (twice `OSTRA_MESSAGE_FILES_MAX` a member and project), and a task's box holding its first 500 files and 512 MiB.
  - **No pictures:** no page of the site uses them, so no `picture` marker was left.
  - **Checks:** `apps/docs`' typecheck, lint and tests; `next build` and `check:export`; `scripts/check-docs-commands.test.ts`, `--list`, and the other tests that read the pages (`members-docs`, `deploy-docs`, the adapter guide's samples); every `/docs/…#anchor` link checked against the site's heading anchors.
