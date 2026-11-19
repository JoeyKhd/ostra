import { readFile } from "node:fs/promises";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

import type { DemoSettings } from "./settings.ts";

// The demo's view of GitHub: as the test App's installation on the test org, for the checks after
// the run and the clean-up. It touches the demo's repo only.

const installationsSchema = z.array(z.looseObject({ id: z.number(), account: z.looseObject({ login: z.string() }).nullable() }));

const appSchema = z.looseObject({ slug: z.string().min(1) });

export type DemoGitHub = {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  /** The App's bot as GitHub names it (`<slug>[bot]`): the author of every PR and commit ostra makes. */
  readonly botLogin: string;
};

/** How far this machine's clock may be from GitHub's before the demo blames the clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const refusalSchema = z.looseObject({ status: z.literal(401), response: z.looseObject({ headers: z.looseObject({ date: z.string() }) }) });

/**
 * An App signs in with a JWT that expires 10 minutes after this machine's clock says it was made. A
 * clock more than about 9 minutes behind GitHub's gets "Bad credentials" on every App call, which
 * octokit's own skew correction doesn't recognise. Judged from the refusal's `Date` header: the
 * cause, named, when the clocks are further apart than `MAX_CLOCK_SKEW_MS`, otherwise `null`.
 */
export const clockSkewRefusal = (error: unknown, nowMs: number): string | null => {
  const refusal = refusalSchema.safeParse(error);
  if (!refusal.success) return null;
  const skewMs = Date.parse(refusal.data.response.headers.date) - nowMs;
  if (Number.isNaN(skewMs) || Math.abs(skewMs) <= MAX_CLOCK_SKEW_MS) return null;
  const minutes = String(Math.round(Math.abs(skewMs) / 60_000));
  return (
    `GitHub refused the App's JWT: this machine's clock is ${minutes} minutes ${skewMs > 0 ? "behind" : "ahead of"} GitHub's (its Date header). ` +
    "An App's JWT lives 10 minutes, so ostra's GitHub App can't sign in either until the clock is right (on Windows, start the Windows Time service and resync)"
  );
};

export const demoGitHub = async (settings: DemoSettings): Promise<DemoGitHub> => {
  const privateKey = await readFile(settings.githubPrivateKeyPath, "utf8");
  const asApp = new Octokit({ authStrategy: createAppAuth, auth: { appId: settings.githubAppId, privateKey } });
  const authenticated = await asApp.rest.apps.getAuthenticated().catch((error: unknown): never => {
    const skew = clockSkewRefusal(error, Date.now());
    throw skew === null ? error : new Error(skew);
  });
  const app = appSchema.parse(authenticated.data);
  const installations = installationsSchema.parse((await asApp.rest.apps.listInstallations()).data);
  const installation = installations.find((item) => item.account?.login === settings.githubOrg);
  if (installation === undefined) throw new Error(`the App isn't installed on ${settings.githubOrg}`);
  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: settings.githubAppId, privateKey, installationId: installation.id } });
  return { octokit, owner: settings.githubOrg, repo: settings.githubRepo, botLogin: `${app.slug}[bot]` };
};

/** The demo's refs: `ostra/*` branches and `refs/ostra/wip/*` hidden refs. */
export const listDemoRefs = async (github: DemoGitHub): Promise<readonly string[]> => {
  const refs: string[] = [];
  for (const prefix of ["heads/ostra/", "ostra/wip/"]) {
    const response = await github.octokit.rest.git.listMatchingRefs({ owner: github.owner, repo: github.repo, ref: prefix });
    refs.push(...response.data.map((ref) => ref.ref));
  }
  return refs;
};

/** Closes the demo's open PRs except `keep`, and deletes the refs of every PR it closes or that was never opened. */
export const cleanUp = async (github: DemoGitHub, keep: ReadonlySet<number> = new Set()): Promise<{ readonly closed: number; readonly deleted: number }> => {
  const { owner, repo } = github;
  const open = await github.octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 100 });
  const kept = new Set<string>();
  let closed = 0;
  for (const pull of open.data) {
    if (!pull.head.ref.startsWith("ostra/")) continue;
    if (keep.has(pull.number)) {
      kept.add(`refs/heads/${pull.head.ref}`);
      continue;
    }
    await github.octokit.rest.pulls.update({ owner, repo, pull_number: pull.number, state: "closed" });
    closed += 1;
  }
  let deleted = 0;
  for (const ref of await listDemoRefs(github)) {
    if (kept.has(ref)) continue;
    // A kept PR's hidden ref holds the same task: keep it with its branch.
    // Its branch is named from the task ID's last 8 hex digits (spec section 11, item 10).
    const taskId = /^refs\/ostra\/wip\/(.+)$/.exec(ref)?.[1];
    const branchPart = taskId?.replaceAll("-", "").slice(-8);
    if (branchPart !== undefined && [...kept].some((branch) => branch.startsWith(`refs/heads/ostra/${branchPart}-`))) continue;
    await github.octokit.rest.git.deleteRef({ owner, repo, ref: ref.replace(/^refs\//, "") });
    deleted += 1;
  }
  return { closed, deleted };
};
