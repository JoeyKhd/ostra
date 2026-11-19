import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createLogger } from "@ostra/adapter-sdk";
import { cliSessionMessages, gitShaSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { exitCodes, runCli } from "@ostra/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { handleCliRequest } from "./cli-http.ts";

// Ticket 33 (F-103, F-028, ADR 0051): the real `ostra` CLI (`runCli`, as `ostra login`, `ostra
// checkout` and `ostra logout` run it) against the CLI's real HTTP handler, the one the web app's
// `/api/cli/v1/` route hands every request to, on a real Postgres, and real git: two bare repos in
// a temporary folder, which the member's own git reaches by its `insteadOf` config, as it would
// reach the code host. The device page's approval is the column update better-auth's approve makes.

const git = promisify(execFile);
const BRANCH = "ostra/ost-12-add-the-date";

let harness: ApiHarness;
let server: Server;
let serverUrl = "";
let root = "";
let env: Record<string, string | undefined> = {};
let organizationId: OrganizationId;
let projectId: ProjectId;
let taskId = "";
const heads: Record<string, string> = {};

const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await git("git", args, { cwd, env })).stdout.trim();

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

/** The web app's route, as Next.js runs it: a `Request` in, the handler's `Response` out. */
const startCliRoute = async (): Promise<void> => {
  server = createServer((incoming, outgoing) => {
    void (async () => {
      const body = await readBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      const request = new Request(`${serverUrl}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body }),
      });
      const response = await handleCliRequest(harness.deps, request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  serverUrl = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`;
};

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const seeded = await seedProject(harness, world, "cli-checkout");
  projectId = seeded.projectId;
  const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: seeded.repoId } });
  const second = await harness.test.db.repo.create({
    data: { organizationId, projectId, connectionId: first.connectionId, installationId: first.installationId, hostRepoId: `${first.hostRepoId}-b`, fullName: "ostra-test/test2", defaultBranch: "main", checkoutDir: "test2" },
  });
  // The code host lists the second repo too: its clone address is the code host's own.
  for (const [appId, app] of harness.fakes.codeHost.apps) {
    const listed = app.repos.get(first.installationId) ?? [];
    const test2 = { hostRepoId: second.hostRepoId, fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" };
    harness.fakes.codeHost.apps.set(appId, { ...app, repos: new Map([...app.repos, [first.installationId, [...listed, test2]]]) });
  }
  const linear = await seedLinearConnection(harness);
  const board = await seedBoard(harness, { projectId, connectionId: linear });
  const ticketId = await seedTicket(harness, { projectId, boardId: board, connectionId: linear, key: "OST-12" });

  root = await mkdtemp(path.join(os.tmpdir(), "ostra-cli-route-"));
  const bare = path.join(root, "bare");
  await mkdir(bare, { recursive: true });
  const gitConfig = path.join(root, "member.gitconfig");
  // The member's own git: their name, and the code host's URLs answered by the bare repos.
  await writeFile(
    gitConfig,
    ["[user]", "\tname = Demo Member", "\temail = demo@example.com", "[init]", "\tdefaultBranch = main", `[url "${pathToFileURL(bare).href}/"]`, "\tinsteadOf = https://github.example/ostra-test/"].join("\n"),
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

  const task = await seedTask(harness, { organizationId, projectId, title: "Add the date", driverMemberId: harness.fixture.a.member.id });
  taskId = task.taskId;
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { ticketId, ticketKey: "OST-12", boardId: board } });
  for (const [repoId, name] of [[seeded.repoId, "test1"], [second.id, "test2"]] as const) {
    await harness.test.db.taskRepo.create({
      data: { organizationId, projectId, taskId: task.taskId, repoId, branchName: BRANCH, baseBranch: "main", state: "branch_pushed", headSha: gitShaSchema.parse(heads[name]) },
    });
  }
  await startCliRoute();
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  await harness.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The member approves the code on the device page while the CLI waits (better-auth's approve sets these columns). */
const approveOnTheDevicePage = async (): Promise<void> => {
  await harness.test.db.deviceCode.updateMany({
    where: { status: "pending", purpose: "cli" },
    data: { status: "approved", userId: harness.fixture.a.member.userId, lastPolledAt: new Date(Date.now() - 60_000) },
  });
};

type Run = { readonly code: number; readonly out: string };

const run = async (args: readonly string[], cwd = root): Promise<Run> => {
  const lines: string[] = [];
  const terminal = {
    say: (line: string) => {
      lines.push(`${line}\n`);
    },
    warn: (line: string) => {
      lines.push(`${line}\n`);
    },
    logger: createLogger(() => undefined),
  };
  const code = await runCli(args, {
    env,
    terminal,
    signal: new AbortController().signal,
    runSignedIn: () => Promise.resolve(exitCodes.ok),
    runSidecar: () => Promise.resolve(exitCodes.ok),
    local: { sleep: approveOnTheDevicePage, machineName: "demo-laptop", cwd },
  });
  return { code, out: lines.join("") };
};

const sessionFile = (): string => (process.platform === "win32" ? path.join(root, "appdata", "ostra", "cli.json") : path.join(root, "xdg", "ostra", "cli.json"));

describe("the ostra CLI against the CLI route on a real database (F-103)", () => {
  it("F-103: login through the device page, a two-repo checkout into an existing clone and a fresh one, a dirty clone refused, a revoked session refused in the server's words, then logout", async () => {
    // Login: the device code, approved on the device page, ends in a CLI session for this machine.
    const login = await run(["login", "--server", serverUrl]);
    expect(login.code, login.out).toBe(exitCodes.ok);
    // The device page is the panel's own address, from its settings.
    expect(login.out).toMatch(/open https?:\/\/[^ ]+\/device/);
    const sessions = await harness.test.db.cliSession.findMany({ where: { memberId: harness.fixture.a.member.id, revokedAt: null } });
    expect(sessions.map((session) => session.name)).toEqual(["demo-laptop"]);
    await stat(sessionFile());

    // Checkout by the ticket's key: test1 is cloned already, under another folder's name; test2 isn't.
    const work = path.join(root, "work");
    await mkdir(work, { recursive: true });
    await gitIn(work, "clone", "https://github.example/ostra-test/test1.git", "my-test1");
    const done = await run(["checkout", "OST-12"], work);
    expect(done.code, done.out).toBe(exitCodes.ok);
    for (const [dir, name] of [[path.join(work, "my-test1"), "test1"], [path.join(work, "test2"), "test2"]] as const) {
      expect(done.out).toContain(`ostra-test/${name}  ${dir}  on ${BRANCH}`);
      expect(await gitIn(dir, "rev-parse", "HEAD")).toBe(heads[name]);
      expect(await gitIn(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${BRANCH}`);
    }
    // By the task's URL, into a dirty clone: refused, naming the repo, and nothing changed.
    const dirty = path.join(root, "dirty");
    await mkdir(dirty, { recursive: true });
    await gitIn(dirty, "clone", "https://github.example/ostra-test/test1.git", "test1");
    await writeFile(path.join(dirty, "test1", "README.md"), "# a member's edit\n");
    const refused = await run(["checkout", `${serverUrl}/tasks/${taskId}`], dirty);
    expect(refused.code).toBe(exitCodes.failed);
    expect(refused.out).toContain("ostra-test/test1 has uncommitted changes");
    expect(await gitIn(path.join(dirty, "test1"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    // Revoked from the panel: the next checkout says so, in the server's words.
    await harness.test.db.cliSession.updateMany({ where: { memberId: harness.fixture.a.member.id }, data: { revokedAt: new Date() } });
    const revoked = await run(["checkout", taskId], work);
    expect(revoked.code).toBe(exitCodes.failed);
    expect(revoked.out).toContain(cliSessionMessages["session-revoked"]);

    // A fresh login, then logout: the server revokes it and the file goes.
    expect((await run(["login", "--server", serverUrl])).code).toBe(exitCodes.ok);
    const saved: unknown = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved).toMatchObject({ serverUrl });
    const out = await run(["logout"]);
    expect(out.code, out.out).toBe(exitCodes.ok);
    expect(await harness.test.db.cliSession.count({ where: { memberId: harness.fixture.a.member.id, revokedAt: null } })).toBe(0);
    await expect(stat(sessionFile())).rejects.toThrow();
  }, 240_000);
});
