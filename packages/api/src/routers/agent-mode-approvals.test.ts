import { randomBytes } from "node:crypto";

import { LINEAR_AGENT_MODE_SCOPES, startTask } from "@ostra/domain";
import { agentSessionIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 26 (F-012, F-040; ADR 0013, ADR 0031, ADR 0057): Linear agent mode's switches and the
// approval of outside tasks. "Turn on agent mode" is an organization admin's, from their own session;
// "Start from Linear" takes one board per team; an outside task waits in Needs approval, named by the
// tracker's name and never an address, until a member who can open the project answers it, the first
// answer winning; only an organization admin switches the approval off.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: ProjectId;
let otherProjectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;
let otherBoardId: BoardId;

const OUTSIDER = { externalId: "lin-user-ada", name: "Ada Outside", email: "ada.outside@elsewhere.example" };

const admin = () => harness.as(harness.fixture.a.admin);
const member = () => harness.as(harness.fixture.a.member);
/** Organization A's insider, made an admin of the first project only. */
const projectAdmin = () => harness.as(harness.fixture.a.insider);

/** A Linear user from outside delegates a ticket: the task starts through the one start, as core's agent event does. */
const delegated = async (project: ProjectId, board: BoardId): Promise<TaskId> => {
  const ticketId = await seedTicket(harness, { projectId: project, boardId: board, connectionId, title: "Fix the checkout" });
  const session = await harness.test.db.agentSession.create({
    data: {
      organizationId: harness.fixture.a.organization.id,
      connectionId,
      externalSessionId: `ses-${randomBytes(4).toString("hex")}`,
      projectId: project,
      ticketId,
      boardId: board,
      state: "awaiting_approval",
      creatorExternalId: OUTSIDER.externalId,
      creatorName: OUTSIDER.name,
    },
  });
  const agentSessionId = agentSessionIdSchema.parse(session.id);
  const started = await harness.test.db.$transaction(async (tx) => {
    const result = await startTask(
      { tx, ...harness.deps.ports, publicUrl: harness.deps.settings.publicUrl },
      {
        organizationId: harness.fixture.a.organization.id,
        projectId: project,
        origin: { kind: "linear", agentSessionId, actor: { externalId: OUTSIDER.externalId, name: OUTSIDER.name }, matchedMemberId: null },
        kind: "code",
        ticketId,
        prompt: null,
        title: null,
        agentProfileId: null,
        poolLabels: [],
      },
    );
    if (!result.ok) throw new Error(`the start refused: ${result.error}`);
    await tx.agentSession.update({ where: { id: agentSessionId }, data: { taskId: result.taskId } });
    return result;
  });
  return started.taskId;
};

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "agent-mode")).projectId;
  otherProjectId = (await seedProject(harness, world, "agent-mode-two")).projectId;
  connectionId = await seedLinearConnection(harness);
  // The app's values are saved, as step 2 of the connection leaves them.
  const secret = await harness.fakes.secretStore.put({ organizationId: harness.fixture.a.organization.id, purpose: "linear-client-secret" }, "lin-client-secret-0123456789");
  if (!secret.ok) throw new Error("the fake secret store refused");
  await harness.test.db.connection.update({ where: { id: connectionId }, data: { clientSecretSecretRef: secret.value, scopes: ["read", "write", "issues:create", "comments:create"], accessTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000) } });
  boardId = await seedBoard(harness, { projectId, connectionId, externalId: "team-cal", key: "CAL" });
  otherBoardId = await seedBoard(harness, { projectId: otherProjectId, connectionId, externalId: "team-cal", key: "CAL" });
  const { a } = harness.fixture;
  await harness.test.db.projectMember.create({ data: { organizationId: a.organization.id, projectId, memberId: a.insider.id, role: "admin" } });
  const pool = await harness.test.db.runnerPool.create({ data: { organizationId: a.organization.id, name: "build-fleet" } });
  await harness.test.db.projectPool.create({ data: { organizationId: a.organization.id, projectId, poolId: pool.id, position: 1 } });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

describe("Linear agent mode's switches (F-012)", () => {
  it("F-012/c3: enableAgentMode answers the consent URL with agent mode's scopes, only from an organization admin's own session", async () => {
    expect((await trpcFailure(harness.anonymous().linear.enableAgentMode())).code).toBe("UNAUTHORIZED");
    expect((await trpcFailure((await member()).linear.enableAgentMode())).code).toBe("FORBIDDEN");
    expect((await trpcFailure((await projectAdmin()).linear.enableAgentMode())).code).toBe("FORBIDDEN");
    expect(await harness.test.db.oAuthState.count({ where: { connectionId } })).toBe(0);

    const asked = await (await admin()).linear.enableAgentMode();
    if (asked.kind !== "consent") throw new Error("expected a consent URL");
    const url = new URL(asked.authorizeUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(/[ ,]/);
    for (const scope of LINEAR_AGENT_MODE_SCOPES) {
      expect(scopes).toContain(scope);
    }
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // The state is bound to this admin and this session, and the URL carries none of the app's secrets.
    const state = await harness.test.db.oAuthState.findFirstOrThrow({ where: { connectionId }, orderBy: { createdAt: "desc" } });
    expect(state).toMatchObject({ memberId: harness.fixture.a.admin.id, authSessionId: `session-of-${harness.fixture.a.admin.id}` });
    expect(asked.authorizeUrl).not.toContain("lin-client-secret");
    // Nothing is on until Linear's consent comes back with the scopes.
    expect((await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).agentModeAt).toBeNull();

    // A connection that polls can't take Linear's webhooks: refused.
    await harness.test.db.connection.update({ where: { id: connectionId }, data: { webhookMode: "polling" } });
    expect((await trpcFailure((await admin()).linear.enableAgentMode())).code).toBe("PRECONDITION_FAILED");
    await harness.test.db.connection.update({ where: { id: connectionId }, data: { webhookMode: "webhooks" } });

    // A token that already holds the scopes is turned on at once, with its audit entry.
    await harness.test.db.connection.update({ where: { id: connectionId }, data: { scopes: { push: [...LINEAR_AGENT_MODE_SCOPES] } } });
    const on = await (await admin()).linear.enableAgentMode();
    expect(on.kind).toBe("on");
    const status = await (await admin()).linear.status();
    if (status.state !== "active") throw new Error("expected an active connection");
    expect(status.agentMode).toMatchObject({ on: true, grantedScopes: [...LINEAR_AGENT_MODE_SCOPES], missingScopes: [] });
    expect(status.agentMode?.turnedOnByName).toBe((await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).name);
    expect(await harness.test.db.auditEntry.count({ where: { action: "linear.agent-mode-enabled", entityId: connectionId } })).toBe(1);
  });

  it("F-012/c1: Start from Linear takes one board per team, and refuses a second naming the project that holds it", async () => {
    // A member, and an admin of another project, may not switch this project's board.
    expect((await trpcFailure((await member()).linear.setBoardAgentMode({ boardId, on: true }))).code).toBe("FORBIDDEN");
    expect((await trpcFailure((await projectAdmin()).linear.setBoardAgentMode({ boardId: otherBoardId, on: true }))).code).toBe("FORBIDDEN");
    expect((await trpcFailure((await harness.as(harness.fixture.b.admin)).linear.setBoardAgentMode({ boardId, on: true }))).code).toBe("NOT_FOUND");

    // The project's admin switches it on; the same team's board in another project is refused, by name.
    expect(await (await projectAdmin()).linear.setBoardAgentMode({ boardId, on: true })).toEqual({ boardId, on: true });
    const taken = await trpcFailure((await admin()).linear.setBoardAgentMode({ boardId: otherBoardId, on: true }));
    expect(taken.code).toBe("CONFLICT");
    expect(taken.message).toMatch(/in the project agent-mode$/);
    expect(await harness.test.db.board.count({ where: { connectionId, externalId: "team-cal", agentMode: true } })).toBe(1);

    const status = await (await admin()).linear.status();
    if (status.state !== "active" || status.agentMode === null) throw new Error("expected agent mode");
    expect(status.agentMode.boards.map((board) => [board.projectName, board.startFromLinear])).toEqual([
      ["agent-mode", true],
      ["agent-mode-two", false],
    ]);

    // Off in the first project, the team moves to the second.
    await (await projectAdmin()).linear.setBoardAgentMode({ boardId, on: false });
    expect(await (await admin()).linear.setBoardAgentMode({ boardId: otherBoardId, on: true })).toEqual({ boardId: otherBoardId, on: true });
    await (await admin()).linear.setBoardAgentMode({ boardId: otherBoardId, on: false });
    await (await projectAdmin()).linear.setBoardAgentMode({ boardId, on: true });
  });
});

describe("outside tasks and their approval (F-040)", () => {
  it("F-040/c1: Needs approval lists an outside task with who started it, its ticket, profile and pools, and never the starter's address", async () => {
    const taskId = await delegated(projectId, boardId);
    const listed = await (await member()).tasks.needsApproval({ projectId });
    const row = listed.tasks.find((task) => task.taskId === taskId);
    expect(row).toMatchObject({
      project: { id: projectId, name: "agent-mode" },
      startedBy: { kind: "outside", name: OUTSIDER.name },
      ticket: { title: "Fix the checkout" },
      // The project's own pools, in its order: the default one it was made with, then the one added.
      pools: ["default", "build-fleet"],
      poolOnly: true,
    });
    expect(row?.profile?.name).toEqual(expect.any(String));
    expect(listed.outsideApproval).toMatchObject({ projectId, on: true, changedByName: null });
    // Never the person's address, nor their tracker ID.
    const text = JSON.stringify(listed);
    expect(text).not.toContain(OUTSIDER.email);
    expect(text).not.toContain(OUTSIDER.externalId);
    // Across the member's projects, too; another organization's admin sees none of it.
    expect((await (await member()).tasks.needsApproval({ projectId: null })).tasks.map((task) => task.taskId)).toContain(taskId);
    expect((await (await harness.as(harness.fixture.b.admin)).tasks.needsApproval({ projectId: null })).tasks).toEqual([]);
    expect((await trpcFailure((await harness.as(harness.fixture.b.admin)).tasks.needsApproval({ projectId }))).code).toBe("NOT_FOUND");
    // The status counts the session awaiting approval and lists it, unmatched.
    const status = await (await admin()).linear.status();
    if (status.state !== "active" || status.agentMode === null) throw new Error("expected agent mode");
    expect(status.agentMode.sessions.awaitingApproval).toBeGreaterThan(0);
    expect(status.agentMode.lastSessionEvents.find((event) => event.taskId === taskId)).toMatchObject({ creatorName: OUTSIDER.name, matched: false, taskState: "awaiting_approval" });
    expect(JSON.stringify(status)).not.toContain(OUTSIDER.email);
  });

  it("F-040/c1: any member who can open the project approves or rejects it, the first answer winning, and nobody else answers", async () => {
    const first = await delegated(projectId, boardId);
    // Someone who can't open the project can't answer.
    expect((await trpcFailure((await harness.as(harness.fixture.b.admin)).tasks.approve({ taskId: first }))).code).toBe("NOT_FOUND");
    await harness.test.db.project.update({ where: { id: projectId }, data: { access: "restricted" } });
    try {
      expect((await trpcFailure((await member()).tasks.approve({ taskId: first }))).code).toBe("NOT_FOUND");
      expect((await trpcFailure((await member()).tasks.reject({ taskId: first, reason: null }))).code).toBe("NOT_FOUND");
      expect((await (await member()).tasks.needsApproval({ projectId: null })).tasks.map((task) => task.taskId)).not.toContain(first);
    } finally {
      await harness.test.db.project.update({ where: { id: projectId }, data: { access: "open" } });
    }
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: first } })).state).toBe("awaiting_approval");

    // Two members answer at once: one wins, the other is told it's answered.
    const answers = await Promise.allSettled([(await member()).tasks.approve({ taskId: first }), (await admin()).tasks.reject({ taskId: first, reason: "Not this one" })]);
    const won = answers.filter((answer) => answer.status === "fulfilled");
    expect(won).toHaveLength(1);
    const lost = answers.find((answer) => answer.status === "rejected");
    expect(lost?.status === "rejected" ? Reflect.get(Object(lost.reason), "code") : null).toBe("CONFLICT");
    const decided = await harness.test.db.task.findUniqueOrThrow({ where: { id: first } });
    expect(["queued", "stopped"]).toContain(decided.state);
    expect(await harness.test.db.auditEntry.count({ where: { entityId: first, action: { in: ["task.approved", "task.rejected"] } } })).toBe(1);

    // A second: a member approves it, and it's queued on one of the project's pools.
    const second = await delegated(projectId, boardId);
    expect((await (await member()).tasks.approve({ taskId: second })).taskId).toBe(second);
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ state: "queued", approvedByMemberId: harness.fixture.a.member.id, poolOnly: true });
    expect((await trpcFailure((await admin()).tasks.reject({ taskId: second, reason: null }))).code).toBe("CONFLICT");

    // A third: rejected with a reason, which the task keeps; approving it afterwards is refused.
    const third = await delegated(projectId, boardId);
    await (await member()).tasks.reject({ taskId: third, reason: "  We don't take requests from outside  " });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: third } })).toMatchObject({ state: "stopped", rejectedReason: "We don't take requests from outside" });
    expect((await trpcFailure((await admin()).tasks.approve({ taskId: third }))).code).toBe("CONFLICT");
    expect((await (await member()).tasks.needsApproval({ projectId })).tasks.map((task) => task.taskId)).not.toEqual(expect.arrayContaining([second, third]));
  });

  it("F-040/c2: only an organization admin switches outside approval off; a project admin and a member are refused", async () => {
    expect((await trpcFailure((await projectAdmin()).projects.setOutsideApproval({ projectId, on: false }))).code).toBe("FORBIDDEN");
    expect((await trpcFailure((await member()).projects.setOutsideApproval({ projectId, on: false }))).code).toBe("FORBIDDEN");
    expect((await trpcFailure((await harness.as(harness.fixture.b.admin)).projects.setOutsideApproval({ projectId, on: false }))).code).toBe("NOT_FOUND");
    expect((await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).outsideApproval).toBe(true);
    expect(await harness.test.db.auditEntry.count({ where: { action: "project.outside-approval-changed", entityId: projectId } })).toBe(0);

    const adminName = (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).name;
    expect(await (await admin()).projects.setOutsideApproval({ projectId, on: false })).toEqual({ projectId, on: false, changedByName: adminName });
    expect((await (await member()).tasks.needsApproval({ projectId })).outsideApproval).toEqual({ projectId, on: false, changedByName: adminName });
    expect(await harness.test.db.auditEntry.count({ where: { action: "project.outside-approval-changed", entityId: projectId } })).toBe(1);
    // With it off, an outside task starts at once, still only on a pool.
    const started = await delegated(projectId, boardId);
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: started } })).toMatchObject({ state: "queued", poolOnly: true });
    await (await admin()).projects.setOutsideApproval({ projectId, on: true });
  });
});
