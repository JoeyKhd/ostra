# 15: Core: app processes, detection, onboarding and attachments

Status: ready-for-agent
Builder: core
Blocked by: 03, 05
Features: F-121, F-140
Packages: `apps/core` (`dispatch/`, `ingest/`, `onboarding/`, `github/` PR text), `packages/domain` (the use cases' bodies)
Spec: `../spec.md`, sections 4 and 5.4; ADR 0068

## What to build

- **Dispatch:** the environment's app processes, the services' preview labels, the screenshot settings and `"app"` in `tools` go into the task spec for a minor-7 runner, and none of it for a minor-6 one (`isTaskOfferable`, ticket 01). A task on a minor-6 runner whose environment has app processes runs as before, and its page says the runner needs upgrading for screenshots and previews.
- **The ingest:**
  - `attachment.added` writes a `TaskAttachment` (idempotent on the runner's ID), after checking that the blob is the task's and of its purpose;
  - `app.process` and `app.browser` are stored as events for the thread and the pane;
  - `preview.list` updates the task's announced `TaskPreview` rows.
- **The PR's line.** When a task has attachments, the PR body ostra writes (milestone 1's `set_pull_request_text` path, F-030) gains "Screenshots: N in ostra", linking to the task's attachments, with no image URL.
- **"Add to draft".** `addAttachmentToDraft` makes a `RefineDraftImage` from an attachment of the same task (milestone 6), so "Update ticket" attaches it to the tracker as any draft image.
- **A finding's attachments.** `submit_review`'s `attachmentIds` are checked against the review task's attachments and stored on the finding. The review screen reads them (ticket 17).
- **Detection.** `detect.ts` calls ticket 05's readers, and the drafted environment lists the processes it found, marked "detected", for a project admin to save.
- **Onboarding** (F-113, milestone 6's ticket 21):
  - the onboarding prompt asks the agent to start each detected process with `start_app`, check it's ready, take a screenshot of the primary, and hand the list in through `propose_environment`'s `appProcesses`;
  - core stores them in the `EnvironmentProposal`'s body, and "Accept" saves them with the environment's next version;
  - the prompt names the one-origin convention, and the proposal's notes say when the frontend calls the API by an absolute URL.
- **"Keep it".** `proposeAppProcess` turns an announced preview into an `EnvironmentProposal` with one app process, for a project admin, with the source "kept from a task".

## Done when

- [ ] Tests named for `F-140`:
  - the spec's fields for minor 7 and none for minor 6;
  - detection over the `test-web` fixture lists web, api and docs with web as the primary;
  - onboarding's proposal with processes, accepted into the environment;
  - "Keep it" makes a proposal.
- [ ] Tests named for `F-121`:
  - an attachment stored once under a replayed event, and refused for another task's blob (break-it: skip the blob's task check, and the case fails);
  - the PR's line with its count and link, and no URL to a blob;
  - "Add to draft";
  - a finding's attachment.
- [ ] Checks for the touched packages pass, and the whole-repo checks, since this touches the runner protocol (spec section 10).
- [ ] Committed as `✨ add app processes and attachments to core`.

## Comments
