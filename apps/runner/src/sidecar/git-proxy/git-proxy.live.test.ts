import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startGitProxy } from "./git-proxy.ts";

// The live run against the test repo (`ostra-test/test1`), gated on `github.env` and
// `github-test.env` (`set -a; . ~/.config/ostra-dev/<file>; set +a`). It clones through the proxy
// with a one-repo App token, pushes a test branch and its hidden ref, is refused a push to `main`,
// then deletes its test refs. It prints no token, and its messages name none.

const env = z
  .object({
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
    GITHUB_APP_INSTALLATION_ID: z.string().min(1),
    GITHUB_TEST_ORG: z.string().min(1),
    GITHUB_TEST_REPO: z.string().min(1),
  })
  .safeParse(process.env);

type GitRun = { readonly code: number; readonly stderr: string };

describe.skipIf(!env.success)("the git proxy, live against the test repo", () => {
  it("clones, pushes a branch and its hidden ref, refuses main, then cleans up", async () => {
    if (!env.success) {
      return;
    }
    const config = env.data;
    const fullName = repoFullNameSchema.parse(`${config.GITHUB_TEST_ORG}/${config.GITHUB_TEST_REPO}`);
    const adapter = new GitHubAdapter();
    const access = {
      app: { appId: config.GITHUB_APP_ID, privateKey: await readFile(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8") },
      installationId: config.GITHUB_APP_INSTALLATION_ID,
      repo: fullName,
    };
    const minted = await adapter.mintRepoToken(access, { contents: "write", metadata: "read" });
    expect(minted.ok, minted.ok ? "" : `minting failed: ${minted.error.code}`).toBe(true);
    if (!minted.ok) {
      return;
    }
    const token = minted.value.token;
    const suffix = randomBytes(4).toString("hex");
    const taskId = taskIdSchema.parse(`live-${suffix}`);
    const branch = `ostra/live-${suffix}-git-proxy`;
    const hiddenRef = `refs/ostra/wip/${taskId}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-git-proxy-live-"));
    const globalConfig = path.join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = ostra live test\n\temail = live@example.test\n[credential]\n\thelper =\n");
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const outputs: string[] = [];
    const runGit = (args: readonly string[], cwd: string): Promise<GitRun> =>
      new Promise((resolve) => {
        execFile("git", [...args], { cwd, env: gitEnv, windowsHide: true }, (error, stdout, stderr) => {
          outputs.push(stdout, stderr);
          resolve({ code: error === null ? 0 : 1, stderr });
        });
      });
    const logs: string[] = [];
    const proxy = await startGitProxy({
      taskId,
      branch,
      mode: "read-write",
      repos: [
        {
          repoId: repoIdSchema.parse("live-repo"),
          fullName,
          cloneUrl: `https://github.com/${fullName}.git`,
          lfsActionHosts: adapter.capabilities.lfsActionHosts,
          token: () => Promise.resolve(token),
        },
      ],
      logger: createLogger((record) => logs.push(JSON.stringify(record))),
      listenHost: "127.0.0.1",
    });
    const removeRef = async (ref: string): Promise<void> => {
      await fetch(`https://api.github.com/repos/${fullName}/git/${ref}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "ostra-runner-live-test" },
      });
    };
    try {
      const dir = path.join(root, "work");
      const cloned = await runGit(["clone", "--quiet", proxy.urlFor(fullName), dir], root);
      expect(cloned.code, "clone through the proxy").toBe(0);
      await runGit(["checkout", "--quiet", "-b", branch], dir);
      await writeFile(path.join(dir, `ostra-live-${suffix}.txt`), "a live git proxy check; deleted after the test\n");
      await runGit(["add", "--all"], dir);
      expect((await runGit(["commit", "--quiet", "-m", "ostra: live git proxy check"], dir)).code).toBe(0);
      const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`, `HEAD:${hiddenRef}`], dir);
      expect(pushed.code, "push of the task's branch and hidden ref").toBe(0);
      const refused = await runGit(["push", "origin", "HEAD:main"], dir);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("(ostra: only the task's branch and its hidden ref can be pushed)");
      expect(proxy.stats().upstreamRequests["receive-pack"]).toBe(1);
    } finally {
      await removeRef(`refs/heads/${branch}`);
      await removeRef(hiddenRef);
      await proxy.close();
      await rm(root, { recursive: true, force: true });
    }
    const everything = [...outputs, ...logs].join("\n");
    expect(everything.includes(token), "the token is in no git output or log line").toBe(false);
  }, 120_000);
});
