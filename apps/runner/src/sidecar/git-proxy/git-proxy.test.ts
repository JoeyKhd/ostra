import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LFS_HOSTILE_PROBE_REF, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { MAX_DISCARD_BYTES, startGitProxy } from "./git-proxy.ts";
import type { GitProxy } from "./git-proxy.ts";
import { LFS_ACTION_REFUSED_MESSAGE } from "./lfs.ts";
import { encodePkt, FLUSH_PKT } from "./pkt-line.ts";
import type { ProxyMode } from "./policy.ts";

// Ticket 18's "done when": stock git (and git-lfs) through the proxy, against the upstream stub.

const taskId = taskIdSchema.parse("0196f1a0-task-git-proxy");
const repo = repoFullNameSchema.parse("ostra-test/test1");
const otherRepo = repoFullNameSchema.parse("ostra-test/test2");
const branch = "ostra/0196f1a0-add-a-file";
const hiddenRef = `refs/ostra/wip/${taskId}`;

let root = "";
let upstream: GitUpstream;
let token = "";
let gitEnv: NodeJS.ProcessEnv = {};
const outputs: string[] = [];
const logs: LogRecord[] = [];
const proxies: GitProxy[] = [];

type GitRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

const runGit = (args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<GitRun> =>
  new Promise((resolve) => {
    execFile("git", [...args], { cwd, env: { ...gitEnv, ...extraEnv }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });

const startProxy = async (mode: ProxyMode = "read-write", maxDiscardBytes?: number): Promise<GitProxy> => {
  const proxy = await startGitProxy({
    taskId,
    branch,
    mode,
    ...(maxDiscardBytes === undefined ? {} : { maxDiscardBytes }),
    repos: [
      {
        repoId: repoIdSchema.parse("repo-1"),
        fullName: repo,
        cloneUrl: upstream.cloneUrl(repo),
        lfsActionHosts: [],
        token: () => Promise.resolve(token),
      },
    ],
    logger: createLogger((record) => logs.push(record)),
    listenHost: "127.0.0.1",
  });
  proxies.push(proxy);
  return proxy;
};

const commitFile = async (dir: string, file: string, content: string): Promise<void> => {
  await writeFile(path.join(dir, file), content);
  await runGit(["add", "--all"], dir);
  const committed = await runGit(["commit", "--quiet", "-m", `add ${file}`], dir);
  expect(committed.code, committed.stderr).toBe(0);
};

const clone = async (url: string, name: string): Promise<{ readonly dir: string; readonly run: GitRun }> => {
  const dir = path.join(root, name);
  const run = await runGit(["clone", "--quiet", url, dir], root);
  return { dir, run };
};

const receivePacks = (fullName: string): number =>
  upstream.requests.filter((request) => request.repo === fullName && request.endpoint === "git-receive-pack").length;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-git-proxy-"));
  const home = path.join(root, "home");
  const globalConfig = path.join(root, "gitconfig");
  await writeFile(
    globalConfig,
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.test",
      "[init]",
      "\tdefaultBranch = main",
      "[credential]",
      "\thelper =",
      '[filter "lfs"]',
      "\tclean = git-lfs clean -- %f",
      "\tsmudge = git-lfs smudge -- %f",
      "\tprocess = git-lfs filter-process",
      "\trequired = true",
    ].join("\n"),
  );
  gitEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  upstream = await startGitUpstream(path.join(root, "upstream"));
  await upstream.createRepo(repo);
  await upstream.createRepo(otherRepo);
  token = `ghs_${randomBytes(30).toString("base64url")}`;
  upstream.tokens.set(token, Date.now() + 3_600_000);
}, 60_000);

afterAll(async () => {
  for (const proxy of proxies) {
    await proxy.close();
  }
  await upstream.close();
  // On Windows a git process can hold the folder for a moment after it exits.
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe("the git proxy with stock git", () => {
  it("F-090: clones, fetches and pushes the task's branch and its hidden ref, with the repo's token added upstream", async () => {
    const proxy = await startProxy();
    const { dir, run } = await clone(proxy.urlFor(repo), "work");
    expect(run.code, run.stderr).toBe(0);
    expect(await readFile(path.join(dir, "README.md"), "utf8")).toContain("ostra-test/test1");
    expect((await runGit(["fetch", "--quiet", "origin"], dir)).code).toBe(0);

    await runGit(["checkout", "--quiet", "-b", branch], dir);
    await commitFile(dir, "feature.txt", "a change\n");
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`, `HEAD:${hiddenRef}`], dir);
    expect(pushed.code, pushed.stderr).toBe(0);
    const head = (await runGit(["rev-parse", "HEAD"], dir)).stdout.trim();
    expect(await upstream.refSha(repo, `refs/heads/${branch}`)).toBe(head);
    expect(await upstream.refSha(repo, hiddenRef)).toBe(head);
  }, 60_000);

  it("F-090: refuses a push to the default branch in git's words, forwarding nothing", async () => {
    const proxy = await startProxy();
    const { dir } = await clone(proxy.urlFor(repo), "to-main");
    await commitFile(dir, "sneaky.txt", "not allowed\n");
    const mainBefore = await upstream.refSha(repo, "refs/heads/main");
    const before = receivePacks(repo);
    const pushed = await runGit(["push", "origin", "HEAD:main"], dir);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("! [remote rejected] HEAD -> main (ostra: only the task's branch and its hidden ref can be pushed)");
    expect(receivePacks(repo)).toBe(before);
    expect(await upstream.refSha(repo, "refs/heads/main")).toBe(mainBefore);
  }, 60_000);

  it("F-090: refuses a delete, even of the task's own branch", async () => {
    const proxy = await startProxy();
    const { dir } = await clone(proxy.urlFor(repo), "delete");
    const before = receivePacks(repo);
    const deleted = await runGit(["push", "origin", "--delete", branch], dir);
    expect(deleted.code).not.toBe(0);
    expect(deleted.stderr).toContain(`! [remote rejected] ${branch} (ostra: deleting a ref is not allowed)`);
    expect(receivePacks(repo)).toBe(before);
    expect(await upstream.refSha(repo, `refs/heads/${branch}`)).not.toBeNull();
  }, 60_000);

  it("F-090: refuses a push to another repo in git's words, and no request for it reaches the code host", async () => {
    const proxy = await startProxy();
    const { dir } = await clone(proxy.urlFor(repo), "other-repo");
    await commitFile(dir, "elsewhere.txt", "x\n");
    const pushed = await runGit(["push", proxy.urlFor(otherRepo), `HEAD:refs/heads/${branch}`], dir);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("(ostra: this task's proxy serves only the task's own repos)");
    expect(pushed.stderr).toContain("[remote rejected]");
    const cloned = await clone(proxy.urlFor(otherRepo), "other-clone");
    expect(cloned.run.code).not.toBe(0);
    expect(upstream.requests.filter((request) => request.repo === otherRepo)).toEqual([]);
  }, 60_000);

  it("F-090: names the code host's refusal by status, and logs the status without the body", async () => {
    const proxy = await startProxy();
    const saved = token;
    token = "ghs_expired_or_unknown_token_value";
    try {
      const { run } = await clone(proxy.urlFor(repo), "refused");
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("ostra: the code host refused the task's credential (status 401)");
    } finally {
      token = saved;
    }
    const line = logs.find((record) => record.message === "upstream refused");
    expect(line?.fields).toMatchObject({ status: 401, source: "code-host" });
    expect(JSON.stringify(logs)).not.toContain("credentials required");
  }, 60_000);
});

describe("a refused push's answer and its cost", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const commands = (ref: string, capabilities: string): Buffer =>
    Buffer.concat([encodePkt(`${A} ${B} ${ref}\0${capabilities}\n`), FLUSH_PKT, Buffer.from("PACK")]);
  const receivePack = (proxy: GitProxy, body: Buffer): Promise<Response> =>
    fetch(`${proxy.urlFor(repo)}/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body });

  it("F-090: answers a plain 403 with the reason only when the client asked for no report, and sends nothing upstream", async () => {
    const proxy = await startProxy();
    const before = receivePacks(repo);
    const plain = await receivePack(proxy, commands("refs/heads/main", "agent=git/2.53"));
    expect(plain.status).toBe(403);
    expect(await plain.text()).toContain("ostra: only the task's branch and its hidden ref can be pushed");
    // The same push with report-status gets git's own report, the ref refused with its reason.
    const reported = await receivePack(proxy, commands("refs/heads/main", "report-status agent=git/2.53"));
    expect(reported.status).toBe(200);
    expect(await reported.text()).toContain("ng refs/heads/main ostra: only the task's branch and its hidden ref can be pushed");
    expect(receivePacks(repo)).toBe(before);
  });

  it("F-090: reads at most its cap of a refused push, then closes the connection; the cap is 1 GiB", async () => {
    expect(MAX_DISCARD_BYTES).toBe(1024 * 1024 * 1024);
    const cap = 256 * 1024;
    const proxy = await startProxy("read-write", cap);
    const before = receivePacks(repo);
    // Under the cap: the refusal is read to its end and answered.
    const small = await receivePack(proxy, Buffer.concat([commands("refs/heads/main", "report-status"), randomBytes(cap / 2)]));
    expect(small.status).toBe(200);
    expect(await small.text()).toContain("ng refs/heads/main");
    // Past the cap: the proxy stops reading and cuts the connection, with no answer.
    const url = new URL(`${proxy.urlFor(repo)}/git-receive-pack`);
    const outcome = await new Promise<string>((resolve) => {
      const request = http.request(url, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" } }, (response) => {
        response.resume();
        resolve(`answered ${String(response.statusCode)}`);
      });
      request.on("error", (error) => {
        resolve(`cut: ${error.message}`);
      });
      request.write(commands("refs/heads/main", "report-status"));
      let sent = 0;
      const chunk = randomBytes(64 * 1024);
      const pump = (): void => {
        while (sent < cap * 64) {
          sent += chunk.length;
          if (!request.write(chunk)) {
            request.once("drain", pump);
            return;
          }
        }
        request.end();
      };
      pump();
    });
    expect(outcome).toMatch(/^cut: /);
    expect(receivePacks(repo)).toBe(before);
    expect(logs.some((record) => record.message === "a refused push passed the cap on what the proxy reads: connection closed")).toBe(true);
  }, 60_000);
});

describe("LFS through the proxy", () => {
  it("F-090: uploads and downloads with git-lfs, and the signed URL and its header never reach the client", async () => {
    const proxy = await startProxy();
    const { dir } = await clone(proxy.urlFor(repo), "lfs");
    expect((await runGit(["lfs", "install", "--local"], dir)).code).toBe(0);
    await runGit(["checkout", "--quiet", "-b", branch, `origin/${branch}`], dir);
    await runGit(["lfs", "track", "*.bin"], dir);
    const content = randomBytes(64 * 1024);
    await writeFile(path.join(dir, "blob.bin"), content);
    await runGit(["add", "--all"], dir);
    await runGit(["commit", "--quiet", "-m", "add an LFS object"], dir);
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], dir, { GIT_TRACE: "1", GIT_CURL_VERBOSE: "1" });
    expect(pushed.code, pushed.stderr).toBe(0);
    const oid = createHash("sha256").update(content).digest("hex");
    expect(upstream.requests.some((request) => request.endpoint === "lfs-object" && request.method === "PUT" && request.authorized)).toBe(true);

    const fresh = path.join(root, "lfs-fresh");
    const cloned = await runGit(["clone", "--quiet", "--branch", branch, proxy.urlFor(repo), fresh], root, { GIT_TRACE: "1", GIT_CURL_VERBOSE: "1" });
    expect(cloned.code, cloned.stderr).toBe(0);
    expect((await readFile(path.join(fresh, "blob.bin"))).equals(content)).toBe(true);

    const seen = [pushed.stdout, pushed.stderr, cloned.stdout, cloned.stderr].join("\n");
    expect(seen).toContain("_ostra/lfs/");
    expect(seen).not.toContain(`/_lfs/`);
    expect(seen).not.toContain(upstream.lfsCredential);
    // The client talked to the proxy only: the upstream's address is in none of its traffic.
    expect(seen).not.toContain(upstream.origin);
    expect(oid).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("F-090: refuses an object whose action points at a host it doesn't allow, with an error and no actions", async () => {
    const proxy = await startProxy();
    const response = await fetch(`${proxy.urlFor(repo)}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { "content-type": "application/vnd.git-lfs+json", accept: "application/vnd.git-lfs+json" },
      body: JSON.stringify({
        operation: "download",
        ref: { name: LFS_HOSTILE_PROBE_REF },
        objects: Array.from({ length: 5 }, (_, index) => ({ oid: createHash("sha256").update(String(index)).digest("hex"), size: 1 })),
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    const objects: unknown = Reflect.get(Object(body), "objects");
    expect(Array.isArray(objects) ? objects.length : 0).toBe(5);
    for (const object of Array.isArray(objects) ? objects : []) {
      expect(Reflect.get(Object(object), "actions")).toBeUndefined();
      expect(Reflect.get(Object(object), "error")).toEqual({ code: 403, message: LFS_ACTION_REFUSED_MESSAGE });
    }
    expect(text).not.toContain("169.254.169.254");
    expect(text).not.toContain(upstream.lfsCredential);
  });
});

describe("read-only mode", () => {
  const post = (url: string, body: unknown): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/vnd.git-lfs+json" }, body: JSON.stringify(body) });

  it("F-090: read-only clones, and refuses the push advertisement, LFS uploads, lock checks and non-GET actions", async () => {
    const proxy = await startProxy("read-only");
    const { dir, run } = await clone(proxy.urlFor(repo), "read-only");
    expect(run.code, run.stderr).toBe(0);
    await commitFile(dir, "nope.txt", "x\n");
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], dir);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("403");

    const advertisement = await fetch(`${proxy.urlFor(repo)}/info/refs?service=git-receive-pack`);
    expect(advertisement.status).toBe(403);
    expect(await advertisement.text()).toContain("ostra: this task can fetch but not push");

    const oid = createHash("sha256").update("read-only").digest("hex");
    const upload = await post(`${proxy.urlFor(repo)}/info/lfs/objects/batch`, { operation: "upload", objects: [{ oid, size: 9 }] });
    expect(upload.status).toBe(403);
    const locks = await post(`${proxy.urlFor(repo)}/info/lfs/locks/verify`, {});
    expect(locks.status).toBe(403);

    // A download action, then a PUT to it: refused, because only GET is allowed read-only.
    const objectContent = randomBytes(16);
    const writer = await startProxy();
    const writerUpload = await post(`${writer.urlFor(repo)}/info/lfs/objects/batch`, {
      operation: "upload",
      objects: [{ oid: createHash("sha256").update(objectContent).digest("hex"), size: objectContent.length }],
    });
    const uploadAnswer: unknown = await writerUpload.json();
    const href: unknown = Reflect.get(Object(Reflect.get(Object(Reflect.get(Object(Reflect.get(Object(uploadAnswer), "objects")), 0)), "actions")), "upload");
    const uploadHref: unknown = Reflect.get(Object(href), "href");
    expect(typeof uploadHref).toBe("string");
    if (typeof uploadHref === "string") {
      expect((await fetch(uploadHref, { method: "PUT", body: objectContent })).status).toBe(200);
    }
    const download = await post(`${proxy.urlFor(repo)}/info/lfs/objects/batch`, {
      operation: "download",
      objects: [{ oid: createHash("sha256").update(objectContent).digest("hex"), size: objectContent.length }],
    });
    const downloadAnswer: unknown = await download.json();
    const action: unknown = Reflect.get(Object(Reflect.get(Object(Reflect.get(Object(Reflect.get(Object(downloadAnswer), "objects")), 0)), "actions")), "download");
    const downloadHref: unknown = Reflect.get(Object(action), "href");
    expect(typeof downloadHref).toBe("string");
    if (typeof downloadHref === "string") {
      expect((await fetch(downloadHref)).status).toBe(200);
      expect((await fetch(downloadHref, { method: "PUT", body: "x" })).status).toBe(403);
    }
  }, 60_000);
});

describe("the User-Agent", () => {
  it("F-090: is required by the upstream, and the proxy always sends one", async () => {
    const proxy = await startProxy();
    const bare = (url: string): Promise<number> =>
      new Promise((resolve) => {
        const request = http.request(url, { method: "GET", headers: {} }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.end();
      });
    expect(await bare(`${upstream.cloneUrl(repo)}/info/refs?service=git-upload-pack`)).toBe(403);
    expect(await bare(`${proxy.urlFor(repo)}/info/refs?service=git-upload-pack`)).toBe(200);
    const last = upstream.requests.at(-1);
    expect(last?.userAgent).toMatch(/^ostra-git-proxy\//);
    expect(upstream.requests.filter((request) => request.repo !== "").every((request) => request.userAgent !== undefined)).toBe(true);
  });
});

describe("the token stays out", () => {
  it("F-090: is in no git output, log line or answer", () => {
    const everything = [...outputs, JSON.stringify(logs)].join("\n");
    expect(outputs.length).toBeGreaterThan(10);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
  });

  it("serves nothing outside its secret path", async () => {
    const proxy = await startProxy();
    const origin = new URL(proxy.baseUrl).origin;
    const response = await fetch(`${origin}/${repo}.git/info/refs?service=git-upload-pack`);
    expect(response.status).toBe(404);
  });
});
