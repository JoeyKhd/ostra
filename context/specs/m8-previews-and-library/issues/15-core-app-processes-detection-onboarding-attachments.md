# 15: Core: app processes, detection, onboarding and attachments

Status: done
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

- [x] Tests named for `F-140`:
  - the spec's fields for minor 7 and none for minor 6;
  - detection over the `test-web` fixture lists web, api and docs with web as the primary;
  - onboarding's proposal with processes, accepted into the environment;
  - "Keep it" makes a proposal.
- [x] Tests named for `F-121`:
  - an attachment stored once under a replayed event, and refused for another task's blob (break-it: skip the blob's task check, and the case fails);
  - the PR's line with its count and link, and no URL to a blob;
  - "Add to draft";
  - a finding's attachment.
- [x] Checks for the touched packages pass, and the whole-repo checks, since this touches the runner protocol (spec section 10). *On the lead's rules of 2026-11-20 and the brief: the touched packages and their direct consumers; see the comment.*
- [x] Committed as `✨ add app processes and attachments to core`.

## Comments

- 2026-11-21, core: committed as `✨ add app processes and attachments to core`, on tickets 01, 03, 04, 05 and 14. Where things went and what was decided:
  - **The spec** (`apps/core/src/dispatch/app-spec.ts`): at minor 7 only, the environment's app processes (in the task's repos), `environment.screenshots` (only beside processes, so a project without an app gets milestone 7's spec), each service's `preview` when it has a label, and `"app"` in `tools` for an agent whose adapter takes memory over MCP, as the memory tools are decided. `tools` is now composed once (`specToolSets`): the kind's own sets (refine, review, onboarding) or milestone 4's, with `app` added; every task kind gets it, a refine task too, since "Add to draft" takes a screenshot of the refine task's own box and a finding one of the review task's. A minor-6 runner is still offered a task whose environment has processes (the dispatch never asked for minor 7) and gets none of it; `taskAppSupport` (domain) is the page's line for it, with `isPreviewable`'s words, for ticket 16 to surface.
  - **Onboarding's box tests the draft:** with no process saved, its spec carries the processes detection finds that have a command (detection runs again at spec time, through the repos' access), so `start_app` starts them. The prompt (`onboardingAppLines`) lists every process as data, the ones without a command too, and says to start them, check each is ready, screenshot the primary, hand them in as `appProcesses`, keep one origin (`ONE_ORIGIN_RULE`) and say in the notes when the frontend calls the API by an absolute URL. A box without the app tools gets `ONBOARDING_NO_APP_TOOLS_LINE` at spec time.
  - **"Accept"** merges a proposal's processes into the environment's (`mergeAppProcesses`): each takes the place of the one of its name or its port, the rest stay, a proposed primary wins. The services' `preview` sets their label; a proposal without it keeps the label. The scan reads the processes' commands and ready commands.
  - **"Keep it"** (`proposeAppProcess`) makes a proposal with a new column, `EnvironmentProposal.source` (`onboarding` | `kept`), so the panel can say "kept from a task". Nothing tells ostra the command the agent started the port with, so the kept process carries `KEPT_COMMAND_PLACEHOLDER` (it exits 1 if it ever runs) and "Accept" refuses it until "Edit and accept" names the command. The rest of a kept proposal's body is the environment as it is, so milestone 6's diff shows only the process; accepting one writes the processes alone, keeps the setup script and schedules no snapshot. An onboarding proposal now supersedes only another onboarding one. I read the brief's "the agent can register one mid-task through an MCP tool, and it waits for an admin" as `show_preview` then "Keep it", as ADR 0068 says; `show_preview` itself proposes nothing.
  - **The ingest** (`packages/domain/src/previews/attachments.ts`, called from `ingest-events.ts`): `attachment.added` stores a row once per `attachmentId` (a replay and a later event both store nothing more), only for a blob whose task is the event's and whose purpose, content type and size are the kind's; the 21st of a turn is refused, a member's screenshot doesn't count. The turn is the session's newest. A refused event stays in the log; the thread reads the rows. `preview.list` keeps the announced ports as `TaskPreview` rows, and a list without one removes it unless it was kept. `Task.previewId` is left to tickets 19 and 25.
  - **The bulk path** refuses, before a byte, an `app-screenshot`, `app-recording` or `app-log` upload of another content type or over its cap (8 MiB, 32 MiB, 64 KiB), as ADR 0043's caps do.
  - **The PR's line:** "Screenshots: [N in ostra](<task>#attachments)" under the "Opened by" line, N counting screenshots and recordings; an open PR's line is brought up to date after each later turn, in place, even when its checks didn't change. The link is the task page's `#attachments`, for ticket 17's viewer.
  - **A finding's attachments** are a new column, `Finding.attachmentIds` (JSON, at most 5, checked), the review task's own only: an ID that isn't one of them is left off the finding, which is kept, since the protocol's refusals have no word for it.
  - **The migration** `20261201160000_m8_attachments_and_kept_proposals`, additive: the enum, the two columns with defaults and the finding's check, after ticket 19's `20261201150000_runner_preview_report`.
  - **Detection** reads the `test-web` fixture: a Vite config's port and proxy target kept in a variable read from the variable's declaration (`port,`, `${apiPort}`), and `package.json`'s other scripts that name their port become processes (`readPortScripts`; builds, tests and checks left out). The fixture's `api` and `docs` scripts now name their ports (`--port 3001`, `--port 4000`), which the servers read when their variable isn't set.
  - **Use-case bodies** written beside the ticket's list, for ticket 16: `saveAppProcesses` (a project admin's, the rules' words, its audit entry `environment.app-processes-saved` naming processes and fields, never a command), `environmentAppProcessList` (saved, then detected and unsaved, marked `detected`) and `recordAttachment`. Signatures widened, additively: `RecordAttachment` gains `invalid`, `AddAttachmentToDraft` takes the draft's image cap and gains `task-done`. Audit actions added: `environment.app-processes-saved`, `environment.app-process-kept`.
  - **Tests:** `apps/core/src/onboarding/app-processes.test.ts` (`F-140/c1,c3, F-121/c11`, `F-140/c7`, `F-140/c8`, `F-140/c9`) and `apps/core/src/ingest/attachments.test.ts` (`F-121/c4,c10`, `F-121/c9`, `F-121/c6`, `F-121/c7` twice), against Postgres and the fake code host through core's real ingest; `F-140/c7`'s readers in `packages/domain/src/milestone-8-previews.test.ts`. No break-it pass ran, under the maintainer's 2026-11-21 change.
  - **Checks:** typecheck and lint of `packages/db`, `packages/domain`, `apps/core`, `packages/api` and `apps/web`; the tests of `packages/db`, `packages/domain` and `apps/core`.
  - **Left open:** the panel and the API (tickets 16, 17) read `TaskAttachment`, `TaskPreview`, `source` and `attachmentIds`; the page's "needs upgrading" line is `taskAppSupport` until ticket 19's `listPreviews` says it; the runner (12, 13) sends the events and uploads this stores.
