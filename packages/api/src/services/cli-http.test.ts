import { createHash, randomUUID } from "node:crypto";

import { startCliSession } from "@ostra/domain";
import {
  cliDeviceResponseSchema,
  cliDeviceTokenErrorSchema,
  cliDeviceTokenResponseSchema,
  cliHttpErrorSchema,
  cliPaths,
  cliSessionDeleteResponseSchema,
  cliSessionMessages,
  cliSessionTokenSchema,
  cliTaskBranchesResponseSchema,
  gitShaSchema,
  memberIdSchema,
  userIdSchema,
} from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appRouter } from "../routers/app-router.ts";
import { createBareHarness, createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { createCallerFactory } from "../trpc/init.ts";
import { createContext } from "../trpc/context.ts";
import { CLI_CLIENT_ID, handleCliRequest } from "./cli-http.ts";

// F-103, ticket 39 (ADR 0051): the `ostra` CLI's HTTP. The device-code grant ends in a CLI session
// whose token is shown once and stored hashed; the session reads a task's branches and clone URLs,
// resolving a key, an ID or a URL inside the member's organizations and projects, and nothing else:
// a revoked or expired session is refused with 401 and the CLI's own words, and no tRPC procedure
// accepts it.

let harness: ApiHarness;
let orgA: OrganizationId;
let project: ProjectId;
let promptTask: Awaited<ReturnType<typeof seedTask>>;
let ticketTask: Awaited<ReturnType<typeof seedTask>>;
const HEAD = gitShaSchema.parse(createHash("sha1").update("cli-head").digest("hex"));

const origin = "http://localhost:3000";
const request = (path: string, init: { readonly method?: string; readonly token?: string; readonly body?: unknown } = {}) =>
  new Request(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const call = (path: string, init?: Parameters<typeof request>[1]) => handleCliRequest(harness.deps, request(path, init));

/** A CLI session for a member, as `ostra login` would end with. */
const sessionFor = async (member: { readonly id: string; readonly userId: string }) => {
  const started = await startCliSession({ db: harness.test.db, ...harness.deps.ports }, { userId: userIdSchema.parse(member.userId), memberId: memberIdSchema.parse(member.id), machineName: "alex-laptop", sessionDays: 30 });
  if (!started.ok) {
    throw new Error("no session");
  }
  return started;
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const calc = await seedProject(harness, world, "calc");
  project = calc.projectId;
  const linear = await seedLinearConnection(harness);
  const board = await seedBoard(harness, { projectId: project, connectionId: linear });
  const ticketId = await seedTicket(harness, { projectId: project, boardId: board, connectionId: linear, key: "OST-142" });

  promptTask = await seedTask(harness, { organizationId: orgA, projectId: project, title: "A prompt task", driverMemberId: harness.fixture.a.member.id });
  await harness.test.db.taskRepo.create({
    data: { organizationId: orgA, projectId: project, taskId: promptTask.taskId, repoId: calc.repoId, branchName: "ostra/prompt-1", baseBranch: "main", state: "branch_pushed", headSha: HEAD },
  });
  ticketTask = await seedTask(harness, { organizationId: orgA, projectId: project, title: "A ticket task", driverMemberId: harness.fixture.a.member.id });
  await harness.test.db.task.update({ where: { id: ticketTask.taskId }, data: { ticketId, ticketKey: "OST-142", boardId: board } });
  await harness.test.db.taskRepo.create({
    data: { organizationId: orgA, projectId: project, taskId: ticketTask.taskId, repoId: calc.repoId, branchName: "ostra/ost-142-a-ticket-task", baseBranch: "main", state: "pr_open", headSha: HEAD },
  });
});

afterAll(async () => {
  await harness.dispose();
});

describe("the device-code grant", () => {
  it("F-103/c1: ends in a CLI session whose token is shown once, stored hashed, and used once", async () => {
    const started = await call(cliPaths.device, { method: "POST", body: { name: "alex-laptop", version: "0.3.0" } });
    expect(started.status).toBe(200);
    const grant = cliDeviceResponseSchema.parse(await started.json());
    expect(grant.verificationUrl).toBe(`${origin}/device`);
    expect(grant.verificationUrlComplete).toBe(`${origin}/device?user_code=${grant.userCode}`);
    const row = await harness.test.db.deviceCode.findFirstOrThrow({ where: { deviceCode: grant.deviceCode } });
    expect(row).toMatchObject({ purpose: "cli", clientId: CLI_CLIENT_ID, machineName: "alex-laptop", status: "pending" });

    // Nobody approved it yet; polling again at once is told to slow down.
    const pending = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } });
    expect(pending.status).toBe(400);
    expect(cliDeviceTokenErrorSchema.parse(await pending.json()).error.code).toBe("authorization-pending");
    const quick = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } });
    expect(cliDeviceTokenErrorSchema.parse(await quick.json()).error.code).toBe("slow-down");

    // The member approves it on the device page (better-auth's approve sets these two columns).
    const member = harness.fixture.a.member;
    await harness.test.db.deviceCode.update({ where: { id: row.id }, data: { status: "approved", userId: member.userId, lastPolledAt: new Date(Date.now() - 60_000) } });
    const granted = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } });
    expect(granted.status).toBe(200);
    const body = cliDeviceTokenResponseSchema.parse(await granted.json());
    expect(cliSessionTokenSchema.safeParse(body.token).success).toBe(true);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 86_400_000);

    // Only the hash is stored: the token is in no column of any CLI session, and in no log line.
    const stored = await harness.test.db.cliSession.findFirstOrThrow({ where: { id: body.sessionId } });
    expect(stored.tokenHash).toBe(createHash("sha256").update(body.token).digest("hex"));
    expect(stored).toMatchObject({ name: "alex-laptop", memberId: member.id, userId: member.userId, revokedAt: null });
    expect(JSON.stringify(stored)).not.toContain(body.token);
    expect(JSON.stringify(harness.logs)).not.toContain(body.token);

    // The grant is used up: a second poll gets no second session.
    const again = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } });
    expect(cliDeviceTokenErrorSchema.parse(await again.json()).error.code).toBe("expired-token");
    expect(await harness.test.db.cliSession.count({ where: { userId: member.userId, name: "alex-laptop" } })).toBe(1);
  });

  it("F-103/c1: a denied code and an expired one end the poll, and an unknown device code is expired", async () => {
    const make = async () => {
      const started = await call(cliPaths.device, { method: "POST", body: { name: "denied-laptop", version: "0.3.0" } });
      return cliDeviceResponseSchema.parse(await started.json());
    };
    const denied = await make();
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: denied.deviceCode }, data: { status: "denied", userId: harness.fixture.a.member.userId } });
    const refused = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: denied.deviceCode } });
    expect(cliDeviceTokenErrorSchema.parse(await refused.json()).error.code).toBe("access-denied");

    const old = await make();
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: old.deviceCode }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: old.deviceCode } });
    expect(cliDeviceTokenErrorSchema.parse(await expired.json()).error.code).toBe("expired-token");

    const unknown = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: "x".repeat(40) } });
    expect(cliDeviceTokenErrorSchema.parse(await unknown.json()).error.code).toBe("expired-token");
    // A request that is not a sign-in request is a plain 400.
    const bad = await call(cliPaths.device, { method: "POST", body: { nothing: true } });
    expect(bad.status).toBe(400);
    expect(cliHttpErrorSchema.parse(await bad.json()).error.code).toBe("bad-request");
  });

  it("F-103/c1: the grant is no login: better-auth's device endpoint trades it for nothing, as the CLI's client or a runner's", async () => {
    const started = await call(cliPaths.device, { method: "POST", body: { name: "sneaky", version: "0.3.0" } });
    const grant = cliDeviceResponseSchema.parse(await started.json());
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: grant.deviceCode }, data: { status: "approved", userId: harness.fixture.a.member.userId } });
    const exchange = (clientId: string) =>
      harness.auth.api.deviceToken({ body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.deviceCode, client_id: clientId } });
    await expect(exchange(CLI_CLIENT_ID)).rejects.toBeDefined();
    await expect(exchange("ostra-runner")).rejects.toBeDefined();
    expect(await harness.test.db.authSession.count({ where: { userId: harness.fixture.a.member.userId } })).toBe(0);
  });
});

describe("the branches of a task", () => {
  it("F-103/c2: resolve a ticket key, a task ID and a task URL to the same repos, branches and clone URLs", async () => {
    const member = harness.fixture.a.member;
    const session = await sessionFor(member);
    const refs = [{ ref: "OST-142", task: ticketTask }, { ref: ticketTask.taskId, task: ticketTask }, { ref: `${origin}/tasks/${ticketTask.taskId}`, task: ticketTask }, { ref: promptTask.taskId, task: promptTask }];
    for (const { ref, task } of refs) {
      const response = await call(cliPaths.taskBranches(ref), { token: session.token });
      expect(response.status, ref).toBe(200);
      const body = cliTaskBranchesResponseSchema.parse(await response.json());
      expect(body.taskId).toBe(task.taskId);
      expect(body.key).toBe(task === ticketTask ? "OST-142" : null);
      expect(body.repos).toEqual([
        {
          fullName: "ostra-test/test1",
          cloneUrl: "https://github.example/ostra-test/test1.git",
          branch: task === ticketTask ? "ostra/ost-142-a-ticket-task" : "ostra/prompt-1",
          baseBranch: "main",
          headSha: HEAD,
        },
      ]);
    }
    // The key matches without regard to case, the CLI's own typing.
    expect((await call(cliPaths.taskBranches("ost-142"), { token: session.token })).status).toBe(200);
    // No token of the host is in an answer: git uses the member's own access.
    expect(JSON.stringify(await (await call(cliPaths.taskBranches("OST-142"), { token: session.token })).json())).not.toMatch(/token|secret|x-access/i);
  });

  it("F-103/c2: another organization's task, a restricted project the member is not on and a nonsense ref are all not found", async () => {
    const restricted = await seedTask(harness, { organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, title: "Hidden" });
    const outsider = await sessionFor(harness.fixture.b.admin);
    for (const ref of [promptTask.taskId, "OST-142", `${origin}/tasks/${promptTask.taskId}`]) {
      const response = await call(cliPaths.taskBranches(ref), { token: outsider.token });
      expect(response.status, ref).toBe(404);
      expect(cliHttpErrorSchema.parse(await response.json()).error.code).toBe("not-found");
    }
    const plain = await sessionFor(harness.fixture.a.member);
    expect((await call(cliPaths.taskBranches(restricted.taskId), { token: plain.token })).status).toBe(404);
    const insider = await sessionFor(harness.fixture.a.insider);
    for (const ref of ["not a ref", "../../etc/passwd", "OST-", ""]) {
      expect((await call(cliPaths.taskBranches(ref === "" ? "%20" : ref), { token: insider.token })).status, ref).toBe(404);
    }
  });
});

describe("a session belongs to one organization", () => {
  /** The same account that is organization A's plain member, also a member of organization B. */
  const memberOfB = async () => {
    const { userId } = harness.fixture.a.member;
    const orgB = harness.fixture.b.organization.id;
    const existing = await harness.test.db.member.findFirst({ where: { userId, organizationId: orgB }, select: { id: true, userId: true } });
    return existing ?? harness.test.db.member.create({ data: { id: randomUUID(), organizationId: orgB, userId, role: "member", createdAt: new Date() }, select: { id: true, userId: true } });
  };

  it("F-103/c2: a session made in organization A can't check out a task in organization B, even when the same user is a member of B", async () => {
    const aMember = harness.fixture.a.member;
    const bProject = harness.fixture.b.project.id;
    const orgB = harness.fixture.b.organization.id;
    // The same account is also a member of organization B, which has an open project and a task in it.
    const inB = await memberOfB();
    const bTask = await seedTask(harness, { organizationId: orgB, projectId: bProject, title: "B's task", driverMemberId: inB.id });
    await harness.test.db.task.update({ where: { id: bTask.taskId }, data: { ticketKey: "BEE-7" } });

    const sessionA = await sessionFor(aMember);
    expect(sessionA.sessionId).toBeDefined();
    for (const ref of [bTask.taskId, `${origin}/tasks/${bTask.taskId}`]) {
      const response = await call(cliPaths.taskBranches(ref), { token: sessionA.token });
      expect(response.status, ref).toBe(404);
      expect(cliHttpErrorSchema.parse(await response.json()).error.code).toBe("not-found");
    }
    // The session made in B finds B's task (it has no repo, so the lookup passes and the protocol then refuses an empty list: a 502, never a 404) and not A's.
    const sessionB = await sessionFor(inB);
    const own = await call(cliPaths.taskBranches(bTask.taskId), { token: sessionB.token });
    expect(own.status).toBe(502);
    expect((await call(cliPaths.taskBranches(promptTask.taskId), { token: sessionB.token })).status).toBe(404);
    // And A's own task is still open to the session made in A.
    expect((await call(cliPaths.taskBranches(promptTask.taskId), { token: sessionA.token })).status).toBe(200);
  });

  it("F-103/c1: a grant approved in an organization makes a session of that organization's member, and its audit entry lands there", async () => {
    const aMember = harness.fixture.a.member;
    const orgB = harness.fixture.b.organization.id;
    const inB = await memberOfB();
    const started = await call(cliPaths.device, { method: "POST", body: { name: "two-orgs", version: "0.3.0" } });
    const grant = cliDeviceResponseSchema.parse(await started.json());
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: grant.deviceCode }, data: { status: "approved", userId: aMember.userId, organizationId: orgB, lastPolledAt: new Date(Date.now() - 60_000) } });
    const granted = await call(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } });
    const body = cliDeviceTokenResponseSchema.parse(await granted.json());
    const stored = await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(stored).toMatchObject({ memberId: inB.id, organizationId: orgB });
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "cli-session.started", entityId: inB.id } });
    expect(entry.organizationId).toBe(orgB);
  });
});

describe("a CLI session's life", () => {
  it("F-103/c4: a missing, unknown, revoked or expired session is refused with 401 and the CLI's own words", async () => {
    const path = cliPaths.taskBranches("OST-142");
    const missing = await call(path);
    expect(missing.status).toBe(401);
    expect(cliHttpErrorSchema.parse(await missing.json())).toEqual({ error: { code: "session-missing", message: cliSessionMessages["session-missing"] } });
    const unknown = await call(path, { token: "ostra_cli_" + "A".repeat(43) });
    expect(cliHttpErrorSchema.parse(await unknown.json()).error.code).toBe("session-missing");
    // A login session's token, or any other bearer, is no CLI session.
    expect((await call(path, { token: "not-an-ostra-token" })).status).toBe(401);

    const member = harness.fixture.a.member;
    const revoked = await sessionFor(member);
    expect((await call(path, { token: revoked.token })).status).toBe(200);
    // Revoked from the panel (the member's own Account page).
    const caller = await harness.as(member);
    await caller.account.cliSessions.revoke({ sessionId: revoked.sessionId });
    const afterRevoke = await call(path, { token: revoked.token });
    expect(afterRevoke.status).toBe(401);
    expect(cliHttpErrorSchema.parse(await afterRevoke.json())).toEqual({ error: { code: "session-revoked", message: cliSessionMessages["session-revoked"] } });

    const expiring = await sessionFor(member);
    await harness.test.db.cliSession.update({ where: { id: expiring.sessionId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const afterExpiry = await call(path, { token: expiring.token });
    expect(afterExpiry.status).toBe(401);
    expect(cliHttpErrorSchema.parse(await afterExpiry.json()).error).toEqual({ code: "session-expired", message: cliSessionMessages["session-expired"] });
  });

  it("F-103/c4: logout revokes the session it is made with, and the session is then refused", async () => {
    const session = await sessionFor(harness.fixture.a.member);
    const out = await call(cliPaths.session, { method: "DELETE", token: session.token });
    expect(out.status).toBe(200);
    expect(cliSessionDeleteResponseSchema.parse(await out.json())).toEqual({ revoked: true });
    expect((await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: session.sessionId } })).revokedAt).not.toBeNull();
    const after = await call(cliPaths.session, { method: "DELETE", token: session.token });
    expect(after.status).toBe(401);
    expect(cliHttpErrorSchema.parse(await after.json()).error.code).toBe("session-revoked");
  });

  it("F-103/c4: a CLI session can do nothing else: every tRPC procedure refuses it, a read and a write alike", async () => {
    const session = await sessionFor(harness.fixture.a.member);
    const context = await createContext(harness.deps, { headers: new Headers({ authorization: `Bearer ${session.token}` }), resHeaders: new Headers() });
    // The real context: better-auth finds no login session behind the token.
    expect(context.user).toBeNull();
    const caller = createCallerFactory(appRouter)(context);
    const refused = async (run: () => Promise<unknown>) => {
      await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN", message: "A CLI session can only fetch a task's branches for `ostra checkout`" });
    };
    await refused(() => caller.me.get());
    await refused(() => caller.home.overview());
    await refused(() => caller.tasks.get({ taskId: promptTask.taskId }));
    await refused(() => caller.tasks.local({ taskId: promptTask.taskId }));
    await refused(() => caller.tasks.stop({ taskId: promptTask.taskId }));
    await refused(() => caller.diff.get({ taskId: promptTask.taskId }));
    await refused(() => caller.account.cliSessions.list());
    await refused(() => caller.account.cliSessions.revoke({ sessionId: session.sessionId }));
    // It is still good for the CLI's own routes after all that.
    expect((await call(cliPaths.taskBranches("OST-142"), { token: session.token })).status).toBe(200);
  });
});

describe("a bare install", () => {
  it("F-103/c4: a request for an address the CLI does not have is a 404 in the CLI's error shape", async () => {
    const response = await call("/api/cli/v1/elsewhere");
    expect(response.status).toBe(404);
    expect(cliHttpErrorSchema.parse(await response.json()).error.code).toBe("not-found");
  });
});

// A harness with no organization is enough to prove the grant needs an account behind it.
describe("a grant approved by an account with no organization", () => {
  it("F-103/c1: ends in a refusal and not a session", async () => {
    const bare = await createBareHarness();
    try {
      const started = await handleCliRequest(bare.deps, request(cliPaths.device, { method: "POST", body: { name: "orphan", version: "0.3.0" } }));
      const grant = cliDeviceResponseSchema.parse(await started.json());
      const user = await bare.test.db.user.create({ data: { id: "orphan-user", name: "Orphan", email: "orphan@example.com", emailVerified: true, username: "orphan" } });
      await bare.test.db.deviceCode.updateMany({ where: { deviceCode: grant.deviceCode }, data: { status: "approved", userId: user.id, lastPolledAt: new Date(Date.now() - 60_000) } });
      const polled = await handleCliRequest(bare.deps, request(cliPaths.deviceToken, { method: "POST", body: { deviceCode: grant.deviceCode } }));
      expect(cliDeviceTokenErrorSchema.parse(await polled.json()).error.code).toBe("access-denied");
      expect(await bare.test.db.cliSession.count()).toBe(0);
    } finally {
      await bare.dispose();
    }
  });
});
