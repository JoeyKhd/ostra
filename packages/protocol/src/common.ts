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

/** A runner label, used to pick a runner for a task (F-067). */
export const runnerLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "a label is lowercase letters, digits, dot, dash or underscore");
export type RunnerLabel = z.infer<typeof runnerLabelSchema>;

/** An `http:` or `https:` URL. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/** An environment variable's name, as POSIX shells accept it. */
export const envNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable name");
