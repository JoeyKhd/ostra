// The GitHub side of the hidden-ref check, on the test GitHub App: a JWT
// signed with node:crypto, an installation token for the one test repo, and
// a few REST calls with fetch. No SDK, so no new dependency.
//
// Tokens live in memory. git gets its token through GIT_CONFIG_* environment
// variables (an extra Authorization header), never in its arguments, so it
// never shows in a process list. Nothing here logs a token.

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { GitHubAppIdSchema, InstallationIdSchema, type GitHubAppId, type InstallationId } from "./ids.ts";

export type GitHubApp = {
  readonly appId: GitHubAppId;
  readonly privateKey: string;
  readonly installationId: InstallationId | undefined;
  readonly org: string;
  readonly repo: string;
  readonly apiUrl: string;
  readonly webUrl: string;
};

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

const appJwt = (app: GitHubApp): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(app.privateKey).toString("base64url")}`;
};

const api = async (app: GitHubApp, auth: string, method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${app.apiUrl}${route}`, {
    method,
    headers: {
      authorization: auth,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ostra-spike",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};

const installationSchema = z.looseObject({ id: z.number().int() });
const tokenSchema = z.looseObject({ token: z.string().min(1), expires_at: z.string() });

export const loadGitHubApp = async (env: Readonly<Record<string, string | undefined>>): Promise<GitHubApp | undefined> => {
  const appId = env["GITHUB_APP_ID"];
  const keyPath = env["GITHUB_APP_PRIVATE_KEY_PATH"];
  const org = env["GITHUB_TEST_ORG"];
  const repo = env["GITHUB_TEST_REPO"];
  if (appId === undefined || appId === "" || keyPath === undefined || keyPath === "" || org === undefined || org === "" || repo === undefined || repo === "") return undefined;
  const installationId = env["GITHUB_APP_INSTALLATION_ID"];
  // Validated here, at the boundary; an error names the variable, never its value.
  const parsedAppId = GitHubAppIdSchema.safeParse(appId);
  if (!parsedAppId.success) throw new Error("GITHUB_APP_ID is not a numeric App ID");
  const parsedInstallation = installationId === undefined || installationId === "" ? undefined : InstallationIdSchema.safeParse(installationId);
  if (parsedInstallation?.success === false) throw new Error("GITHUB_APP_INSTALLATION_ID is not a numeric installation ID");
  return {
    appId: parsedAppId.data,
    privateKey: await readFile(keyPath, "utf8"),
    installationId: parsedInstallation?.data,
    org,
    repo,
    apiUrl: (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, ""),
    webUrl: (env["GITHUB_WEB_URL"] ?? "https://github.com").replace(/\/+$/, ""),
  };
};

export type RepoToken = { readonly token: string };

/** An installation token for the test repo only, with the permissions the check needs. */
export const mintRepoToken = async (app: GitHubApp, permissions: Readonly<Record<string, "read" | "write">>): Promise<RepoToken> => {
  const jwt = `Bearer ${appJwt(app)}`;
  let installationId = app.installationId;
  if (installationId === undefined) {
    const found = await api(app, jwt, "GET", `/orgs/${encodeURIComponent(app.org)}/installation`);
    if (found.status !== 200) throw new Error(`GitHub: no installation for the test org (HTTP ${String(found.status)})`);
    installationId = InstallationIdSchema.parse(String(installationSchema.parse(found.json).id));
  }
  const minted = await api(app, jwt, "POST", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { repositories: [app.repo], permissions });
  if (minted.status !== 201) throw new Error(`GitHub: could not mint a token (HTTP ${String(minted.status)})`);
  return { token: tokenSchema.parse(minted.json).token };
};

export const repoUrl = (app: GitHubApp): string => `${app.webUrl}/${app.org}/${app.repo}.git`;

/** Environment that gives git the token as an extra header, for this one remote's host. */
export const gitAuthEnv = (token: RepoToken): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token.token}`).toString("base64")}`,
});

const runsSchema = z.looseObject({ total_count: z.number().int(), workflow_runs: z.array(z.looseObject({ id: z.number(), event: z.string().optional(), head_branch: z.string().nullish() })) });
const suitesSchema = z.looseObject({ total_count: z.number().int() });
const workflowsSchema = z.looseObject({ total_count: z.number().int(), workflows: z.array(z.looseObject({ path: z.string(), state: z.string() })) });
const refSchema = z.looseObject({ ref: z.string(), object: z.looseObject({ sha: z.string() }) });
const repoSchema = z.looseObject({ default_branch: z.string() });

export type CiActivity = {
  readonly workflowRuns: number;
  /** Each run's head branch (`""` when GitHub gave none). */
  readonly runBranches: readonly string[];
  readonly checkSuites: number;
  readonly checkSuitesReadable: boolean;
};

/** Workflow runs and check suites GitHub created for one commit. */
export const ciActivityFor = async (app: GitHubApp, token: RepoToken, sha: string): Promise<CiActivity> => {
  const auth = `Bearer ${token.token}`;
  const base = `/repos/${encodeURIComponent(app.org)}/${encodeURIComponent(app.repo)}`;
  const runs = await api(app, auth, "GET", `${base}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
  if (runs.status !== 200) throw new Error(`GitHub: listing workflow runs failed (HTTP ${String(runs.status)})`);
  const suites = await api(app, auth, "GET", `${base}/commits/${encodeURIComponent(sha)}/check-suites`);
  const parsedRuns = runsSchema.parse(runs.json);
  return {
    workflowRuns: parsedRuns.total_count,
    runBranches: parsedRuns.workflow_runs.map((r) => r.head_branch ?? ""),
    checkSuites: suites.status === 200 ? suitesSchema.parse(suites.json).total_count : 0,
    checkSuitesReadable: suites.status === 200,
  };
};

export const activeWorkflows = async (app: GitHubApp, token: RepoToken): Promise<readonly string[]> => {
  const result = await api(app, `Bearer ${token.token}`, "GET", `/repos/${encodeURIComponent(app.org)}/${encodeURIComponent(app.repo)}/actions/workflows`);
  if (result.status !== 200) throw new Error(`GitHub: listing workflows failed (HTTP ${String(result.status)})`);
  return workflowsSchema.parse(result.json).workflows.filter((w) => w.state === "active").map((w) => w.path);
};

/** The SHA a ref points at on GitHub, or undefined. `ref` is without the `refs/` prefix. */
export const remoteRef = async (app: GitHubApp, token: RepoToken, ref: string): Promise<string | undefined> => {
  const result = await api(app, `Bearer ${token.token}`, "GET", `/repos/${encodeURIComponent(app.org)}/${encodeURIComponent(app.repo)}/git/ref/${ref.split("/").map(encodeURIComponent).join("/")}`);
  if (result.status === 404) return undefined;
  if (result.status !== 200) throw new Error(`GitHub: reading a ref failed (HTTP ${String(result.status)})`);
  return refSchema.parse(result.json).object.sha;
};

export const deleteRemoteRef = async (app: GitHubApp, token: RepoToken, ref: string): Promise<number> =>
  (await api(app, `Bearer ${token.token}`, "DELETE", `/repos/${encodeURIComponent(app.org)}/${encodeURIComponent(app.repo)}/git/refs/${ref.split("/").map(encodeURIComponent).join("/")}`)).status;

export const defaultBranch = async (app: GitHubApp, token: RepoToken): Promise<string> => {
  const result = await api(app, `Bearer ${token.token}`, "GET", `/repos/${encodeURIComponent(app.org)}/${encodeURIComponent(app.repo)}`);
  if (result.status !== 200) throw new Error(`GitHub: reading the repo failed (HTTP ${String(result.status)})`);
  return repoSchema.parse(result.json).default_branch;
};
