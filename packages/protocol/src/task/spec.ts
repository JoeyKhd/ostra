import { z } from "zod";

import {
  agentProfileIdSchema,
  blobIdSchema,
  checkIdSchema,
  clientMessageIdSchema,
  modelIdSchema,
  organizationIdSchema,
  projectIdSchema,
  providerIdSchema,
  repoIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  taskIdSchema,
  ticketKeySchema,
} from "../ids.ts";
import {
  apiFormatSchema,
  branchNameSchema,
  envNameSchema,
  gitShaSchema,
  httpUrlSchema,
  imageDigestSchema,
  leaseEpochSchema,
  repoFullNameSchema,
  serviceNameSchema,
  taskKindSchema,
} from "../common.ts";
import { approvalRulesSchema, taskRulesSchema } from "../agent/rules.ts";
import { ticketFileNameSchema, turnModeSchema } from "../events/agent-events.ts";
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

/** The agent section at minors 0 and 1. */
export const taskSpecAgentSchemaV1 = z.strictObject({
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

// ---------- minor 2's agent section (milestone 3, ADR 0049) ----------

/** A skill's or an MCP server's name: letters, digits, `_` and `-`. */
export const agentItemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "letters, digits, '_' and '-'");

/** A skill (F-021): its `SKILL.md` as a blob and up to 20 more files, written into the task's own config folder. */
export const taskSpecSkillSchema = z.strictObject({
  name: agentItemNameSchema,
  /** The `SKILL.md` text, as a blob. */
  blobId: blobIdSchema,
  files: z.array(z.strictObject({ path: repoRelativePathSchema, blobId: blobIdSchema })).max(runnerLimits.skillFilesMax),
});
export type TaskSpecSkill = z.infer<typeof taskSpecSkillSchema>;

/** A path on the sidecar's MCP proxy, such as `/mcp/linear`. */
export const mcpProxyPathSchema = z
  .string()
  .min(2)
  .max(256)
  .regex(/^\/[A-Za-z0-9/_-]+$/, "a path on the sidecar's MCP proxy");

const mcpReadOnly = {
  /** Plan mode may call only a read-only server's tools, and "Reaching the network" doesn't ask for them. Absent: false. */
  readOnly: z.boolean().default(false),
};

/**
 * An MCP server (ADR 0049, Q170). An HTTP server is a path on the sidecar's MCP proxy, which adds
 * its URL and secret headers from the credentials, so the agent never holds them. A stdio server
 * is a command already in the image, with variables that hold no secret.
 */
export const taskSpecMcpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({ name: agentItemNameSchema, transport: z.literal("http"), proxyPath: mcpProxyPathSchema, ...mcpReadOnly }),
  z.strictObject({
    name: agentItemNameSchema,
    transport: z.literal("stdio"),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(100),
    /** Variables for the server's process. Never a secret: a server that needs one is an HTTP server behind the proxy. */
    env: z.record(envNameSchema, z.string().max(65_536)),
    ...mcpReadOnly,
  }),
]);
export type TaskSpecMcpServer = z.infer<typeof taskSpecMcpServerSchema>;

/** The agent section at the current minor (2): minor 1's, with the profile's skills, MCP servers and rules. */
export const taskSpecAgentSchema = taskSpecAgentSchemaV1.extend({
  /** Minor 2: the profile's skills. */
  skills: z.array(taskSpecSkillSchema).max(runnerLimits.skillsMax).optional(),
  /** Minor 2: the profile's MCP servers. */
  mcpServers: z.array(taskSpecMcpServerSchema).max(runnerLimits.mcpServersMax).optional(),
  /** Minor 2: the profile's approval rules: what needs a person. */
  approvalRules: approvalRulesSchema.optional(),
  /** Minor 2: the task's "for this task" rules, which the runner answers itself. */
  taskRules: taskRulesSchema.optional(),
  /** Minor 2: the profile's plan first. The task's first session starts in plan mode (`firstTurnMode`). */
  planFirst: z.boolean().optional(),
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
  agent: taskSpecAgentSchemaV1,
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


const taskSpecShapeV1 = {
  ...taskSpecShapeV0,
  limits: taskSpecLimits,
  /** Minor 1: the ticket of a ticket task, `null` for a prompt task. */
  ticket: taskSpecTicketSchema.nullable().optional(),
  /** Minor 1: ticket images to write under `TICKET_FILES_DIR` before the agent starts. */
  contextFiles: z.array(taskSpecContextFileSchema).max(runnerLimits.ticketFilesMax).optional(),
  /** Minor 1: how the session starts. Missing means `new`. The pending messages' text is never logged. */
  restore: taskSpecRestoreSchema.optional(),
};

/** Minor 1's task spec, kept for the spec endpoint's answer to a minor-1 runner. */
export const taskSpecSchemaV1 = z
  .strictObject(taskSpecShapeV1)
  .describe("The task spec a dispatch hands a minor-1 runner. It holds no secret.");

// ---------- minor 2's additions (milestone 3) ----------

/**
 * A check the runner runs after a turn with changes, before the push (F-054, ADR 0052). Its
 * command is the environment's, written by an admin: run as a command line in the agent's
 * environment, never built from task text, and never with a model key or a git token.
 */
export const taskSpecCheckSchema = z.strictObject({
  checkId: checkIdSchema,
  name: z.string().min(1).max(200),
  command: z.string().min(1).max(8192),
  /** Runs in this repo's folder on a turn that changed it; `null` runs once at the workspace root (Q188). */
  repoId: repoIdSchema.nullable(),
  timeoutSeconds: z.number().int().positive().max(runnerLimits.checkTimeoutMaxSeconds),
});
export type TaskSpecCheck = z.infer<typeof taskSpecCheckSchema>;

/** A service the `docker` executor starts on the box's network before the agent (F-094). */
export const taskSpecServiceSchema = z.strictObject({
  /** Also its host name on the box's network. */
  name: serviceNameSchema,
  image: z.string().min(1).max(512),
  port: z.number().int().min(1).max(65_535).nullable(),
  /** Non-secret variables of the service's container. */
  variables: z.array(z.strictObject({ name: envNameSchema, value: z.string().max(65_536) })).max(200),
  /** A command run in the service's container until it exits 0, or `null` to wait for the port. */
  healthCheck: z.string().min(1).max(2048).nullable(),
});
export type TaskSpecService = z.infer<typeof taskSpecServiceSchema>;

/**
 * What the box starts from (F-051, ADR 0038): on `docker`, a snapshot image this runner holds; on
 * `host`, the project's repo mirrors and dependency cache; `null` for a full setup.
 */
export const taskSpecSnapshotSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("image"),
      snapshotId: snapshotIdSchema,
      imageRef: z.string().min(1).max(512),
      digest: imageDigestSchema,
    }),
    z.strictObject({
      kind: z.literal("host-cache"),
      /** Names the project's mirror and cache folder on the runner. */
      cacheKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, "a folder-safe key"),
    }),
  ])
  .nullable();
export type TaskSpecSnapshot = z.infer<typeof taskSpecSnapshotSchema>;

/**
 * The task spec at the current minor (2). Every minor-1 and minor-2 field is optional, so a
 * minor-1 or minor-0 spec parses.
 */
export const taskSpecSchema = z
  .strictObject({
    ...taskSpecShapeV1,
    agent: taskSpecAgentSchema,
    /** Minor 2: how the session's first turn runs. `plan` only for a task's first session with plan first. */
    firstTurnMode: turnModeSchema.optional(),
    /** Minor 2: the environment's checks, in order. */
    checks: z.array(taskSpecCheckSchema).max(runnerLimits.checksMax).optional(),
    /**
     * Minor 2: all of a turn's checks together (`OSTRA_CHECKS_TOTAL_MINUTES`); past it, the rest are
     * `timed-out` without running. Missing means `runnerLimits.checksTotalMinutes`.
     */
    checksTotalMinutes: z.number().int().positive().max(24 * 60).optional(),
    /** Minor 2: the environment's services; a `host` runner is never offered a task that has any. */
    services: z.array(taskSpecServiceSchema).max(runnerLimits.servicesMax).optional(),
    /** Minor 2: what the box starts from. */
    snapshot: taskSpecSnapshotSchema.optional(),
  })
  .describe("The task spec a dispatch hands the runner. It holds no secret.");
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** Minor 1's spec as a stripping object: parsing a current spec keeps minor 1's top-level fields. */
const taskSpecStripV1 = z.object({ ...taskSpecShapeV1, agent: z.object(taskSpecAgentSchemaV1.shape) });

/** The agent section without minor 2's fields. */
const agentForMinor1 = (agent: TaskSpecAgent): TaskSpecAgent => ({
  profileId: agent.profileId,
  adapter: agent.adapter,
  providerId: agent.providerId,
  modelId: agent.modelId,
  endpointModelId: agent.endpointModelId,
  apiFormat: agent.apiFormat,
  instructions: agent.instructions,
});

/**
 * The spec in the shape a runner at `minor` reads: below minor 2, minor 2's fields are dropped;
 * below minor 1, minor 1's too. Core never dispatches a task that needs minor 2 (plan first,
 * checks, services, profile rules) to a minor-1 runner, so nothing it needs is lost.
 */
export const encodeTaskSpecForMinor = (spec: TaskSpec, minor: number): TaskSpec => {
  if (minor >= 2) {
    return spec;
  }
  const agent = agentForMinor1(spec.agent);
  if (minor >= 1) {
    return { ...taskSpecStripV1.parse(spec), agent };
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
    agent,
    environment: spec.environment,
    gitIdentity: spec.gitIdentity,
    coAuthors: spec.coAuthors,
    limits: { turnMaxMinutes: spec.limits.turnMaxMinutes },
  };
};

/** Whether a spec uses anything a runner below minor 2 can't do, so core offers it only to a minor-2 runner. */
export const taskSpecNeedsMinor2 = (spec: TaskSpec): boolean =>
  spec.firstTurnMode === "plan" ||
  (spec.checks?.length ?? 0) > 0 ||
  (spec.services?.length ?? 0) > 0 ||
  (spec.snapshot !== undefined && spec.snapshot !== null) ||
  (spec.agent.approvalRules?.length ?? 0) > 0 ||
  (spec.agent.skills?.length ?? 0) > 0 ||
  (spec.agent.mcpServers?.length ?? 0) > 0;

/** The spec endpoint's answer schema for a runner at `minor`. */
export const taskSpecResponseSchemaFor = (
  minor: number,
): typeof taskSpecSchema | typeof taskSpecSchemaV1 | typeof taskSpecSchemaV0 => {
  if (minor >= 2) {
    return taskSpecSchema;
  }
  return minor >= 1 ? taskSpecSchemaV1 : taskSpecSchemaV0;
};
