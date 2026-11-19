import { z } from "zod";

import {
  agentProfileIdSchema,
  blobIdSchema,
  clientMessageIdSchema,
  modelIdSchema,
  organizationIdSchema,
  projectIdSchema,
  providerIdSchema,
  repoIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketKeySchema,
} from "../ids.ts";
import {
  apiFormatSchema,
  branchNameSchema,
  envNameSchema,
  gitShaSchema,
  httpUrlSchema,
  leaseEpochSchema,
  repoFullNameSchema,
  taskKindSchema,
} from "../common.ts";
import { ticketFileNameSchema } from "../events/agent-events.ts";
import { blobRefSchema, contentTypeSchema } from "../runner/blobs.ts";
import { runnerLimits } from "../runner/limits.ts";

// The task spec: what a dispatch hands the runner, fetched from
// `GET /runner/v1/tasks/:taskId/spec` once the runner has accepted the offer (ADR 0034). It holds
// references and the task's text, never a secret: the secrets are the task credentials, fetched by
// a separate call after the lease check (`credentials.ts`, ADR 0030).

/** A folder name inside the task's workspace: one segment, no `..`, no separators. */
export const checkoutDirSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/, "one folder name inside the workspace");

/** A path relative to a repo's checkout, with forward slashes and no `..` segment. */
export const repoRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/, "a relative path inside the repo");

/** A host name an LFS action may call (ADR 0030, Q119): no scheme, no path. */
export const hostNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/, "a host name");

export const taskSpecRepoSchema = z.strictObject({
  repoId: repoIdSchema,
  fullName: repoFullNameSchema,
  /** The code host's HTTPS clone URL. The runner clones through its git proxy, never directly. */
  cloneUrl: z.url({ protocol: /^https$/ }),
  defaultBranch: branchNameSchema,
  /** The repo's folder in the workspace, side by side with the others (F-016). */
  checkoutDir: checkoutDirSchema,
  /** Hosts the code host's LFS batch answers may send the git proxy to (ADR 0030, Q119). */
  lfsActionHosts: z.array(hostNameSchema),
  /** The repo's PR template, when it has one (F-078). The agent fills it in for the PR body. */
  prTemplate: z.string().max(65_536).nullable(),
});
export type TaskSpecRepo = z.infer<typeof taskSpecRepoSchema>;

export const taskSpecAgentSchema = z.strictObject({
  profileId: agentProfileIdSchema,
  /** The `AgentAdapter`'s registered name, such as `opencode`. */
  adapter: z.string().min(1).max(64),
  providerId: providerIdSchema,
  /** ostra's ID of the model. */
  modelId: modelIdSchema,
  /** The model as the endpoint names it, which the agent sends in its requests. */
  endpointModelId: z.string().min(1).max(256),
  apiFormat: apiFormatSchema,
  /** The profile's extra instructions, when it has any. */
  instructions: z.string().max(65_536).nullable(),
});
export type TaskSpecAgent = z.infer<typeof taskSpecAgentSchema>;

/** A non-secret variable of one repo. Secrets are in the task credentials. */
export const taskSpecVariableSchema = z.strictObject({
  name: envNameSchema,
  value: z.string().max(65_536),
  /** Set while the setup script runs. Every variable is also set for the agent. */
  availableDuringSetup: z.boolean(),
});

/** A non-secret file of one repo, written into its checkout before setup. */
export const taskSpecFileSchema = z.strictObject({
  path: repoRelativePathSchema,
  content: z.string().max(1_048_576),
});

export const taskSpecEnvironmentSchema = z.strictObject({
  /** The project's setup script, run with `bash` in the workspace, or `null` for none (F-050). */
  setupScript: z.string().max(262_144).nullable(),
  /** The `docker` executor's base image; the `host` executor ignores it (ADR 0038). */
  baseImage: z.string().max(512).nullable(),
  /** Per repo of the task: its variables and files. Nothing is shared across repos. */
  repos: z.array(
    z.strictObject({
      repoId: repoIdSchema,
      variables: z.array(taskSpecVariableSchema),
      files: z.array(taskSpecFileSchema),
      /** Where the repo's variables and secrets are written in its checkout (spec section 11, item 7). */
      envFile: repoRelativePathSchema,
    }),
  ),
});
export type TaskSpecEnvironment = z.infer<typeof taskSpecEnvironmentSchema>;

/**
 * A person as git writes them in a commit or a `Co-authored-by` trailer. Neither part may hold
 * `<`, `>` or a line break, so a name can't forge another trailer. The email is checked loosely,
 * because a GitHub App's bot address (`123+app[bot]@users.noreply.github.com`) is not RFC-shaped.
 */
export const gitPersonSchema = z.strictObject({
  name: z.string().min(1).max(256).regex(/^[^<>\r\n]+$/, "no angle brackets or line breaks"),
  email: z.string().min(3).max(320).regex(/^[^\s<>@]+@[^\s<>@]+$/, "an email address"),
});
export type GitPerson = z.infer<typeof gitPersonSchema>;

// ---------- minor 1's additions (milestone 2) ----------

/** The ticket a ticket task works, for the runner's logs by key and the agent's context. */
export const taskSpecTicketSchema = z.strictObject({
  key: ticketKeySchema,
  /** The ticket's title. Untrusted text: data, never a shell argument. Never logged. */
  title: z.string().min(1).max(1024),
  url: httpUrlSchema,
});
export type TaskSpecTicket = z.infer<typeof taskSpecTicketSchema>;

/** A ticket image core copied into the blob store, for the runner to write under `.ostra/ticket/`. */
export const taskSpecContextFileSchema = z.strictObject({
  blobId: blobIdSchema,
  /** Its file name inside `TICKET_FILES_DIR`, which the prompt names. */
  path: ticketFileNameSchema,
  contentType: contentTypeSchema,
  size: z.number().int().nonnegative().max(runnerLimits.ticketFileMaxBytes),
});
export type TaskSpecContextFile = z.infer<typeof taskSpecContextFileSchema>;

/** How this session starts: fresh, or which of ADR 0039's three steps restores it. */
export const restoreStepSchema = z.enum(["new", "resumed", "restored", "rebuilt"]);
export type RestoreStep = z.infer<typeof restoreStepSchema>;

/** One repo's saved work in progress (ADR 0039, Q150). */
export const hiddenRefRestoreSchema = z.strictObject({
  repoId: repoIdSchema,
  /** The commit `refs/ostra/wip/<taskId>` points at. */
  sha: gitShaSchema,
  /** The branch head it was saved on; the branch's commits since then are merged in after it. */
  baseSha: gitShaSchema,
});
export type HiddenRefRestore = z.infer<typeof hiddenRefRestoreSchema>;

/** A member's message the session hasn't answered yet: replayed as the first prompt (F-047). */
export const pendingMessageSchema = z.strictObject({
  clientMessageId: clientMessageIdSchema,
  /** The member's text. Never logged. */
  text: z.string().min(1).max(runnerLimits.steerTextMaxChars),
});
export type PendingMessage = z.infer<typeof pendingMessageSchema>;

/**
 * The restore section (ADR 0039). `resumed` uses the box the runner still holds. `restored` imports
 * the archive and the hidden refs on a fresh box. `rebuilt` starts a new agent session whose first
 * prompt is the rebuild template, which is the spec's `prompt`.
 */
export const taskSpecRestoreSchema = z.strictObject({
  origin: restoreStepSchema,
  /** The session archive to import, for `restored`. */
  archive: blobRefSchema.nullable(),
  hiddenRefs: z.array(hiddenRefRestoreSchema),
  pendingMessages: z.array(pendingMessageSchema).max(100),
});
export type TaskSpecRestore = z.infer<typeof taskSpecRestoreSchema>;

/** Prices in micro-USD per million tokens, for the four token kinds (ADR 0042, Q163). */
export const tokenPricesSchema = z.strictObject({
  inputPerMTok: z.number().int().nonnegative(),
  outputPerMTok: z.number().int().nonnegative(),
  cacheReadPerMTok: z.number().int().nonnegative(),
  cacheWritePerMTok: z.number().int().nonnegative(),
});
export type TokenPrices = z.infer<typeof tokenPricesSchema>;

/**
 * The task's spend cap, which the key proxy enforces (F-068): in micro-USD when the model has a
 * price, or in tokens when it has none (spec section 11, item 8). `spent` is what earlier sessions
 * already used.
 */
export const spendCapSchema = z.union([
  z.strictObject({
    capMicroUsd: z.number().int().positive(),
    spentMicroUsd: z.number().int().nonnegative(),
    prices: tokenPricesSchema,
  }),
  z.strictObject({
    capTokens: z.number().int().positive(),
    spentTokens: z.number().int().nonnegative(),
  }),
]);
export type SpendCap = z.infer<typeof spendCapSchema>;

const taskSpecLimitsV0 = z.strictObject({
  /** The longest a turn may run before the runner cancels it. */
  turnMaxMinutes: z.number().int().positive().max(24 * 60),
});

const taskSpecLimits = taskSpecLimitsV0.extend({
  /** Minor 1: with no turn for this long, the runner stops the agent (F-096). */
  idleMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
  /** Minor 1: the spend cap. The maximum duration and the stall are core's timers. */
  spendCap: spendCapSchema.optional(),
});

const taskSpecShapeV0 = {
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  projectId: projectIdSchema,
  organizationId: organizationIdSchema,
  kind: taskKindSchema,
  title: z.string().min(1).max(512),
  /** The member's prompt, the rendered ticket, or the rebuild template. Never logged. */
  prompt: z.string().max(262_144),
  /** The same branch name in every repo of the task (spec section 11, item 10). */
  branchName: branchNameSchema,
  leaseEpoch: leaseEpochSchema,
  repos: z.array(taskSpecRepoSchema).min(1),
  agent: taskSpecAgentSchema,
  environment: taskSpecEnvironmentSchema,
  /** The App's bot identity, which authors every commit (F-078, ADR 0040). */
  gitIdentity: gitPersonSchema,
  /** Who gets a `Co-authored-by` trailer: the member who prompted, in milestone 1. */
  coAuthors: z.array(gitPersonSchema),
};

/** Minor 0's task spec, kept for the spec endpoint's answer to a minor-0 runner. */
export const taskSpecSchemaV0 = z
  .strictObject({ ...taskSpecShapeV0, limits: taskSpecLimitsV0 })
  .describe("The task spec a dispatch hands a minor-0 runner. It holds no secret.");

/** The task spec at the current minor (1). Every minor-1 field is optional, so a minor-0 spec parses. */
export const taskSpecSchema = z
  .strictObject({
    ...taskSpecShapeV0,
    limits: taskSpecLimits,
    /** Minor 1: the ticket of a ticket task, `null` for a prompt task. */
    ticket: taskSpecTicketSchema.nullable().optional(),
    /** Minor 1: ticket images to write under `TICKET_FILES_DIR` before the agent starts. */
    contextFiles: z.array(taskSpecContextFileSchema).max(runnerLimits.ticketFilesMax).optional(),
    /** Minor 1: how the session starts. Missing means `new`. The pending messages' text is never logged. */
    restore: taskSpecRestoreSchema.optional(),
  })
  .describe("The task spec a dispatch hands the runner. It holds no secret.");
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** The spec in the shape a runner at `minor` reads: below minor 1, minor 1's fields are dropped. */
export const encodeTaskSpecForMinor = (spec: TaskSpec, minor: number): TaskSpec => {
  if (minor >= 1) {
    return spec;
  }
  return {
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    projectId: spec.projectId,
    organizationId: spec.organizationId,
    kind: spec.kind,
    title: spec.title,
    prompt: spec.prompt,
    branchName: spec.branchName,
    leaseEpoch: spec.leaseEpoch,
    repos: spec.repos,
    agent: spec.agent,
    environment: spec.environment,
    gitIdentity: spec.gitIdentity,
    coAuthors: spec.coAuthors,
    limits: { turnMaxMinutes: spec.limits.turnMaxMinutes },
  };
};

/** The spec endpoint's answer schema for a runner at `minor`. */
export const taskSpecResponseSchemaFor = (minor: number): typeof taskSpecSchema | typeof taskSpecSchemaV0 =>
  minor >= 1 ? taskSpecSchema : taskSpecSchemaV0;
