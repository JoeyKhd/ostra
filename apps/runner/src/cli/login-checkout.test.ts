import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cliSessionMessages, taskIdSchema, ticketKeySchema } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkOwnerOnly } from "../identity/owner-only.ts";
import { startFakeCliServer } from "../testing/fake-cli-server.ts";
import type { FakeCliServer } from "../testing/fake-cli-server.ts";
import { exitCodes, runCli } from "./cli.ts";
import { helpText } from "./help.ts";
import { remoteKey } from "./checkout.ts";
import { cliSessionPath } from "./cli-session.ts";
import { createCapturingTerminal } from "./terminal.ts";

// Ticket 33 (F-103, F-028): `ostra login`, `ostra checkout` and `ostra logout`, against a server
// that answers with the CLI routes' schemas, and real git: two bare repos in a temporary folder,
// which the member's own git reaches by its `insteadOf` config, as it would reach GitHub.

const git = promisify(execFile);
const BRANCH = "ostra/ost-12-add-date";

let root = "";
let env: Record<string, string | undefined> = {};
let server: FakeCliServer;
const heads: Record<string, string> = {};

const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await git("git", args, { cwd, env })).stdout.trim();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-cli-local-"));
  const bare = path.join(root, "bare");
  await mkdir(bare, { recursive: true });
  const gitConfig = path.join(root, "member.gitconfig");
  // The member's own git: their name, and GitHub's URLs answered by the bare repos.
  await writeFile(
    gitConfig,
    [
      "[user]",
      "\tname = Demo Member",
      "\temail = demo@example.com",
      "[init]",
      "\tdefaultBranch = main",
      `[url "${pathToFileURL(bare).href}/"]`,
      "\tinsteadOf = https://github.com/ostra-test/",
    ].join("\n"),
  );
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    APPDATA: path.join(root, "appdata"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
  };
  for (const name of ["test1", "test2"]) {
    const seed = path.join(root, `seed-${name}`);
    await mkdir(seed);
    await gitIn(seed, "init");
    await writeFile(path.join(seed, "README.md"), `# ${name}\n`);
    await gitIn(seed, "add", "README.md");
    await gitIn(seed, "commit", "-m", "start");
    await gitIn(seed, "checkout", "-b", BRANCH);
    await writeFile(path.join(seed, "CHANGELOG.md"), `${name}: the agent's work\n`);
    await gitIn(seed, "add", "CHANGELOG.md");
    await gitIn(seed, "commit", "-m", "the agent's work");
    heads[name] = await gitIn(seed, "rev-parse", "HEAD");
    await gitIn(seed, "checkout", "main");
    await gitIn(root, "clone", "--bare", seed, path.join(bare, `${name}.git`));
  }
  server = await startFakeCliServer();
  const task = {
    taskId: taskIdSchema.parse("0196f1a0-cli-task-1"),
    key: ticketKeySchema.parse("OST-12"),
    repos: ["test1", "test2"].map((name) => ({
      fullName: `ostra-test/${name}`,
      cloneUrl: `https://github.com/ostra-test/${name}.git`,
      branch: BRANCH,
      baseBranch: "main",
      headSha: heads[name] ?? null,
    })),
  };
  server.tasks.set("OST-12", task);
  server.tasks.set(task.taskId, task);
}, 120_000);

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

afterEach(() => {
  server.grant = { outcome: "approve", pendingPolls: 1 };
});

type Run = { readonly code: number; readonly out: string };

const run = async (args: readonly string[], cwd = root): Promise<Run> => {
  const terminal = createCapturingTerminal();
  const code = await runCli(args, {
    env,
    terminal,
    signal: new AbortController().signal,
    runSignedIn: () => Promise.resolve(exitCodes.ok),
    runSidecar: () => Promise.resolve(exitCodes.ok),
    local: { sleep: () => Promise.resolve(), machineName: "demo-laptop", cwd },
  });
  return { code, out: terminal.lines().join("") };
};

const sessionFile = (): string => cliSessionPath(env);
const savedToken = async (): Promise<string> => {
  const parsed: unknown = JSON.parse(await readFile(sessionFile(), "utf8"));
  const token: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "token") : undefined;
  return typeof token === "string" ? token : "";
};

describe("ostra login, checkout and logout (F-103)", () => {
  it("F-103: `ostra login` signs in with the device code, saves the session for its owner only, and a second login replaces the first", async () => {
    const first = await run(["login", "--server", server.url]);
    expect(first.code, first.out).toBe(exitCodes.ok);
    expect(first.out).toContain("WDJB-MJHT");
    expect(first.out).toContain(`${server.url}/device?user_code=WDJB-MJHT`);
    expect(first.out).toContain("Signed in to");
    expect(server.deviceRequests.at(-1)).toMatchObject({ name: "demo-laptop" });
    const token = await savedToken();
    expect(token).toMatch(/^ostra_cli_/);
    expect(first.out).not.toContain(token);
    expect(await checkOwnerOnly(sessionFile())).toEqual({ ownerOnly: true });
    // The member's own config folder, never the runner's data folder.
    expect(sessionFile()).toBe(process.platform === "win32" ? path.join(root, "appdata", "ostra", "cli.json") : path.join(root, "xdg", "ostra", "cli.json"));
    const second = await run(["login"]);
    expect(second.code, second.out).toBe(exitCodes.ok);
    expect(await savedToken()).not.toBe(token);
  }, 60_000);

  it("F-103: a denied code signs nobody in", async () => {
    server.grant = { outcome: "deny", pendingPolls: 0 };
    const before = await savedToken().catch(() => "");
    const denied = await run(["login", "--server", server.url]);
    expect(denied.code).toBe(exitCodes.failed);
    expect(denied.out).toContain("denied");
    expect(await savedToken().catch(() => "")).toBe(before);
  }, 60_000);

  it("F-103: `ostra checkout` puts a two-repo task's branches into an existing clone and a fresh one, tracking the remote", async () => {
    expect((await run(["login", "--server", server.url])).code).toBe(exitCodes.ok);
    const work = path.join(root, "work");
    await mkdir(work, { recursive: true });
    // test1 is cloned already, in a child folder of another name; test2 isn't.
    await gitIn(work, "clone", "https://github.com/ostra-test/test1.git", "my-test1");
    const done = await run(["checkout", "OST-12"], work);
    expect(done.code, done.out).toBe(exitCodes.ok);
    const test1 = path.join(work, "my-test1");
    const test2 = path.join(work, "test2");
    expect(done.out).toContain(`ostra-test/test1  ${test1}  on ${BRANCH}`);
    expect(done.out).toContain(`ostra-test/test2  ${test2}  on ${BRANCH}`);
    for (const [dir, name] of [[test1, "test1"], [test2, "test2"]] as const) {
      expect(await gitIn(dir, "rev-parse", "HEAD")).toBe(heads[name]);
      expect(await gitIn(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
      expect(await gitIn(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${BRANCH}`);
    }
    // Again, by the task's ID with --dir: the local branches are there, and stay.
    const again = await run(["checkout", "0196f1a0-cli-task-1", "--dir", work], root);
    expect(again.code, again.out).toBe(exitCodes.ok);
    expect(await gitIn(test2, "rev-parse", "HEAD")).toBe(heads["test2"]);
  }, 120_000);

  it("F-103: a clone with uncommitted changes is refused, naming the repo, and nothing is changed", async () => {
    expect((await run(["login", "--server", server.url])).code).toBe(exitCodes.ok);
    const work = path.join(root, "dirty");
    await mkdir(work, { recursive: true });
    await gitIn(work, "clone", "https://github.com/ostra-test/test1.git", "test1");
    await writeFile(path.join(work, "test1", "README.md"), "# a member's edit\n");
    const refused = await run(["checkout", "OST-12"], work);
    expect(refused.code).toBe(exitCodes.failed);
    expect(refused.out).toContain("ostra-test/test1 has uncommitted changes");
    expect(await gitIn(path.join(work, "test1"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // test2 wasn't cloned either: a refusal changes nothing.
    await expect(stat(path.join(work, "test2"))).rejects.toThrow();
  }, 120_000);

  it("F-103: an unknown task and a revoked session are refused in words, the server's own for the session", async () => {
    expect((await run(["login", "--server", server.url])).code).toBe(exitCodes.ok);
    const unknown = await run(["checkout", "OST-999"]);
    expect(unknown.code).toBe(exitCodes.failed);
    expect(unknown.out).toContain('no task "OST-999"');
    server.revokeAll();
    const revoked = await run(["checkout", "OST-12"]);
    expect(revoked.code).toBe(exitCodes.failed);
    expect(revoked.out).toContain(cliSessionMessages["session-revoked"]);
  }, 60_000);

  it("F-103: `ostra logout` revokes the session on the server and removes the file; checkout then says to log in", async () => {
    expect((await run(["login", "--server", server.url])).code).toBe(exitCodes.ok);
    const token = await savedToken();
    const out = await run(["logout"]);
    expect(out.code, out.out).toBe(exitCodes.ok);
    expect(server.sessions.get(token)).toBe("revoked");
    await expect(stat(sessionFile())).rejects.toThrow();
    const after = await run(["checkout", "OST-12"]);
    expect(after.code).toBe(exitCodes.failed);
    expect(after.out).toContain(cliSessionMessages["session-missing"]);
  }, 60_000);

  it("F-103: `ostra --help` lists login, logout and checkout as available", () => {
    const help = helpText();
    expect(help).toMatch(/ostra login/);
    expect(help).toMatch(/ostra logout/);
    expect(help).toMatch(/ostra checkout <task>/);
    expect(help).not.toContain("not yet");
  });

  it("F-103: reads a clone's origin in any form git writes it", () => {
    expect(remoteKey("https://github.com/ostra-test/test1.git")).toBe("github.com/ostra-test/test1");
    expect(remoteKey("git@github.com:Ostra-Test/test1.git")).toBe("github.com/ostra-test/test1");
    expect(remoteKey("https://x-access-token:abc@github.com/ostra-test/test1/")).toBe("github.com/ostra-test/test1");
    expect(remoteKey("ssh://git@github.com/ostra-test/test1")).toBe("github.com/ostra-test/test1");
    expect(remoteKey("not a url")).toBeNull();
  });
});
