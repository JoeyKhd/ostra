import type { RepoFullName, TaskId } from "@ostra/protocol";
import type { RefUpdateCommand } from "./pkt-line.ts";

// What one task's git proxy lets through (ADR 0030, F-090): the task's own repos only, the task's
// branch and its hidden ref only, never a delete, and nothing pushed at all on a read-only task
// (refine and review, ADR 0028). Ported from spikes/github-app-and-git-proxy/src/policy.ts.

export type ProxyMode = "read-write" | "read-only";

export type TaskGitPolicy = {
  readonly taskId: TaskId;
  /** The task's branch, without `refs/heads/`: the repos' own, except one that has a branch of its own (F-066). */
  readonly branch: string;
  readonly mode: ProxyMode;
};

export type RefusalCode = "delete" | "ref-not-allowed" | "read-only" | "other-ref-refused" | "other-repo";

export type RefVerdict =
  | { readonly ref: string; readonly allowed: true }
  | { readonly ref: string; readonly allowed: false; readonly code: RefusalCode };

export type PushVerdict =
  | { readonly allowed: true; readonly verdicts: readonly RefVerdict[] }
  | { readonly allowed: false; readonly verdicts: readonly RefVerdict[]; readonly codes: readonly RefusalCode[] };

/** The task's hidden ref, which holds unfinished work on stop and crash (ADR 0039). */
export const hiddenRefFor = (taskId: TaskId): string => `refs/ostra/wip/${taskId}`;

/** `branch` is the repo's own when it has one (F-066); the policy's is the task's. */
export const allowedRefs = (policy: TaskGitPolicy, branch: string = policy.branch): ReadonlySet<string> =>
  new Set([`refs/heads/${branch}`, hiddenRefFor(policy.taskId)]);

/** GitHub's repo names are case-insensitive. */
export const sameRepo = (a: string, b: RepoFullName): boolean => a.toLowerCase() === b.toLowerCase();

const firstPass = (policy: TaskGitPolicy, command: RefUpdateCommand, allow: ReadonlySet<string>): RefVerdict => {
  if (policy.mode === "read-only") {
    return { ref: command.ref, allowed: false, code: "read-only" };
  }
  if (command.kind === "delete") {
    return { ref: command.ref, allowed: false, code: "delete" };
  }
  // Exact match only: no prefixes, no case folding.
  if (!allow.has(command.ref)) {
    return { ref: command.ref, allowed: false, code: "ref-not-allowed" };
  }
  return { ref: command.ref, allowed: true };
};

/** All or nothing: one refused ref refuses the whole push, so nothing at all goes upstream. */
export const decidePush = (policy: TaskGitPolicy, commands: readonly RefUpdateCommand[], branch: string = policy.branch): PushVerdict => {
  const allow = allowedRefs(policy, branch);
  const first = commands.map((command) => firstPass(policy, command, allow));
  const codes = [...new Set(first.flatMap((verdict) => (verdict.allowed ? [] : [verdict.code])))];
  if (codes.length === 0) {
    return { allowed: true, verdicts: first };
  }
  const verdicts = first.map(
    (verdict): RefVerdict => (verdict.allowed ? { ref: verdict.ref, allowed: false, code: "other-ref-refused" } : verdict),
  );
  return { allowed: false, verdicts, codes };
};

/** The reason git prints after `! [remote rejected] <ref>`, word for word. */
export const describeRefusal = (code: RefusalCode): string => {
  switch (code) {
    case "delete":
      return "ostra: deleting a ref is not allowed";
    case "ref-not-allowed":
      return "ostra: only the task's branch and its hidden ref can be pushed";
    case "read-only":
      return "ostra: this task can fetch but not push";
    case "other-ref-refused":
      return "ostra: not pushed, another ref in this push was refused";
    case "other-repo":
      return "ostra: this task's proxy serves only the task's own repos";
    default:
      return code satisfies never;
  }
};
