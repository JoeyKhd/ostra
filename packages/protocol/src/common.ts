import { z } from "zod";

// Small shared vocabularies that several contracts use. Each is a closed set ostra owns.

/** A whole number of milliseconds since the Unix epoch. */
export const epochMsSchema = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof epochMsSchema>;

/**
 * A task's lease epoch (ADR 0034, F-045). Each dispatch raises it by one, and the server refuses
 * every write, result and token request that carries an older one.
 */
export const leaseEpochSchema = z.number().int().positive();
export type LeaseEpoch = z.infer<typeof leaseEpochSchema>;

/** The number a peer gives an event within its session, from 1, gap-free (ADR 0035). */
export const sessionSeqSchema = z.number().int().positive();
export type SessionSeq = z.infer<typeof sessionSeqSchema>;

/** The number the server gives an event within its task, from 1: the browser's cursor (ADR 0035). */
export const taskSeqSchema = z.number().int().positive();
export type TaskSeq = z.infer<typeof taskSeqSchema>;

/** The number of a command within its runner, from 1, gap-free and in commit order (ADR 0034). */
export const commandSeqSchema = z.number().int().positive();
export type CommandSeq = z.infer<typeof commandSeqSchema>;

/** A task's kind (ADR 0028). It fixes what the box may do and how the task ends. */
export const taskKindSchema = z.enum(["refine", "code", "review"]);
export type TaskKind = z.infer<typeof taskKindSchema>;

/** Where a task came from (F-097). Prompt tasks have no ticket. */
export const taskSourceSchema = z.enum(["prompt", "ticket"]);
export type TaskSource = z.infer<typeof taskSourceSchema>;

/** How a runner gives a task its place to run (ADR 0029). */
export const executorKindSchema = z.enum(["docker", "host", "kubernetes"]);
export type ExecutorKind = z.infer<typeof executorKindSchema>;

/** A pool runner serves its pool's projects; a personal runner serves one member (ADR 0029). */
export const runnerKindSchema = z.enum(["pool", "personal"]);
export type RunnerKind = z.infer<typeof runnerKindSchema>;

/** The two API formats a model provider can speak (ADR 0033). */
export const apiFormatSchema = z.enum(["openai-compatible", "anthropic-messages"]);
export type ApiFormat = z.infer<typeof apiFormatSchema>;

/** How a model provider's token goes on a request: `Authorization: Bearer` or `x-api-key`. */
export const authSchemeSchema = z.enum(["bearer", "x-api-key"]);
export type AuthScheme = z.infer<typeof authSchemeSchema>;

/** A full git object name: 40 hex characters (SHA-1) or 64 (SHA-256). */
export const gitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a full git SHA");
export type GitSha = z.infer<typeof gitShaSchema>;

/** A repo's `owner/name` on its code host. */
export const repoFullNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "an owner/name pair");
export type RepoFullName = z.infer<typeof repoFullNameSchema>;

/** A git branch name, without `refs/heads/`. Checked loosely here; the git proxy checks it fully. */
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!\/)(?!.*\/\/)(?!.*\.\.)[^\s~^:?*[\\]+(?<![/.])$/, "a git branch name");
export type BranchName = z.infer<typeof branchNameSchema>;

/**
 * A runner label, used to pick a runner for a task (F-067, F-069). Minor 4 (milestone 5) also
 * allows `:` and `/`, for `tier:fast` and the built-in `executor:`, `os:` and `arch:` labels; a
 * label is sent to a peer below minor 4 only when it matches `legacyRunnerLabelPattern`.
 */
export const runnerLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, "a label is lowercase letters, digits, dot, dash, underscore, colon or slash");
export type RunnerLabel = z.infer<typeof runnerLabelSchema>;

/** What a label had to match below minor 4: no `:` and no `/`. */
export const legacyRunnerLabelPattern = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The prefixes of the built-in labels a runner gets from what it reports (ADR 0059): its executor,
 * its system and its architecture. A runner can't set one itself (`OSTRA_RUNNER_LABELS`), and a
 * profile may ask for one.
 */
export const reservedLabelPrefixes = ["executor:", "os:", "arch:"] as const;
export type ReservedLabelPrefix = (typeof reservedLabelPrefixes)[number];

/** Whether a label is one of the built-in ones, which only ostra sets. */
export const isReservedLabel = (label: string): boolean =>
  reservedLabelPrefixes.some((prefix) => label.startsWith(prefix));

/** The names of an organization's three box sizes (F-095, ADR 0059). */
export const boxSizeNameSchema = z.enum(["small", "medium", "large"]);
export type BoxSizeName = z.infer<typeof boxSizeNameSchema>;

/** An `http:` or `https:` URL. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/** An environment variable's name, as POSIX shells accept it. */
export const envNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable name");

/**
 * A box's states (domain-model.md, "A box's lifecycle"). A `host` worktree goes through the same
 * ones, so a task behaves the same on every executor (ADR 0029).
 */
export const boxStateSchema = z.enum(["creating", "preparing", "ready", "idle", "stopped", "released", "failed"]);
export type BoxState = z.infer<typeof boxStateSchema>;

// ---------- milestone 3 (protocol minor 2) ----------

/** An OCI image digest: `sha256:` and 64 lower-case hex digits (F-051). */
export const imageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "an image digest, sha256:<hex>");

/** A service's name, which is also its host name on the box's network (F-094). */
export const serviceNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lower-case letters, digits and hyphens, as a host name");
