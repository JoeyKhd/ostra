import { z } from "zod";

import {
  approvalIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  commandIdSchema,
  effortChangeIdSchema,
  projectIdSchema,
  questionIdSchema,
  repoIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  taskIdSchema,
} from "../ids.ts";
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
  messageIntentSupportedAt,
  planTextSchema,
} from "../events/agent-events.ts";
import {
  checkoutDirSchema,
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
 * `dispatch` at the current minor (5): an offer of a task. The peer answers `accepted` or
 * `rejected` within the offer timeout. Minor 5: whether the session's first turn is an automatic
 * round (F-101, ADR 0041), so the runner answers its questions with the neutral reply. Missing
 * means `false`. A minor-4 peer never sees it: core starts an automatic round on a minor-5 runner.
 */
export const dispatchBodySchema = dispatchBodySchemaV4.extend({
  automatic: z.boolean().optional(),
});

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
 * `steer` at the current minor (5): minor 2's, with milestone 6's intents and whether the turn it
 * starts is an automatic round (F-101, ADR 0041). Missing `automatic` means `false`. The text of a
 * `fix-ci`, `fix-findings`, `changes-requested` or `linear-follow-up` message is ostra's prompt
 * around untrusted text, and is never logged.
 */
export const steerBodySchema = steerBodySchemaV1.extend({
  /** Minor 2: why the message was written, for the thread's marker. Missing means `message`. */
  intent: messageIntentSchema.optional(),
  /** Minor 5: the turn is an automatic round: the runner answers its questions with the neutral reply. */
  automatic: z.boolean().optional(),
});

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
]);
export type CommandKind = z.infer<typeof commandKindSchema>;
export type CommandBody<K extends CommandKind> = z.infer<(typeof commandBodySchemas)[K]>;

/** The lowest minor that carries a command kind. The outbox never sends one to a lower peer. */
export const commandKindMinMinor = (kind: CommandKind): number => {
  switch (kind) {
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

/** Commands at the current minor (5): minor 4's, with the dispatch's and the steer's `automatic` and the steer's new intents. */
export const commandSchema = z.discriminatedUnion("kind", [
  ...sharedCommandOptions,
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchema }),
  approvalAnswer,
  release,
  questionAnswer,
  planAnswer,
  snapshotBuild,
  setEffort,
  resume,
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandOf<K extends CommandKind> = Extract<Command, { kind: K }>;

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
 * A command as a peer at `minor` reads it: below minor 5, `dispatch` and `steer` lose
 * `automatic`, and a steer's intent of milestone 6's is dropped (it reads as `message`); below
 * minor 4, `dispatch` loses `box` and
 * `snapshot-build` loses `push` and `builder`; below minor 2, `steer` loses `intent` and
 * `approval-answer` loses `reason` and `taskRule`. Minor 3 added a kind only (`set-effort`), no
 * field. A kind the minor lacks is returned as it is,
 * and that peer refuses it: the outbox checks `commandKindSupportedAt` first.
 */
export const encodeCommandForMinor = (command: Command, minor: number): Command => {
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
