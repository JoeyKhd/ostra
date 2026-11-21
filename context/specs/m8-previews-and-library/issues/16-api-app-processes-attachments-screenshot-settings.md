# 16: API: app processes, attachments and screenshot settings

Status: done
Builder: api
Blocked by: 15
Features: F-121, F-140
Packages: `packages/api`, `apps/web/src/app/api/tasks/[task-id]/attachments/` (the download's route handler, new), `packages/domain` (`saveAppProcesses` takes its parts apart)
Spec: `../spec.md`, sections 4 and 5.4; ADR 0068

## What to build

- **`environments.appProcesses`:** list, save (a project admin; the rules of ticket 05, refused with each rule's words), with an audit entry naming the fields that changed, never a command's text.
- **`environments.screenshots`:** read and save the after-turn switch, the routes and the widths (a project admin).
- **`environments.services`:** a service's preview label.
- **`tasks.attachments`:** list a task's attachments for a member who can open the task, with each one's kind, source, target, size, caption, browser and turn. Download each through the blob service as a file with its fixed content type, never served as a page (ADR 0043).
- **`tasks.attachmentToDraft`:** `addAttachmentToDraft`, for the refine draft's owner or a project member (milestone 6's rule for editing a draft).
- **`tasks.keepPreview`:** `proposeAppProcess`, for a member who can open the task.
- **`reviews.findings`** gains each finding's attachments.
- **Access:** every procedure checks the organization and the project's access. Milestone 4's write matrix and query matrix get a row for each.

## Done when

- [x] Tests named for `F-140`: a save by a project admin and a refusal for a member; each rule's refusal; the audit entry without the command's text.
- [x] Tests named for `F-121`: attachments listed for a member and invisible to another organization's and to a restricted project's outsider (break-it: drop the project filter, and the matrix fails); the download's content type fixed; "Add to draft" by the right people.
- [x] Checks for `packages/api` pass (spec section 10). *On the lead's rules of 2026-11-20: typecheck, lint and tests of `packages/api` and `packages/domain`, typecheck and lint of `apps/web` and `apps/core`, and core's `app-processes.test.ts`, which calls the widened `saveAppProcesses`.*
- [x] Committed as `✨ add app process and attachment procedures`.

## Comments

- 2026-11-21, api: committed as `✨ add app process and attachment procedures`, on tickets 05 and 15's bodies and ticket 20's house style. Where things went and what was decided:
  - **`environments.appProcesses`** (`packages/api/src/routers/environment-app.ts`): `list` (anyone who can open the project) gives the saved processes in their start order with every field, each with its last box from its newest `app.process` event (state, exit code, reason, the runner, and `readyAfterMs` from the same session's `starting`), the box's browser from the project's newest `app.browser`, the processes kept from a task that wait on an admin (who kept it, from its audit entry, and `waitsForCommand`), and `canEdit`. `detected` is a query of its own, so the list never waits on GitHub: what detection reads in each repo now and the list lacks, marked `detected` (`environmentAppProcessList`), with each repo it couldn't read and why. `save` is a project admin's whole list: a field that doesn't read is refused at the door by the domain's `appProcessSchema` (`BAD_REQUEST`, below 1024 among them); a rule the list breaks comes back as `{ ok: false, reason: "rule-broken", message, issues }`, each issue with its words, for the field it's about.
  - **Reserved ports:** port 7101 is refused on save, in its words; a port the box picks when it starts saves, and `mayReach` refuses it then by its name (the test shows both).
  - **`environments.screenshots`:** `get` and a project admin's `save`, with `primary` and `takes` (on, and a primary declared). **`environments.services.setPreview`:** a project admin's label or `null`; `services.list` gains `previewLabel`. A service without a port can't be a preview (the domain's refusal, new).
  - **One domain save:** the three saves are the domain's `saveAppProcesses`, which now takes each part apart (`processes`, `screenshots` and `servicePreviews` optional, a part left out kept as it is), so the App tab's controls don't race each other. Its one audit entry, `environment.app-processes-saved`, gains `parts` (what the save wrote) and `reordered`, and still names processes and fields, never a command.
  - **`detectionViewSchema`** carries `appProcesses` (`environments.detect`, `github.detect`, `projects.create`'s draft).
  - **`tasks.attachments`** (`task-attachments.ts`): each attachment with its kind, source, target (`process`, `port` or `service`), path, sizes, bytes, fixed content type, a recording's length and frames, caption, browser, turn (`turnId`, ordinal, `startSeq`), who took it from the pane, whether it's in a draft, and `downloadPath`; beside them `app`, `taskAppSupport`'s `runner-needs-upgrade` with its words. **The download** is `serveTaskAttachment` behind `GET /api/tasks/<taskId>/attachments/<attachmentId>`: the kind's fixed type whatever the blob was stored with, `attachment`, `nosniff`, `default-src 'none'; sandbox`, `private, no-store`, the same 404 outside the project. As for a check's output, the panel reads the built-in store only: a blob kept in S3 answers 503 until the panel reads that store.
  - **`tasks.attachmentToDraft`** (`addAttachmentToDraft`, `OSTRA_DRAFT_IMAGES_MAX`) and **`tasks.keepPreview`** (`proposeAppProcess`: `not-announced` is `NOT_FOUND`, `already-kept` `CONFLICT`). **`review.screen`**'s findings gain `attachments`, the review task's own only, in the order the finding named them. **`environments.proposal`** gains `source`, `keptBy`, `appProcesses` (proposed, and its diff by name against the list while it's open), `waitsForCommand` and the proposal task's newest `screenshot`.
  - **The matrices:** `every-record.test.ts` calls the four new queries as every role (rows and readers added); `every-write.test.ts` gets the five new writes by role, with a guard over `environments.appProcesses.*` and `environments.screenshots.*`.
  - **Tests:** `packages/api/src/routers/environment-app.test.ts` (`F-140/c1,c2`, `F-140/c2`, `F-140/c1` audit, `F-121/c1`, `F-140/c3`, `F-140/c7`, `F-140/c9`) and `task-attachments.test.ts` (`F-121/c4,c8`, `F-121/c4` twice, `F-121/c11`, `F-121/c7` twice), on Postgres. No break-it pass ran, under the maintainer's 2026-11-21 change.
  - **Left open:** the App tab's line for a runner below minor 7 (the task page's is `tasks.attachments.app`); an app log's tail (`app.process`'s `logBlobId`) has no download route yet, for "Show log" (ticket 17 can add one beside `serveTaskAttachment`); the panel's S3 reads; `apps/web`'s one fixture (`finding-block.test.tsx`) gained `attachments: []`, nothing else of the web app changed.
- 2026-11-21, the blob-reads follow-up: the panel reads every blob through core's blob service now, so a screenshot or recording kept in an S3-compatible store reads as one in Postgres does. `coreBlobReader` (`packages/api/src/services/blob-store-view.ts`) finds the blob's row for its owner, asks `GET /panel/v1/blobs/<blobId>` on `OSTRA_CORE_INTERNAL_URL` with a one-minute read token for that blob, organization and task, and streams core's bytes on, checked against the row's size and SHA-256; the download's headers are unchanged. ADR 0043 amended. Tests: `apps/core/src/blobs/panel-blob-reads.test.ts`, against the fake S3.
