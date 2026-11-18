import type { GitProxy } from '../git-proxy.ts';
import type { RepoSlug } from '../ids.ts';
import type { TaskGitPolicy } from '../policy.ts';
import type { StubStats } from '../upstream-stub.ts';

// Where the git scenarios run: the local stand-in for GitHub, or github.com
// itself. The scenarios are the same code for both.

export type TargetLabel = 'local stand-in' | 'GitHub';

// One entry of GitHub's repository activity log (pushes, force pushes,
// branch creations and deletions).
export type PushActivity = { readonly id: number; readonly ref: string; readonly after: string; readonly at: string; readonly type: string };

export type ExpiringTokens = {
  readonly getToken: () => Promise<string>;
  // How many tokens the provider has minted so far.
  readonly mints: () => number;
};

export type GitTarget = {
  readonly label: TargetLabel;
  readonly repo: RepoSlug;
  readonly otherRepo: RepoSlug;
  readonly defaultBranch: string;
  // What the agent's remotes point at; insteadOf sends it to the proxy.
  readonly publicBase: string;
  // Every credential the agent must never see.
  readonly secrets: () => readonly string[];
  // A proxy for the policy, with the target's own token provider unless one
  // is given.
  readonly startProxy: (policy: TaskGitPolicy, getToken?: () => Promise<string>) => Promise<GitProxy>;
  // A provider whose tokens look to it as if they expire within validForMs
  // (plus its five-minute margin), so it re-mints for real that soon.
  readonly expiringTokens: (validForMs: number) => ExpiringTokens;
  // A token already past its expiry, to show the upstream refuses one. Only
  // the local stand-in can make one.
  readonly expiredToken: (() => string) | null;
  // Reads a ref on the upstream without going through the proxy. null means
  // the ref is absent; any other failure throws.
  readonly refOnUpstream: (repo: RepoSlug, ref: string) => Promise<string | null>;
  // Every request the upstream saw, when it can tell (the local stand-in can;
  // github.com can't, so there its activity log is read instead).
  readonly upstreamStats: (() => Promise<StubStats>) | null;
  // GitHub's activity log for a repo, newest first. null on the stand-in.
  readonly pushActivity: ((repo: RepoSlug) => Promise<readonly PushActivity[]>) | null;
  // The upstream answers an LFS batch for LFS_REDIRECT_PROBE_REF with actions
  // that point elsewhere (the stand-in only).
  readonly lfsRedirectProbe: boolean;
  // For a baseline only, outside the agent's world: the upstream URL and the
  // environment that authenticates straight to it, without the proxy.
  readonly direct: (() => { readonly url: string; readonly env: Readonly<Record<string, string>> }) | null;
  // Large files per push must stay under GitHub's 100 MB file limit.
  readonly largeFileMb: number;
  // Deletes the refs; returns those it could not delete.
  readonly cleanupRefs: (refs: readonly string[]) => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
};
