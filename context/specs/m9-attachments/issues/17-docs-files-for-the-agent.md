# 17: Docs: files for the agent

Status: ready-for-agent
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

- [ ] The pages exist, link from the docs' navigation, and the docs build and its commands' check pass.
- [ ] The configuration reference's seven lines read as the pages say.
- [ ] Checks for `apps/docs` pass (spec section 10).
- [ ] Committed as `📝 document files for the agent`.

## Comments
