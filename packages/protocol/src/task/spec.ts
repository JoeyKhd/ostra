import { z } from "zod";

import {
  agentProfileIdSchema,
  blobIdSchema,
  checkIdSchema,
  clientMessageIdSchema,
  modelIdSchema,
  noteIdSchema,
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
import { effortLevelSchema, reasoningControlsSchema } from "../agent/effort.ts";
import { approvalRulesSchema, taskRulesSchema } from "../agent/rules.ts";
import { ticketFileNameSchema, turnModeSchema } from "../events/agent-events.ts";
import { blobRefSchema, contentTypeSchema } from "../runner/blobs.ts";
import { utf8ByteLength } from "../json.ts";
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

/** A repo of the task at minors 0 to 2. */
export const taskSpecRepoSchemaV0 = z.strictObject({
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

/**
 * A repo of the task at the current minor (3): minor 0's, with the bot of that repo's App (F-136,
 * ADR 0065). Missing means the spec's top-level `gitIdentity`.
 */
export const taskSpecRepoSchema = taskSpecRepoSchemaV0.extend({
  /** Minor 3: the bot that authors this repo's commits, when its App isn't the task's first. */
  gitIdentity: gitPersonSchema.optional(),
  /**
   * Minor 3: this repo's own branch, when it isn't the task's (F-066, ticket 24): a reopen after a
   * partial merge gives the merged repo a fresh `-2` branch while the others keep theirs. Missing
   * means the spec's top-level `branchName`.
   */
  branchName: branchNameSchema.optional(),
});
export type TaskSpecRepo = z.infer<typeof taskSpecRepoSchema>;

/** The branch ostra pushes a repo's work to: its own when it has one, else the task's. */
export const repoBranchName = (spec: { readonly branchName: string }, repo: { readonly branchName?: string | undefined }): string =>
  repo.branchName ?? spec.branchName;

/** The bot that authors a repo's commits (F-136, ADR 0065): its own App's when the spec names one, else the task's. */
export const repoGitIdentity = (spec: { readonly gitIdentity: GitPerson }, repo: { readonly gitIdentity?: GitPerson | undefined }): GitPerson =>
  repo.gitIdentity ?? spec.gitIdentity;

/** Whether every repo of a spec is committed as the task's top-level bot, so one identity serves the whole box. */
export const taskSpecHasOneGitIdentity = (spec: {
  readonly gitIdentity: GitPerson;
  readonly repos: readonly { readonly gitIdentity?: GitPerson | undefined }[];
}): boolean =>
  spec.repos.every((repo) => {
    const person = repoGitIdentity(spec, repo);
    return person.name === spec.gitIdentity.name && person.email === spec.gitIdentity.email;
  });

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

/** The agent section at minor 2: minor 1's, with the profile's skills, MCP servers and rules. */
export const taskSpecAgentSchemaV2 = taskSpecAgentSchemaV1.extend({
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

/** A model's context window and output limit, in tokens, `null` when unknown (F-137, ADR 0066). */
export const taskSpecModelLimitsSchema = z.strictObject({
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});
export type TaskSpecModelLimits = z.infer<typeof taskSpecModelLimitsSchema>;

/**
 * The agent section at minors 3 to 5: minor 2's, with the profile's closing turn, and the task's
 * reasoning level with its model's controls and limits.
 */
export const taskSpecAgentSchemaV3 = taskSpecAgentSchemaV2.extend({
  /**
   * Minor 3: the profile's closing turn (F-111, ADR 0044). After the task's last turn the runner
   * runs one more, asking the agent to propose what the next task should know. Missing means off.
   */
  closingTurn: z.boolean().optional(),
  /** Minor 3: the task's reasoning level, clamped to its model's (F-137, ADR 0066). Missing means `default`. */
  effort: effortLevelSchema.optional(),
  /** Minor 3: the model's effective reasoning controls, for the agent's config. */
  reasoning: reasoningControlsSchema.optional(),
  /** Minor 3: the model's real limits. Missing, or both `null`, keeps the agent's fixed ones. */
  limits: taskSpecModelLimitsSchema.optional(),
});

/**
 * The agent section at the current minor (6): minor 3's, with whether the repos' own skills reach
 * the agent.
 */
export const taskSpecAgentSchema = taskSpecAgentSchemaV3.extend({
  /**
   * Minor 6: whether each repo's own skills (its `.agents/skills`, `.claude/skills` and
   * `.opencode/skills`, read from the task's checkout) reach the agent beside the profile's: the
   * project's setting (F-021, ADR 0049 amended 2026-11-21). Missing means they do. A runner below
   * minor 6 is never offered a task with them off (`isTaskOfferable`).
   */
  repoSkills: z.boolean().optional(),
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
/** A context file at minors 1 to 4: a ticket image, written under `TICKET_FILES_DIR`. */
export const taskSpecContextFileSchemaV4 = z.strictObject({
  blobId: blobIdSchema,
  /** Its file name inside `TICKET_FILES_DIR`, which the prompt names. */
  path: ticketFileNameSchema,
  contentType: contentTypeSchema,
  size: z.number().int().nonnegative().max(runnerLimits.ticketFileMaxBytes),
});

/** The workspace folder a CI round's log tails are written to, beside `TICKET_FILES_DIR` (F-035). */
export const CI_FILES_DIR = ".ostra/ci";

/** Which folder a context file goes to: the ticket's (`TICKET_FILES_DIR`) or a CI round's (`CI_FILES_DIR`). */
export const contextFileFolderSchema = z.enum(["ticket", "ci"]);
export type ContextFileFolder = z.infer<typeof contextFileFolderSchema>;

/**
 * A context file at the current minor (5): minor 1's, with its folder. A CI round's log tails
 * (F-035, ADR 0058) travel as `ci` files, named `<check>.log`, core fetched with the App's token:
 * the agent's box holds no code host credential (ADR 0030). A log's text is never logged.
 */
export const taskSpecContextFileSchema = taskSpecContextFileSchemaV4.extend({
  /** Minor 5: the folder. Missing means `ticket`. A minor-4 runner is sent no `ci` file. */
  folder: contextFileFolderSchema.optional(),
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
  repos: z.array(taskSpecRepoSchemaV0).min(1),
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
  contextFiles: z.array(taskSpecContextFileSchemaV4).max(runnerLimits.ticketFilesMax).optional(),
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

const taskSpecShapeV2 = {
    ...taskSpecShapeV1,
    agent: taskSpecAgentSchemaV2,
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
};

/** Minor 2's task spec, kept for the spec endpoint's answer to a minor-2 runner. */
export const taskSpecSchemaV2 = z
  .strictObject(taskSpecShapeV2)
  .describe("The task spec a dispatch hands a minor-2 runner. It holds no secret.");

// ---------- minor 3's additions (milestone 4) ----------

/**
 * The memory section (F-110, ADR 0044): the block core rendered, which the runner writes where
 * the agent reads its instructions, so the runner needs no renderer. The ID lists are what the
 * runner reports in `memory.used`. The block's text is never logged.
 */
export const taskSpecMemorySchema = z
  .strictObject({
    /** The "always" notes, the index and the standing instruction, within the limits. Never logged. */
    block: z
      .string()
      .max(runnerLimits.memoryBlockMaxBytes)
      .refine((block) => utf8ByteLength(block) <= runnerLimits.memoryBlockMaxBytes, "at most the memory block's size"),
    /** The notes the index lists, in its order. */
    indexNoteIds: z.array(noteIdSchema).max(runnerLimits.memoryIndexMaxNotes),
    /** The notes carried in full. */
    alwaysNoteIds: z.array(noteIdSchema).max(runnerLimits.memoryIndexMaxNotes),
    /** How many notes didn't fit, for the block's "N more notes" line. */
    omitted: z.number().int().nonnegative(),
    /** Whether the agent gets `memory_search`, `memory_read` and `memory_propose` (an MCP agent). */
    tools: z.boolean(),
  })
  .describe("The task's memory: the block's text is never logged.");
export type TaskSpecMemory = z.infer<typeof taskSpecMemorySchema>;

const taskSpecShapeV3 = {
  ...taskSpecShapeV2,
  repos: z.array(taskSpecRepoSchema).min(1),
  agent: taskSpecAgentSchemaV3,
  /** Minor 3: the organization's and the project's approved notes, or `null` for none. */
  memory: taskSpecMemorySchema.nullable().optional(),
};

/**
 * Minor 3's task spec, which minor 4 kept unchanged: the spec endpoint's answer to a minor-3 or
 * minor-4 runner.
 */
export const taskSpecSchemaV3 = z
  .strictObject(taskSpecShapeV3)
  .describe("The task spec a dispatch hands a minor-3 or minor-4 runner. It holds no secret.");

// ---------- minor 5's additions (milestone 6) ----------

/** One repo of a review task's checkout: its PR, checked out at the PR's head, read-only (F-100, ADR 0058). */
export const taskSpecReviewRepoSchema = z.strictObject({
  repoId: repoIdSchema,
  prNumber: z.number().int().positive(),
  /** The PR's base when the review started: the diff is `baseSha...headSha`. */
  baseSha: gitShaSchema,
  /** The head the review reads, and its findings' lines refer to. */
  headSha: gitShaSchema,
});
export type TaskSpecReviewRepo = z.infer<typeof taskSpecReviewRepoSchema>;

/** A review task's checkout (F-100): the code task it reviews, the round, and each repo at its PR's head. */
export const taskSpecReviewSchema = z.strictObject({
  codeTaskId: taskIdSchema,
  /** The review round, from 1: the code task's first review, then one per fixing round's heads. */
  round: z.number().int().positive(),
  repos: z.array(taskSpecReviewRepoSchema).min(1).max(runnerLimits.projectReposMax),
});
export type TaskSpecReview = z.infer<typeof taskSpecReviewSchema>;

/**
 * ostra's MCP tools the sidecar serves one task (ADR 0028, ADR 0038, ADR 0044): the PR's text
 * (`set_pull_request_text`), the memory tools, a refine draft (`submit_draft`), a review
 * (`submit_review`) and an environment proposal (`propose_environment`).
 */
export const ostraToolSetSchema = z.enum(["pr-text", "memory", "draft", "review", "environment"]);
export type OstraToolSet = z.infer<typeof ostraToolSetSchema>;

/** The tool sets a spec without `tools` gets: milestone 4's. */
export const defaultOstraToolSets: readonly OstraToolSet[] = ["pr-text", "memory"];

/**
 * A path the runner may commit (F-113, ADR 0038): a repo-relative path, or a glob of one (`*`
 * within a segment, `**` across segments).
 */
export const commitPathSchema = repoRelativePathSchema;

const taskSpecShapeV5 = {
  ...taskSpecShapeV3,
  /** Minor 1; minor 5 adds each file's folder, for a CI round's log tails. */
  contextFiles: z
    .array(taskSpecContextFileSchema)
    .max(runnerLimits.ticketFilesMax + runnerLimits.ciLogChecksMax)
    .optional(),
  /** Minor 5: a review task's checkout, each repo at its PR's head. `null` or missing for every other task. */
  review: taskSpecReviewSchema.nullable().optional(),
  /** Minor 5: which of ostra's MCP tools the sidecar serves. Missing means `defaultOstraToolSets`. */
  tools: z
    .array(ostraToolSetSchema)
    .max(ostraToolSetSchema.options.length)
    .refine((tools) => new Set(tools).size === tools.length, "each tool set once")
    .optional(),
  /**
   * Minor 5: the paths the runner may commit, in every repo; the rest stays uncommitted and is
   * reported in `commit.filtered`. `null` or missing means everything (an onboarding task has
   * `["AGENTS.md"]`).
   */
  commitPaths: z.array(commitPathSchema).min(1).max(runnerLimits.commitPathsMax).nullable().optional(),
  /** Minor 5: the session's first turn is an automatic round (F-101): its questions get the neutral reply. */
  automatic: z.boolean().optional(),
};

/** Minor 5's task spec: the spec endpoint's answer to a minor-5 runner. */
export const taskSpecSchemaV5 = z
  .strictObject(taskSpecShapeV5)
  .describe("The task spec a dispatch hands a minor-5 runner. It holds no secret.");

/**
 * The task spec at the current minor (6). Every field added since minor 0 is optional, so a
 * minor-5, minor-4, minor-3, minor-2, minor-1 or minor-0 spec parses. A minor-5 runner is sent
 * minor 5's shape and a minor-4 runner minor 3's (`encodeTaskSpecForMinor`), and core never offers
 * a runner a task that needs a later minor than its own (`isTaskOfferable`).
 */
export const taskSpecSchema = z
  .strictObject({
    ...taskSpecShapeV5,
    /** Minor 6: the agent section with `repoSkills`. */
    agent: taskSpecAgentSchema,
  })
  .describe("The task spec a dispatch hands the runner. It holds no secret.");
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** The tool sets a spec asks the sidecar to serve. */
export const taskSpecToolSets = (spec: TaskSpec): readonly OstraToolSet[] => spec.tools ?? defaultOstraToolSets;

/** Minor 2's spec as a stripping object: parsing a current spec keeps minor 2's fields. */
const taskSpecStripV2 = z.object({
  ...taskSpecShapeV2,
  repos: z.array(z.object(taskSpecRepoSchemaV0.shape)).min(1),
  agent: z.object(taskSpecAgentSchemaV2.shape),
});

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
 * The spec in the shape a runner at `minor` reads: below minor 6, `agent.repoSkills` is dropped;
 * below minor 5, minor 5's fields are dropped
 * (the review checkout, the tool sets, the commit paths, `automatic` and the CI round's context
 * files); below minor 3, minor 3's fields are dropped
 * (the memory section, the closing turn, the reasoning level with the model's controls and limits,
 * and each repo's git identity: core has folded the memory block into `agent.instructions` for
 * such a runner); below minor 2, minor 2's; below minor 1,
 * minor 1's. Core never dispatches a task that needs a minor to a runner below it
 * (`taskSpecNeedsMinor2`, `taskSpecNeedsMinor3`, `isTaskOfferable`), so nothing it needs is lost.
 */
export const encodeTaskSpecForMinor = (current: TaskSpec, minor: number): TaskSpec => {
  if (minor >= 6) {
    return current;
  }
  const v5 = specForMinor5(current);
  if (minor >= 5) {
    return v5;
  }
  const v3 = specForMinor4(v5);
  if (minor >= 3) {
    return v3;
  }
  const spec: TaskSpec = taskSpecStripV2.parse(v3);
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

/** The spec without minor 6's field: the agent section without `repoSkills`. */
const specForMinor5 = (current: TaskSpec): TaskSpec => {
  const agent: Record<string, unknown> = { ...current.agent };
  Reflect.deleteProperty(agent, "repoSkills");
  return taskSpecSchemaV5.parse({ ...current, agent });
};

/**
 * The spec without minor 5's fields: no review checkout, tool sets, commit paths or `automatic`,
 * and only the ticket's context files, without their folder.
 */
const specForMinor4 = (current: TaskSpec): TaskSpec => {
  const spec: Record<string, unknown> = { ...current };
  for (const key of minor5SpecKeys) {
    Reflect.deleteProperty(spec, key);
  }
  if (current.contextFiles !== undefined) {
    spec["contextFiles"] = current.contextFiles
      .filter((file) => (file.folder ?? "ticket") === "ticket")
      .map((file) => contextFileStripV4.parse(file));
  }
  return taskSpecSchemaV3.parse(spec);
};

/** The top-level fields minor 5 added to the spec. */
const minor5SpecKeys = ["review", "tools", "commitPaths", "automatic"] as const;

/** Minor 4's context file as a stripping object: parsing a current one drops its folder. */
const contextFileStripV4 = z.object(taskSpecContextFileSchemaV4.shape);

/** Whether a spec uses anything a runner below minor 2 can't do, so core offers it only to a minor-2 runner. */
export const taskSpecNeedsMinor2 = (spec: TaskSpec): boolean =>
  spec.firstTurnMode === "plan" ||
  (spec.checks?.length ?? 0) > 0 ||
  (spec.services?.length ?? 0) > 0 ||
  (spec.snapshot !== undefined && spec.snapshot !== null) ||
  (spec.agent.approvalRules?.length ?? 0) > 0 ||
  (spec.agent.skills?.length ?? 0) > 0 ||
  (spec.agent.mcpServers?.length ?? 0) > 0;

/**
 * Whether a spec uses anything a runner below minor 3 can't do: repos whose commits need
 * different bots (F-136), a repo on a branch of its own (F-066), or a reasoning level other than `default` (F-137, ADR 0066). Memory
 * needs no minor 3, since a minor-2 runner gets it folded into its instructions; the model's
 * controls and limits need none either, since a minor-2 runner keeps its fixed limits.
 */
export const taskSpecNeedsMinor3 = (spec: TaskSpec): boolean =>
  (spec.agent.effort ?? "default") !== "default" ||
  !taskSpecHasOneGitIdentity(spec) ||
  // A repo on its own branch (F-066): a runner below minor 3 would push it to the task's.
  spec.repos.some((repo) => repoBranchName(spec, repo) !== spec.branchName);

/** Whether a spec is a task kind or a feature a runner below minor 5 can't do (milestone 6). */
export const taskSpecNeedsMinor5 = (spec: TaskSpec): boolean => taskNeedsMinor5Reason(spec) !== null;

/**
 * Whether a spec keeps the repos' own skills from the agent (F-021, `agent.repoSkills`): a runner
 * below minor 6 can't, since it hands the agent a repo's `.opencode/skills` whatever the project says.
 */
export const taskSpecNeedsMinor6 = (spec: TaskSpec): boolean => spec.agent.repoSkills === false;

/**
 * Why a task can't be offered to a runner at a lower minor (ADR 0034): the kind or the feature,
 * in the dispatch note's words (`taskNotOfferableWords`).
 */
export const taskNotOfferableReasonSchema = z.enum([
  /** A project that keeps the repos' own skills from the agent (minor 6). */
  "repo-skills-off",
  /** A refine task: read-only, with `submit_draft` (minor 5). */
  "refine-task",
  /** A review task: read-only at its PRs' heads, with `submit_review` (minor 5). */
  "review-task",
  /** An onboarding task: `propose_environment` and its commit paths (minor 5). */
  "onboarding-task",
  /** An automatic round (CI, findings): its questions get the neutral reply (minor 5). */
  "automatic-round",
  /** A CI round's log tails (minor 5). */
  "ci-logs",
  /** A feature of minor 3: repos with their own bots or branches, or a reasoning level (milestone 4). */
  "needs-minor-3",
  /** A feature of minor 2: plan first, checks, services, snapshots, rules, skills or MCP servers (milestone 3). */
  "needs-minor-2",
]);
export type TaskNotOfferableReason = z.infer<typeof taskNotOfferableReasonSchema>;

/** The first reason a spec needs minor 5, or `null`. */
const taskNeedsMinor5Reason = (spec: TaskSpec): TaskNotOfferableReason | null => {
  switch (spec.kind) {
    case "refine":
      return "refine-task";
    case "review":
      return "review-task";
    case "code":
      break;
    default:
      return spec.kind satisfies never;
  }
  if ((spec.review ?? null) !== null) {
    return "review-task";
  }
  const tools = spec.tools ?? defaultOstraToolSets;
  if (tools.includes("draft")) {
    return "refine-task";
  }
  if (tools.includes("review")) {
    return "review-task";
  }
  if (tools.includes("environment") || (spec.commitPaths ?? null) !== null) {
    return "onboarding-task";
  }
  if (spec.automatic === true) {
    return "automatic-round";
  }
  if ((spec.contextFiles ?? []).some((file) => file.folder === "ci")) {
    return "ci-logs";
  }
  if (spec.tools !== undefined && !defaultOstraToolSets.every((tool) => tools.includes(tool))) {
    // Fewer tools than milestone 4's: a minor-4 runner would serve them all.
    return "onboarding-task";
  }
  return null;
};

/** The lowest runner minor a spec needs (ADR 0034). */
export const taskSpecMinMinor = (spec: TaskSpec): number => {
  if (taskSpecNeedsMinor6(spec)) {
    return 6;
  }
  if (taskSpecNeedsMinor5(spec)) {
    return 5;
  }
  if (taskSpecNeedsMinor3(spec)) {
    return 3;
  }
  return taskSpecNeedsMinor2(spec) ? 2 : 0;
};

export type TaskOffer =
  | { readonly offerable: true }
  | { readonly offerable: false; readonly reason: TaskNotOfferableReason; readonly minMinor: number };

/**
 * Whether core may offer a task with this spec to a runner at `peerMinor` (ADR 0034's one-minor
 * window, milestone 6): a minor-5 runner gets no task whose project keeps the repos' own skills
 * off, a minor-4 runner no refine, review or onboarding task and no automatic round, and the
 * dispatch note says why (`taskNotOfferableWords`).
 */
export const isTaskOfferable = (spec: TaskSpec, peerMinor: number): TaskOffer => {
  const minMinor = taskSpecMinMinor(spec);
  if (peerMinor >= minMinor) {
    return { offerable: true };
  }
  if (minMinor === 6) {
    return { offerable: false, reason: "repo-skills-off", minMinor };
  }
  if (minMinor === 5) {
    return { offerable: false, reason: taskNeedsMinor5Reason(spec) ?? "automatic-round", minMinor };
  }
  return { offerable: false, reason: minMinor === 3 ? "needs-minor-3" : "needs-minor-2", minMinor };
};

/** The dispatch note's words for a task a runner's minor can't take. Never task content. */
export const taskNotOfferableWords = (reason: TaskNotOfferableReason, minMinor: number): string => {
  const needs = `a runner at protocol 1.${String(minMinor)} or later: update the runner`;
  switch (reason) {
    case "repo-skills-off":
      return `A project with the repos' own skills off needs ${needs}.`;
    case "refine-task":
      return `A refine task needs ${needs}.`;
    case "review-task":
      return `A review task needs ${needs}.`;
    case "onboarding-task":
      return `An onboarding task needs ${needs}.`;
    case "automatic-round":
      return `An automatic round needs ${needs}.`;
    case "ci-logs":
      return `A CI round's logs need ${needs}.`;
    case "needs-minor-3":
    case "needs-minor-2":
      return `The task's agent profile needs ${needs}.`;
    default:
      return reason satisfies never;
  }
};

/** The spec endpoint's answer schema for a runner at `minor`. */
export const taskSpecResponseSchemaFor = (
  minor: number,
):
  | typeof taskSpecSchema
  | typeof taskSpecSchemaV5
  | typeof taskSpecSchemaV3
  | typeof taskSpecSchemaV2
  | typeof taskSpecSchemaV1
  | typeof taskSpecSchemaV0 => {
  if (minor >= 6) {
    return taskSpecSchema;
  }
  if (minor >= 5) {
    return taskSpecSchemaV5;
  }
  if (minor >= 3) {
    return taskSpecSchemaV3;
  }
  if (minor >= 2) {
    return taskSpecSchemaV2;
  }
  return minor >= 1 ? taskSpecSchemaV1 : taskSpecSchemaV0;
};
