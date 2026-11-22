import { z } from "zod";

import {
  approvalIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  commandIdSchema,
  effortChangeIdSchema,
  memberIdSchema,
  messageFileIdSchema,
  previewViewIdSchema,
  projectIdSchema,
  questionIdSchema,
  repoIdSchema,
  screenshotRequestIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  taskIdSchema,
} from "../ids.ts";
import { appPathSchema, appProcessNameSchema, previewKeySchema, previewViewportSchema, viewportPresetSchema } from "../task/app.ts";
import { previewInputEventsSchema, previewModeSchema, previewPageControlSchema } from "./preview.ts";
import {
  boxSizeNameSchema,
  branchNameSchema,
  commandSeqSchema,
  envNameSchema,
  epochMsSchema,
  imageDigestSchema,
  leaseEpochSchema,
  repoFullNameSchema,
} from "../common.ts";
import { effortLevelSchema } from "../agent/effort.ts";
import { taskRuleSchema } from "../agent/rules.ts";
import {
  approvalDecisionSchema,
  denyReasonSchema,
  messageIntentSchema,
  messageIntentSchemaV4,
  messageIntentSchemaV7,
  messageIntentSupportedAt,
  planTextSchema,
} from "../events/agent-events.ts";
import { messageBoxFilesSchema } from "../task/files.ts";
import {
  checkoutDirSchema,
  gitPersonSchema,
  repoRelativePathSchema,
  taskSpecFileSchema,
  taskSpecVariableSchema,
} from "../task/spec.ts";
import { sha256HexSchema } from "./blobs.ts";
import { runnerLimits } from "./limits.ts";

// Commands: numbered instructions from the server to a peer (ADR 0034). Each is a row in the
// outbox, numbered per runner under the runner row's lock, written in the same transaction as the
// change that caused it. The peer applies each once by its `id`, acks the highest contiguous
// `seq`, and rejects one past its `notAfter` (judged by the server's clock, from `welcome`).
//
// Commands carry references, never secrets: keys and tokens are fetched by
// `POST /runner/v1/tasks/:taskId/credentials` after the lease check.
//
// Ported from spikes/runner-transport/src/protocol/messages.ts, widened to the product's set.

/** `dispatch` up to minor 3: an offer of a task. */
export const dispatchBodySchemaV3 = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  boxId: boxIdSchema,
  leaseEpoch: leaseEpochSchema,
});

/** An image reference, as a registry names it (`host/path:tag`). Never holds a credential. */
export const imageRefSchema = z.string().min(1).max(512).regex(/^[^\s@]+$/, "an image reference without a digest");

/**
 * A box's size, as the dispatch names it (F-095): the project's default size, with its limits. An
 * executor whose `boxSizes` is false never gets one.
 */
export const dispatchBoxSizeSchema = z.strictObject({
  name: boxSizeNameSchema,
  cpuMillis: z.number().int().positive(),
  memoryMiB: z.number().int().positive(),
});
export type DispatchBoxSize = z.infer<typeof dispatchBoxSizeSchema>;

/**
 * The snapshot image a box starts from (F-120): pulled by digest. The pull credential is never
 * here: the runner fetches it for this lease (`POST /runner/v1/tasks/:taskId/pull-credential`).
 */
export const dispatchBoxImageSchema = z.strictObject({
  ref: imageRefSchema,
  digest: imageDigestSchema,
});
export type DispatchBoxImage = z.infer<typeof dispatchBoxImageSchema>;

/** Minor 4: the box the dispatch asks for. A `null` part means "as before": slots only, a local snapshot or a full setup. */
export const dispatchBoxSchema = z.strictObject({
  size: dispatchBoxSizeSchema.nullable(),
  image: dispatchBoxImageSchema.nullable(),
});
export type DispatchBox = z.infer<typeof dispatchBoxSchema>;

/** `dispatch` at minor 4: minor 3's, with the box. A minor-3 peer never sees `box`. */
export const dispatchBodySchemaV4 = dispatchBodySchemaV3.extend({
  box: dispatchBoxSchema.optional(),
});

/**
 * `dispatch` at minors 5 and 6: an offer of a task. The peer answers `accepted` or `rejected`
 * within the offer timeout. Minor 5: whether the session's first turn is an automatic round
 * (F-101, ADR 0041), so the runner answers its questions with the neutral reply. Missing means
 * `false`. A minor-4 peer never sees it: core starts an automatic round on a minor-5 runner.
 */
export const dispatchBodySchemaV5 = dispatchBodySchemaV4.extend({
  automatic: z.boolean().optional(),
});

/**
 * Why a dispatch starts a box (F-141, Q300): a `turn` of the agent, or `app` ("Start the app"):
 * the box starts as for a reopen, runs the setup, restores the hidden ref and starts the app's
 * processes, and launches no agent and makes no model call. A member's message on the task then
 * becomes a turn in that box.
 */
export const dispatchPurposeSchema = z.enum(["turn", "app"]);
export type DispatchPurpose = z.infer<typeof dispatchPurposeSchema>;

/**
 * `dispatch` at the current minor (7): minor 5's, with its purpose. Missing means `turn`. A
 * minor-6 peer never sees it, and is never sent a dispatch whose purpose is `app`: core checks
 * `isPreviewable` before it starts the app.
 */
export const dispatchBodySchema = dispatchBodySchemaV5.extend({
  purpose: dispatchPurposeSchema.optional(),
});

// ---------- minor 7's commands (milestone 8, ADR 0068) ----------

/** The app processes a command names, or `null` for all of them, in the environment's order. */
const appProcessNamesSchema = z.array(appProcessNameSchema).min(1).max(runnerLimits.appProcessesMax).nullable();

/**
 * `app.start` (minor 7): start these app processes, or all, in the environment's order, each after
 * the one before it is ready. Those already running are left as they are. Each state goes up as
 * `app.process`.
 */
export const appStartBodySchema = z.strictObject({ sessionId: sessionIdSchema, names: appProcessNamesSchema });

/** `app.stop` (minor 7): stop these app processes, or all. The box keeps running. */
export const appStopBodySchema = z.strictObject({ sessionId: sessionIdSchema, names: appProcessNamesSchema });

/**
 * `screenshot.take` (minor 7): a member's screenshot from the pane (F-121). The runner takes the
 * preview `key` at `path` and `width` in a page of its own, and its `attachment.added` carries the
 * request's ID, the source `member` and the member.
 */
export const screenshotTakeBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  requestId: screenshotRequestIdSchema,
  key: previewKeySchema,
  path: appPathSchema,
  width: viewportPresetSchema,
  memberId: memberIdSchema,
});

/**
 * `preview.open` (minor 7): someone opened a view of a preview (F-141, F-143). The sidecar, or the
 * runner on `host`, opens the preview connection for it (`runnerPaths.preview`) in its mode, and
 * starts what isn't running. `viewport` is the browser view's; `null` in the `tunnel` mode.
 */
export const previewOpenBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  viewId: previewViewIdSchema,
  key: previewKeySchema,
  mode: previewModeSchema,
  viewport: previewViewportSchema.nullable(),
});

/** `preview.close` (minor 7): the view closed. The connection ends; the page stays while another view watches it. */
export const previewCloseBodySchema = z.strictObject({ sessionId: sessionIdSchema, viewId: previewViewIdSchema });

/**
 * `preview.input` (minor 7, the HTTP carrier only, Q306): a batch of a member's input for the
 * view's page, or one of its controls (the width preset, a path, a reload; added 2026-11-21, before
 * minor 7's release), which on the WebSocket go on the preview connection as a `control` instead.
 * The down codec of the WebSocket refuses it (`downFrameCodec`). Typed text and a path are never
 * logged.
 */
export const previewInputBodySchema = z.union([
  z.strictObject({ sessionId: sessionIdSchema, viewId: previewViewIdSchema, events: previewInputEventsSchema }),
  z.strictObject({ sessionId: sessionIdSchema, viewId: previewViewIdSchema, control: previewPageControlSchema }),
]);

/**
 * `steer`: a member's message for the running session (F-024, milestone 3). `queue` waits for the
 * turn to end; `interrupt` cancels the turn first. An agent that declares `steerMidTurn` may take a
 * queued message mid-turn.
 */
export const steerBodySchemaV1 = z.strictObject({
  sessionId: sessionIdSchema,
  clientMessageId: clientMessageIdSchema,
  text: z.string().min(1).max(runnerLimits.steerTextMaxChars),
  delivery: z.enum(["queue", "interrupt"]),
});

/** `steer` at minors 2 to 4: minor 1's, with the message's intent. */
export const steerBodySchemaV4 = steerBodySchemaV1.extend({
  /** Minor 2: why the message was written, for the thread's marker. Missing means `message`. */
  intent: messageIntentSchemaV4.optional(),
});

/**
 * `steer` at minors 5 to 7: minor 2's, with milestone 6's intents and whether the turn it starts
 * is an automatic round (F-101, ADR 0041). Missing `automatic` means `false`. The text of a
 * `fix-ci`, `fix-findings`, `changes-requested` or `linear-follow-up` message is ostra's prompt
 * around untrusted text, and is never logged.
 */
export const steerBodySchemaV7 = steerBodySchemaV1.extend({
  /** Minor 2: why the message was written, for the thread's marker. Missing means `message`. */
  intent: messageIntentSchemaV7.optional(),
  /** Minor 5: the turn is an automatic round: the runner answers its questions with the neutral reply. */
  automatic: z.boolean().optional(),
});

/**
 * `steer` at the current minor (8): minor 5's, with `ticket-update` and the message's files
 * (F-148, ADR 0070): each as the box gets it, written under the workspace root's `.ostra/` before
 * the message goes to the agent, and the IDs of those that go as images. A message with files may
 * have no text. Missing `files` and `images` mean none. A minor-7 peer is never sent a steer with
 * files (`canSendFiles`): its codec refuses to encode one. Names and text are never logged.
 *
 * `coAuthors` (F-078, ADR 0040; added to minor 8 on 2026-11-22, before its release): the task's
 * co-authors as they are once this message's sender is credited, every one, in the spec's order. The
 * runner puts them on every commit from the moment the message reaches the agent, the agent's own
 * and its own, until the next list. Missing means unchanged. A minor-7 peer's codec drops it, so
 * there a member credited mid-session gets their trailer from the task's next dispatch.
 */
export const steerBodySchema = steerBodySchemaV1
  .extend({
    /** Minor 8: may be empty when the message carries files. */
    text: z.string().max(runnerLimits.steerTextMaxChars),
    /** Minor 2: why the message was written, for the thread's marker. Missing means `message`. */
    intent: messageIntentSchema.optional(),
    /** Minor 5: the turn is an automatic round: the runner answers its questions with the neutral reply. */
    automatic: z.boolean().optional(),
    /** Minor 8: the message's own files, in its order. */
    files: messageBoxFilesSchema.optional(),
    /** Minor 8: the IDs of the message's files that go to the agent as images too. */
    images: z.array(messageFileIdSchema).max(runnerLimits.promptImagesMax).optional(),
    /** Minor 8 (F-078): the task's `Co-authored-by` trailers from this message on, as the spec's `coAuthors`. Never logged. */
    coAuthors: z.array(gitPersonSchema).optional(),
  })
  .refine((body) => body.text.length > 0 || (body.files?.length ?? 0) > 0, "a message has text or files")
  .refine((body) => new Set(body.images ?? []).size === (body.images ?? []).length, "each image once")
  .refine(
    (body) => (body.images ?? []).every((id) => (body.files ?? []).some((file) => file.fileId === id && file.kind === "image")),
    "an image is one of the message's image files",
  );

/** `interrupt`: cancel the session's current turn, keep the session. */
export const interruptBodySchema = z.strictObject({ sessionId: sessionIdSchema });

/** Why a task is stopped. */
export const stopCommandReasonSchema = z.enum([
  /** A member pressed Stop (F-025). */
  "requested",
  /** The task grace ran out; the peer learns it when it comes back (ADR 0034). */
  "grace-expired",
  /** The task reached its spend cap (F-068, later). */
  "spend-cap",
  /** Runaway protection stopped it (F-068, later). */
  "runaway",
]);
export type StopCommandReason = z.infer<typeof stopCommandReasonSchema>;

/** `stop`: end the session's agent, keep the workspace and push what's there to the hidden ref. */
export const stopBodySchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  leaseEpoch: leaseEpochSchema,
  reason: stopCommandReasonSchema,
});

/** `approval-answer`: a member's or a rule's answer to an open approval (F-026, milestone 3). */
export const approvalAnswerBodySchemaV1 = z.strictObject({
  sessionId: sessionIdSchema,
  approvalId: approvalIdSchema,
  decision: approvalDecisionSchema,
});

/** `approval-answer` at the current minor (2): minor 1's, with a deny's reason and the task rule. */
export const approvalAnswerBodySchema = approvalAnswerBodySchemaV1.extend({
  /** Minor 2: a deny's reason, which the runner re-prompts with as data. Never logged. */
  reason: denyReasonSchema.optional(),
  /** Minor 2: with `allow_task`, the task rule core wrote: the runner answers its next matches. */
  taskRule: taskRuleSchema.nullable().optional(),
});

/**
 * `question-answer` (minor 2): the driver's answer to the agent's question (F-024, ADR 0049). The
 * answers' text is never logged.
 */
export const questionAnswerBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  questionId: questionIdSchema,
  answers: z.record(z.string().min(1).max(200), z.string().max(runnerLimits.steerTextMaxChars)),
});

/**
 * `plan-answer` (minor 2): the driver's answer to a plan (F-063). `approve` switches the session
 * to the build mode and prompts with `text` as the approved plan; `revise` prompts another plan
 * turn with `text` as the request. Never logged.
 */
export const planAnswerBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  decision: z.enum(["approve", "revise"]),
  text: planTextSchema.min(1),
});

/** One repo of a snapshot build: what the generated Dockerfile clones and sets up (F-051). */
export const snapshotBuildRepoSchema = z.strictObject({
  repoId: repoIdSchema,
  fullName: repoFullNameSchema,
  cloneUrl: z.url({ protocol: /^https$/ }),
  defaultBranch: branchNameSchema,
  checkoutDir: checkoutDirSchema,
  /** The repo's non-secret variables and files for the build, as the task spec carries them. */
  variables: z.array(taskSpecVariableSchema),
  files: z.array(taskSpecFileSchema),
  envFile: repoRelativePathSchema,
  /** The repo's setup secrets by name: variables by name, files by path. Their values come from the credentials. */
  setupSecrets: z.strictObject({
    variables: z.array(envNameSchema).max(500),
    files: z.array(repoRelativePathSchema).max(500),
  }),
});
export type SnapshotBuildRepo = z.infer<typeof snapshotBuildRepoSchema>;

/**
 * The inputs of a snapshot build (F-051, ADR 0038): the base image, the repos and the setup
 * script. No secret: the build fetches its setup secrets from
 * `POST /runner/v1/snapshots/:snapshotId/credentials`, after core checks the build is this
 * runner's, and mounts them for the build only.
 */
export const snapshotBuildEnvironmentSchema = z.strictObject({
  baseImage: z.string().max(512).nullable(),
  setupScript: z.string().max(262_144).nullable(),
  repos: z.array(snapshotBuildRepoSchema).min(1),
  /** The hash of every input above and the repos' heads, which names the snapshot's freshness. */
  inputsHash: sha256HexSchema,
});
export type SnapshotBuildEnvironment = z.infer<typeof snapshotBuildEnvironmentSchema>;

/** `snapshot-build` up to minor 3 (`docker` only): build the project's snapshot and keep it on this runner. */
export const snapshotBuildBodySchemaV3 = z.strictObject({
  snapshotId: snapshotIdSchema,
  projectId: projectIdSchema,
  environment: snapshotBuildEnvironmentSchema,
});

/**
 * `set-effort` (minor 3): the driver's new reasoning level for the session (F-137, ADR 0066). The
 * runner applies it when the running turn has ended, before the next prompt, or at the next
 * session start, once per `changeId`, clamped to the values the agent advertises.
 */
export const setEffortBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  level: effortLevelSchema,
  changeId: effortChangeIdSchema,
});

/** How a snapshot is built (F-120): by the host's Docker engine, or by a rootless BuildKit pod. */
export const snapshotBuilderSchema = z.enum(["docker", "buildkit"]);
export type SnapshotBuilder = z.infer<typeof snapshotBuilderSchema>;

/**
 * Minor 4: where a built snapshot is pushed (F-120). The push credential is never here: the
 * runner fetches it for this build (`POST /runner/v1/snapshots/:snapshotId/push-credential`).
 */
export const snapshotBuildPushSchema = z.strictObject({ ref: imageRefSchema });
export type SnapshotBuildPush = z.infer<typeof snapshotBuildPushSchema>;

/**
 * `snapshot-build` at the current minor (4): minor 2's, with the registry to push to (`null`:
 * keep it on this runner, as minor 2) and the builder. A minor-3 peer never sees either.
 */
export const snapshotBuildBodySchema = snapshotBuildBodySchemaV3.extend({
  push: snapshotBuildPushSchema.nullable().optional(),
  builder: snapshotBuilderSchema.optional(),
});

/** `resume` (minor 4): take tasks again after a drain (F-092). Never sent to a peer below minor 4. */
export const resumeBodySchema = z.strictObject({});

/** `drain`: take no new tasks; let the running ones finish. */
export const drainBodySchema = z.strictObject({});

/** `update-hint`: a newer runner version is available for this server. */
export const updateHintBodySchema = z.strictObject({ version: z.string().min(1).max(64) });

/** Why a box is released (F-079, ADR 0039). */
export const boxReleaseReasonSchema = z.enum([
  /** The task's last PR merged or closed. */
  "prs-closed",
  /** The box sat stopped for `OSTRA_BOX_RELEASE_IDLE_DAYS`. */
  "idle-expired",
  /** The task was deleted, or retention removed it. */
  "task-deleted",
  /** An admin or a script asked for it. */
  "requested",
]);
export type BoxReleaseReason = z.infer<typeof boxReleaseReasonSchema>;

/**
 * `release` (minor 1): remove the box and its workspace. The hidden ref is deleted by core, on the
 * code host. Sent only to a peer at minor 1 or above (`commandKindSupportedAt`).
 */
export const releaseBodySchema = z.strictObject({
  taskId: taskIdSchema,
  boxId: boxIdSchema,
  reason: boxReleaseReasonSchema,
});

/** Each command kind's body, for the outbox to validate a body by its kind. */
export const commandBodySchemas = {
  dispatch: dispatchBodySchema,
  steer: steerBodySchema,
  interrupt: interruptBodySchema,
  stop: stopBodySchema,
  "approval-answer": approvalAnswerBodySchema,
  drain: drainBodySchema,
  "update-hint": updateHintBodySchema,
  release: releaseBodySchema,
  "question-answer": questionAnswerBodySchema,
  "plan-answer": planAnswerBodySchema,
  "snapshot-build": snapshotBuildBodySchema,
  "set-effort": setEffortBodySchema,
  resume: resumeBodySchema,
  "app.start": appStartBodySchema,
  "app.stop": appStopBodySchema,
  "screenshot.take": screenshotTakeBodySchema,
  "preview.open": previewOpenBodySchema,
  "preview.close": previewCloseBodySchema,
  "preview.input": previewInputBodySchema,
} as const;

export const commandKindSchema = z.enum([
  "dispatch",
  "steer",
  "interrupt",
  "stop",
  "approval-answer",
  "drain",
  "update-hint",
  "release",
  "question-answer",
  "plan-answer",
  "snapshot-build",
  "set-effort",
  "resume",
  // Minor 7 (milestone 8, ADR 0068): the app's processes, a member's screenshot and the views.
  "app.start",
  "app.stop",
  "screenshot.take",
  "preview.open",
  "preview.close",
  "preview.input",
]);
export type CommandKind = z.infer<typeof commandKindSchema>;
export type CommandBody<K extends CommandKind> = z.infer<(typeof commandBodySchemas)[K]>;

/** The kinds minor 7 added (milestone 8). The outbox never sends one to a peer below minor 7. */
export const minor7CommandKinds: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "app.start",
  "app.stop",
  "screenshot.take",
  "preview.open",
  "preview.close",
  "preview.input",
]);

/** Which carriers take a command kind: every one, or only the HTTP fallback (`preview.input`, Q306). */
export type CommandCarriers = "any" | "http";

/** Which carriers take a command kind (ADR 0068). On the WebSocket, a view's input rides the preview connection. */
export const commandKindCarriers = (kind: CommandKind): CommandCarriers => (kind === "preview.input" ? "http" : "any");

/** Whether a peer at `minor` on `carrier` can take a command of `kind`: the outbox checks it before it writes one. */
export const commandKindSupportedOn = (kind: CommandKind, minor: number, carrier: "websocket" | "http"): boolean =>
  commandKindSupportedAt(kind, minor) && (commandKindCarriers(kind) === "any" || carrier === "http");

/** The lowest minor that carries a command kind. The outbox never sends one to a lower peer. */
export const commandKindMinMinor = (kind: CommandKind): number => {
  switch (kind) {
    case "app.start":
    case "app.stop":
    case "screenshot.take":
    case "preview.open":
    case "preview.close":
    case "preview.input":
      return 7;
    case "resume":
      return 4;
    case "set-effort":
      return 3;
    case "question-answer":
    case "plan-answer":
    case "snapshot-build":
      return 2;
    case "release":
      return 1;
    case "dispatch":
    case "steer":
    case "interrupt":
    case "stop":
    case "approval-answer":
    case "drain":
    case "update-hint":
      return 0;
    default:
      return kind satisfies never;
  }
};

/** Whether a peer at `minor` can take a command of `kind`. */
export const commandKindSupportedAt = (kind: CommandKind, minor: number): boolean =>
  commandKindMinMinor(kind) <= minor;

const envelope = {
  type: z.literal("command"),
  seq: commandSeqSchema,
  id: commandIdSchema,
  /** Server time, in ms since the epoch. Past it, the peer rejects the command and never applies it late. */
  notAfter: epochMsSchema,
};

const sharedCommandOptions = [
  z.strictObject({ ...envelope, kind: z.literal("interrupt"), body: interruptBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("stop"), body: stopBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("drain"), body: drainBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("update-hint"), body: updateHintBodySchema }),
] as const;

const steerV1 = z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchemaV1 });
const approvalAnswerV1 = z.strictObject({ ...envelope, kind: z.literal("approval-answer"), body: approvalAnswerBodySchemaV1 });
const release = z.strictObject({ ...envelope, kind: z.literal("release"), body: releaseBodySchema });
const dispatchV3 = z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchemaV3 });
const steerV4 = z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchemaV4 });
const approvalAnswer = z.strictObject({ ...envelope, kind: z.literal("approval-answer"), body: approvalAnswerBodySchema });
const questionAnswer = z.strictObject({ ...envelope, kind: z.literal("question-answer"), body: questionAnswerBodySchema });
const planAnswer = z.strictObject({ ...envelope, kind: z.literal("plan-answer"), body: planAnswerBodySchema });

const setEffort = z.strictObject({ ...envelope, kind: z.literal("set-effort"), body: setEffortBodySchema });
const snapshotBuildV3 = z.strictObject({ ...envelope, kind: z.literal("snapshot-build"), body: snapshotBuildBodySchemaV3 });

/** Minor 2's commands, in their minor-3 shape: no dispatch `box`, no snapshot build `push` or `builder`. */
const minor2CommandOptions = [
  ...sharedCommandOptions,
  dispatchV3,
  steerV4,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuildV3,
] as const;

const snapshotBuild = z.strictObject({ ...envelope, kind: z.literal("snapshot-build"), body: snapshotBuildBodySchema });
const resume = z.strictObject({ ...envelope, kind: z.literal("resume"), body: resumeBodySchema });

const steerV7 = z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchemaV7 });
const steer = z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchema });

/** Minor 7's new commands, with every carrier's: `preview.input` is the HTTP carrier's only. */
const minor7CommandOptions = [
  z.strictObject({ ...envelope, kind: z.literal("app.start"), body: appStartBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("app.stop"), body: appStopBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("screenshot.take"), body: screenshotTakeBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("preview.open"), body: previewOpenBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("preview.close"), body: previewCloseBodySchema }),
] as const;
const previewInput = z.strictObject({ ...envelope, kind: z.literal("preview.input"), body: previewInputBodySchema });

/**
 * Commands at the current minor (8): minor 7's, with the steer's files (ADR 0070). `preview.input`
 * is in the type, and only the HTTP carrier's codec reads it (`httpDownFrameCodec`).
 */
export const commandSchema = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  steer,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
  ...minor7CommandOptions,
  previewInput,
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandOf<K extends CommandKind> = Extract<Command, { kind: K }>;

/** Minor 8's commands on the WebSocket: every kind but `preview.input`, which rides the preview connection there. */
export const commandSchemaV8WebSocket = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  steer,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
  ...minor7CommandOptions,
]);

/**
 * Minor 7's commands, for the HTTP carrier's down codec: minor 5's, with the dispatch's purpose,
 * the app's processes, a member's screenshot and the views, `preview.input` included. Its steer
 * has no files and no `ticket-update`.
 */
export const commandSchemaV7 = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  steerV7,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
  ...minor7CommandOptions,
  previewInput,
]);

/** Minor 7's commands on the WebSocket: every kind but `preview.input`, which rides the preview connection there. */
export const commandSchemaV7WebSocket = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  steerV7,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
  ...minor7CommandOptions,
]);

/** Minor 5's commands, which minor 6 kept, for the down codec: no dispatch purpose and no minor-7 kind. */
export const commandSchemaV5 = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchemaV5 }),
  steerV7,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
]);

/** Minor 4's commands, kept for the down codec: minor 3's, with `resume`, the dispatch's `box` and the build's `push` and `builder`. */
export const commandSchemaV4 = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchemaV4 }),
  steerV4,
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
]);

/** Minor 3's commands, kept for the down codec: minor 2's, with `set-effort`; no `resume`. */
export const commandSchemaV3 = z.discriminatedUnion("kind", [...minor2CommandOptions, setEffort]);

/** Minor 2's commands, kept for the down codec: no `set-effort`. */
export const commandSchemaV2 = z.discriminatedUnion("kind", [...minor2CommandOptions]);

/** Minor 1's commands, kept for the down codec: no minor-2 kind, and no minor-2 field. */
export const commandSchemaV1 = z.discriminatedUnion("kind", [...sharedCommandOptions, dispatchV3, steerV1, approvalAnswerV1, release]);

/** Minor 0's commands, kept for the down codec: no `release`. */
export const commandSchemaV0 = z.discriminatedUnion("kind", [...sharedCommandOptions, dispatchV3, steerV1, approvalAnswerV1]);

/**
 * Whether a peer at `minor` may be sent a message with files (ADR 0070, Q340): a minor-8 one. Core
 * checks it before it writes a steer with files, and the box says the task's runner needs
 * upgrading when it can't.
 */
export const canSendFiles = (peerMinor: number): boolean => peerMinor >= 8;

/**
 * A steer as a minor-7 peer reads it: without `files`, `images` and `coAuthors`, and a
 * `ticket-update` intent read as `message`. A steer that carries files is refused: core never sends
 * one below minor 8 (`canSendFiles`), and dropping them would lose the member's files without a
 * word. The co-authors are dropped: that runner's commits carry the spec's until the next dispatch.
 */
const steerForMinor7 = (body: CommandOf<"steer">["body"]): CommandOf<"steer">["body"] => {
  if ((body.files?.length ?? 0) > 0) {
    throw new Error("a steer with files can't be sent below protocol minor 8: check canSendFiles first");
  }
  const minor7 = { ...body };
  Reflect.deleteProperty(minor7, "files");
  Reflect.deleteProperty(minor7, "images");
  Reflect.deleteProperty(minor7, "coAuthors");
  if (minor7.intent !== undefined && !messageIntentSupportedAt(minor7.intent, 7)) {
    Reflect.deleteProperty(minor7, "intent");
  }
  return minor7;
};

/**
 * A command as a peer at `minor` reads it: below minor 8, `steer` loses its files (one that carries
 * any is refused), its co-authors and `ticket-update`; below minor 7, `dispatch` loses its purpose; below
 * minor 5, `dispatch` and `steer` lose
 * `automatic`, and a steer's intent of milestone 6's is dropped (it reads as `message`); below
 * minor 4, `dispatch` loses `box` and
 * `snapshot-build` loses `push` and `builder`; below minor 2, `steer` loses `intent` and
 * `approval-answer` loses `reason` and `taskRule`. Minor 3 added a kind only (`set-effort`), no
 * field. A kind the minor lacks is returned as it is,
 * and that peer refuses it: the outbox checks `commandKindSupportedAt` first.
 */
export const encodeCommandForMinor = (current: Command, minor: number): Command => {
  if (minor >= 8) {
    return current;
  }
  const command: Command = current.kind === "steer" ? { ...current, body: steerForMinor7(current.body) } : current;
  if (minor >= 7) {
    return command;
  }
  if (command.kind === "dispatch" && minor >= 5) {
    return { ...command, body: dispatchBodyStripV5.parse(command.body) };
  }
  if (minor >= 5) {
    return command;
  }
  if (command.kind === "dispatch" && minor >= 4) {
    return { ...command, body: dispatchBodyStripV4.parse(command.body) };
  }
  if (command.kind === "steer") {
    // Below minor 5 a steer loses `automatic`, and an intent of milestone 6's reads as `message`.
    const body = { ...command.body };
    Reflect.deleteProperty(body, "automatic");
    if (body.intent !== undefined && !messageIntentSupportedAt(body.intent, 4)) {
      Reflect.deleteProperty(body, "intent");
    }
    return minor >= 2 ? { ...command, body } : { ...command, body: steerBodyStripV1.parse(body) };
  }
  if (minor >= 4) {
    return command;
  }
  if (command.kind === "dispatch") {
    return { ...command, body: dispatchBodyStripV3.parse(command.body) };
  }
  if (command.kind === "snapshot-build") {
    return { ...command, body: snapshotBuildBodyStripV3.parse(command.body) };
  }
  if (minor >= 2) {
    return command;
  }
  if (command.kind === "approval-answer") {
    return { ...command, body: approvalAnswerBodyStripV1.parse(command.body) };
  }
  return command;
};

// Minor 5's dispatch as a stripping object: parsing a current body keeps minor 5's fields only.
const dispatchBodyStripV5 = z.object(dispatchBodySchemaV5.shape);

// Minor 4's dispatch as a stripping object: parsing a current body keeps minor 4's fields only.
const dispatchBodyStripV4 = z.object(dispatchBodySchemaV4.shape);

// Minor 3's bodies as stripping objects: parsing a current body keeps minor 3's fields only.
const dispatchBodyStripV3 = z.object(dispatchBodySchemaV3.shape);
const snapshotBuildBodyStripV3 = z.object(snapshotBuildBodySchemaV3.shape);

// Minor 1's bodies as stripping objects: parsing a current body keeps minor 1's fields only.
const steerBodyStripV1 = z.object(steerBodySchemaV1.shape);
const approvalAnswerBodyStripV1 = z.object(approvalAnswerBodySchemaV1.shape);

/** How a peer answers a command (ADR 0034). */
export const commandResultSchema = z.enum([
  /** Applied, or for a dispatch: the offer is taken. */
  "accepted",
  /** Refused: past `notAfter`, a stale epoch, no capacity, or an unknown session. */
  "rejected",
  /** Finished: the stop has ended the agent, the steer reached it. */
  "done",
  /** The peer crashed between starting and finishing it (a steer, mostly). The panel shows it. */
  "outcome-unknown",
]);
export type CommandResult = z.infer<typeof commandResultSchema>;
