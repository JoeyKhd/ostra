import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import { approveRunner, createPool, postgresAuditLog, postgresChangeNotices, revokeJoinToken, systemClock } from "@ostra/domain";
import type { Clock, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { memberIdSchema, organizationIdSchema, PROTOCOL_MINOR, runnerIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";
import { createCapturingTerminal, exitCodes, runCli, runSignedInRunner } from "@ostra/runner";
import type { CliDeps } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";

// Milestone 5's ticket 19 (F-091, F-092): a pool runner's start, the real `ostra runner` (its sign-in,
// its `host` executor and its connection) against core's real register endpoint and gateway. It
// joins with its pool's token and waits as `joining`, saying so in `ostra runner status`, until an
// admin approves it; its hello and status carry what it reports, which core keeps on its row. A
// refused token says why and exits non-zero.

let api: ApiHarness;
let gateway: GatewayHarness;
let jobs: Jobs;
let organizationId: OrganizationId;
/** Core's clock, moved by a test to read a token's expiry. */
let shiftMs = 0;
const clock: Clock = { now: () => Date.now() + shiftMs };
const folders: string[] = [];
const DAY_MS = 86_400_000;

beforeAll(async () => {
  api = await createApiHarness();
  organizationId = organizationIdSchema.parse(api.fixture.a.organization.id);
  jobs = createJobs({ databaseUrl: api.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  gateway = await startGateway(api.test.db, api.test.url, { ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock, jobs } });
});

afterEach(async () => {
  shiftMs = 0;
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

afterAll(async () => {
  await gateway.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await api.dispose();
});

const admin = (): MemberScope => ({
  organizationId,
  memberId: memberIdSchema.parse(api.fixture.a.admin.id),
  role: "admin",
  projectRoles: new Map(),
});

const deps = () => ({ db: api.test.db, jobs, audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock });

const newPool = async (name: string, requiresApproval: boolean, joinTokenDays: number | null = null) => {
  const made = await createPool(deps(), admin(), { name, requiresApproval, maxBoxes: null, joinTokenDays });
  if (!made.ok) {
    throw new Error(made.message);
  }
  return made;
};

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "ostra-pool-start-"));
  folders.push(dir);
  return dir;
};

const until = async (check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`waited too long for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const statusFile = async (dataDir: string): Promise<{ readonly pool?: { readonly name: string; readonly awaitingApproval: boolean } | null }> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dataDir, "status.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

const cliDeps = (signal: AbortSignal, env: CliDeps["env"] = {}): CliDeps & { readonly lines: () => readonly string[] } => {
  const terminal = createCapturingTerminal();
  return {
    env,
    terminal,
    signal,
    runSignedIn: runSignedInRunner,
    runSidecar: () => Promise.resolve(exitCodes.usage),
    install: "source",
    lines: terminal.lines,
  };
};

/** `ostra runner status` for this data folder. */
const statusOutput = async (dataDir: string): Promise<string> => {
  const local = cliDeps(new AbortController().signal);
  expect(await runCli(["runner", "status", "--data-dir", dataDir], local)).toBe(exitCodes.ok);
  return local.lines().join("");
};

describe("a pool runner's start (ticket 19)", () => {
  it("F-091, F-092, F-013: the real ostra runner joins with its pool's token, waits as joining and says so in its status, reports what it offers, and is online once an admin approves it", async () => {
    // A `host` pool runs the agent as a separate user, which this machine has none of: the
    // development switch runs it as the runner's own (ticket 10). The start is the same.
    vi.stubEnv("OSTRA_DEV_HOST_POOL_SAME_USER", "true");
    const pool = await newPool("Build farm", true);
    const dataDir = await tempDir();
    const controller = new AbortController();
    const local = cliDeps(controller.signal, { OSTRA_JOIN_TOKEN: pool.joinToken.token });
    const running = runCli(["runner", "--server", gateway.url, "--data-dir", dataDir, "--name", "farm-1", "--labels", "gpu,tier:fast"], local);

    await until(async () => (await statusFile(dataDir)).pool?.awaitingApproval === true, "the welcome's pool");
    const row = await api.test.db.runner.findFirstOrThrow({ where: { organizationId, name: "farm-1" } });
    expect(row).toMatchObject({ kind: "pool", poolId: pool.poolId, state: "joining", approvedAt: null });
    expect(await statusOutput(dataDir)).toContain("Approval        waiting for an admin to approve this runner in Build farm");
    expect(local.lines().join("")).toContain("Waiting for an admin to approve this runner in Build farm.");

    // F-092: its hello and status carried what it reports, which core keeps on its row.
    await until(async () => (await api.test.db.runner.findUniqueOrThrow({ where: { id: row.id } })).install !== null, "the reports");
    const reported = await api.test.db.runner.findUniqueOrThrow({ where: { id: row.id } });
    expect(reported).toMatchObject({
      install: "source",
      minor: PROTOCOL_MINOR,
      slots: 2,
      cpuMillis: null,
      memoryMiB: null,
      capabilities: { isolation: "none", services: false, boxSizes: false, snapshots: "host-cache", registry: "none", nodeWait: false },
    });
    expect(reported.labels).toEqual(expect.arrayContaining(["gpu", "tier:fast", "executor:host"]));

    const approved = await api.test.db.$transaction((tx) =>
      approveRunner(
        { tx, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
        { organizationId, runnerId: runnerIdSchema.parse(row.id), memberId: memberIdSchema.parse(api.fixture.a.admin.id) },
      ),
    );
    expect(approved).toMatchObject({ ok: true });
    // The approval reaches the connected runner as `resume`: its status stops saying it waits.
    await until(async () => (await statusFile(dataDir)).pool?.awaitingApproval === false, "the approval's resume");
    expect((await api.test.db.runner.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("online");
    const after = await statusOutput(dataDir);
    expect(after).toContain("Pool            Build farm (approved)");
    expect(after).not.toContain("waiting for an admin");

    controller.abort();
    expect(await running).toBe(exitCodes.ok);
  }, 60_000);

  it.each([
    ["expired", "it has expired"],
    ["revoked", "it was revoked"],
    ["unknown", "the server doesn't know it"],
  ] as const)("F-091: a %s join token is refused with its reason, and ostra runner exits non-zero", async (reason, words) => {
    const pool = await newPool(`refusing-${reason}`, false, 1);
    let token = pool.joinToken.token;
    if (reason === "expired") {
      shiftMs = 2 * DAY_MS;
    } else if (reason === "revoked") {
      const revoked = await revokeJoinToken(deps(), admin(), { joinTokenId: pool.joinToken.joinTokenId });
      expect(revoked).toMatchObject({ ok: true });
    } else {
      token = `ostra_jt_${"x".repeat(40)}`;
    }
    const dataDir = await tempDir();
    const local = cliDeps(new AbortController().signal);
    const code = await runCli(["runner", "--server", gateway.url, "--join-token", token, "--data-dir", dataDir, "--name", `refused-${reason}`], local);
    expect(code).toBe(exitCodes.failed);
    expect(local.lines().join("")).toContain(`The pool's join token was refused (${reason}): ${words}.`);
    expect(await api.test.db.runner.count({ where: { name: `refused-${reason}` } })).toBe(0);
    // `ostra runner status` keeps the refusal.
    expect(await statusOutput(dataDir)).toContain(`join token was refused (${reason})`);
  });
});
