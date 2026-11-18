import { z } from "zod";

import {
  agentProfileIdSchema,
  modelIdSchema,
  organizationIdSchema,
  projectIdSchema,
  providerIdSchema,
  repoIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "../ids.ts";
import {
  apiFormatSchema,
  branchNameSchema,
  envNameSchema,
  leaseEpochSchema,
  repoFullNameSchema,
  taskKindSchema,
} from "../common.ts";

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

export const taskSpecSchema = z
  .strictObject({
    taskId: taskIdSchema,
    sessionId: sessionIdSchema,
    projectId: projectIdSchema,
    organizationId: organizationIdSchema,
    kind: taskKindSchema,
    title: z.string().min(1).max(512),
    /** The member's prompt, or the ticket's text for a ticket task. Never logged. */
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
    limits: z.strictObject({
      /** The longest a turn may run before the runner cancels it. */
      turnMaxMinutes: z.number().int().positive().max(24 * 60),
    }),
  })
  .describe("The task spec a dispatch hands the runner. It holds no secret.");
export type TaskSpec = z.infer<typeof taskSpecSchema>;
