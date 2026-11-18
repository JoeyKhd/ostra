import type { RepoSlug, TaskId } from './ids.ts';
import type { RefUpdateCommand } from './pkt-line.ts';

// What one task's git proxy lets through (ADR 0030, F-090): the task's repo
// only, the task's branches and its hidden ref only, never a delete, and
// fetches only on refine and review tasks.

export type ProxyMode = 'read-write' | 'read-only';

export type TaskGitPolicy = {
  readonly taskId: TaskId;
  readonly repo: RepoSlug;
  // Branch names without refs/heads/, e.g. "ostra/eng-123-fix-login".
  readonly branches: readonly string[];
  readonly mode: ProxyMode;
};

export type RefusalCode = 'delete' | 'ref-not-allowed' | 'read-only' | 'other-ref-refused';

export type RefVerdict =
  | { readonly ref: string; readonly allowed: true }
  | { readonly ref: string; readonly allowed: false; readonly code: RefusalCode };

export type PushVerdict =
  | { readonly allowed: true; readonly verdicts: readonly RefVerdict[] }
  | { readonly allowed: false; readonly verdicts: readonly RefVerdict[]; readonly codes: readonly RefusalCode[] };

export const hiddenRefFor = (taskId: TaskId): string => `refs/ostra/wip/${taskId}`;

export const allowedRefs = (policy: TaskGitPolicy): ReadonlySet<string> =>
  new Set([...policy.branches.map((b) => `refs/heads/${b}`), hiddenRefFor(policy.taskId)]);

export const sameRepo = (a: string, b: RepoSlug): boolean => a.toLowerCase() === b.toLowerCase();

const firstPass = (policy: TaskGitPolicy, command: RefUpdateCommand, allow: ReadonlySet<string>): RefVerdict => {
  if (policy.mode === 'read-only') return { ref: command.ref, allowed: false, code: 'read-only' };
  if (command.kind === 'delete') return { ref: command.ref, allowed: false, code: 'delete' };
  // Exact match only: no prefixes, no case folding.
  if (!allow.has(command.ref)) return { ref: command.ref, allowed: false, code: 'ref-not-allowed' };
  return { ref: command.ref, allowed: true };
};

// All or nothing: one refused ref refuses the whole push, so nothing at all
// is forwarded upstream.
export const decidePush = (policy: TaskGitPolicy, commands: readonly RefUpdateCommand[]): PushVerdict => {
  const allow = allowedRefs(policy);
  const first = commands.map((c) => firstPass(policy, c, allow));
  const codes = [...new Set(first.flatMap((v) => (v.allowed ? [] : [v.code])))];
  if (codes.length === 0) return { allowed: true, verdicts: first };
  const verdicts = first.map((v): RefVerdict => (v.allowed ? { ref: v.ref, allowed: false, code: 'other-ref-refused' } : v));
  return { allowed: false, verdicts, codes };
};

export const describeRefusal = (code: RefusalCode): string => {
  switch (code) {
    case 'delete':
      return 'ostra: deleting a ref is not allowed';
    case 'ref-not-allowed':
      return "ostra: only the task's branches and its hidden ref can be pushed";
    case 'read-only':
      return 'ostra: this task can fetch but not push';
    case 'other-ref-refused':
      return 'ostra: not pushed, another ref in this push was refused';
    default:
      code satisfies never;
      return 'ostra: refused';
  }
};
