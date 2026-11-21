import { createHash } from "node:crypto";

import { startCliSession } from "@ostra/domain";
import {
  cliPaths,
  cliPreviewTunnelGrantSchema,
  cliPreviewTunnelRefusalSchema,
  cliStartAppResponseSchema,
  cliTunnelTicketSchema,
  memberIdSchema,
  previewKeyFor,
  userIdSchema,
} from "@ostra/protocol";
import type { OrganizationId, ProjectId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";
import { handleCliRequest } from "./cli-http.ts";

// Milestone 8's ticket 23 (F-143, ADR 0068 "`ostra preview`"): the web app's two CLI routes for
// `ostra preview`. `POST /tasks/:ref/previews/tunnel` gives a member's CLI session a one-time
// ticket for one of the task's previews and core's public address, or refuses with the code the
// CLI words; `POST /tasks/:ref/app/start` starts the app for the session's member. Core's side of
// the tunnel is `apps/core/src/previews/tunnels.test.ts`.

let harness: ApiHarness;
let orgA: OrganizationId;
let project: ProjectId;
let runnerId: RunnerId;
let boxed: SeededTask;
let boxless: SeededTask;
let token: string;
let sessionId: string;
const WEB = 5173;
const API = 3001;

const origin = "http://localhost:3000";
const post = (path: string, body: unknown, bearer: string | null = token) =>
  handleCliRequest(
    harness.deps,
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const sessionFor = async (member: { readonly id: string; readonly userId: string }) => {
  const started = await startCliSession({ db: harness.test.db, ...harness.deps.ports }, { userId: userIdSchema.parse(member.userId), memberId: memberIdSchema.parse(member.id), machineName: "alex-laptop", sessionDays: 30 });
  if (!started.ok) {
    throw new Error("no session");
  }
  return started;
};

/** The runner's connection, as core's gateway records it: its minor and its carrier. */
const connectRunner = async (minor: number, carrier: "websocket" | "http") => {
  await harness.test.db.runnerPresence.upsert({
    where: { runnerId },
    create: { runnerId, organizationId: orgA, replicaId: "test-replica", connectionEpoch: 1, carrier, minor },
    update: { carrier, minor, disconnectedAt: null },
  });
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const calc = await seedProject(harness, world, "calc");
  project = calc.projectId;
  const environment = await harness.test.db.environment.findUniqueOrThrow({ where: { projectId: project } });
  // The app: a Vite frontend (the primary) and its API, two previews of every task in the project.
  for (const [name, port, primary, position] of [["web", WEB, true, 0], ["api", API, false, 1]] as const) {
    await harness.test.db.appProcess.create({
      data: { organizationId: orgA, projectId: project, environmentId: environment.id, repoId: calc.repoId, name, command: "pnpm dev", port, readyKind: "port", readyValue: null, label: name, primary, position },
    });
  }
  // The member's runner on `host`, at minor 7, which says it can tunnel, and a task in its box.
  const member = harness.fixture.a.member;
  runnerId = await seedPersonalRunner(harness, member.id, "alex-laptop");
  await harness.test.db.runner.update({ where: { id: runnerId }, data: { minor: 7, preview: { stream: true, tunnel: true } } });
  await connectRunner(7, "websocket");
  boxed = await seedTask(harness, { organizationId: orgA, projectId: project, title: "A boxed task", driverMemberId: member.id, runnerId });
  await seedLease(harness, boxed, orgA, project, runnerId);
  const lease = await harness.test.db.lease.findFirstOrThrow({ where: { taskId: boxed.taskId } });
  await harness.test.db.session.update({ where: { id: boxed.sessionId }, data: { boxId: lease.boxId } });
  boxless = await seedTask(harness, { organizationId: orgA, projectId: project, title: "A stopped task", state: "stopped", sessionState: "ended", driverMemberId: member.id });
  const session = await sessionFor(member);
  token = session.token;
  sessionId = session.sessionId;
});

afterAll(async () => {
  await harness.dispose();
});

describe("ostra preview's ticket", () => {
  it("F-143/c1: a member's CLI session gets a single-use ticket for the primary's port, with core's address, bound to that session", async () => {
    const answer = await post(cliPaths.previewTunnel(boxed.taskId), { port: null });
    expect(answer.status).toBe(200);
    const grant = cliPreviewTunnelGrantSchema.parse(await answer.json());
    expect(grant).toMatchObject({ coreUrl: "http://localhost:8787", port: WEB });
    expect(cliTunnelTicketSchema.safeParse(grant.ticket).success).toBe(true);
    // Stored as its hash, for 60 s, bound to the member, this CLI session, the task, the port and the lease epoch.
    const row = await harness.test.db.previewCode.findUniqueOrThrow({ where: { codeHash: createHash("sha256").update(grant.ticket).digest("hex") } });
    expect(row).toMatchObject({ kind: "cli_ticket", taskId: boxed.taskId, key: previewKeyFor({ process: "web" }), port: WEB, memberId: harness.fixture.a.member.id, cliSessionId: sessionId, leaseEpoch: 1, usedAt: null });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(61_000);
    expect(JSON.stringify(harness.logs)).not.toContain(grant.ticket);
    // Another preview of the task, by its port.
    const api = cliPreviewTunnelGrantSchema.parse(await (await post(cliPaths.previewTunnel(boxed.taskId), { port: API })).json());
    expect(api.port).toBe(API);
    // A member of another organization finds no such task; no session is no ticket.
    const other = await sessionFor(harness.fixture.b.admin);
    const foreign = await post(cliPaths.previewTunnel(boxed.taskId), { port: null }, other.token);
    expect([foreign.status, cliPreviewTunnelRefusalSchema.parse(await foreign.json())]).toEqual([404, { code: "not-found" }]);
    expect((await post(cliPaths.previewTunnel(boxed.taskId), { port: null }, null)).status).toBe(401);
  });

  it("F-143/c3: a port that isn't one of the task's previews, or one below 1024, is refused", async () => {
    for (const port of [4000, 22]) {
      const answer = await post(cliPaths.previewTunnel(boxed.taskId), { port });
      expect([answer.status, cliPreviewTunnelRefusalSchema.parse(await answer.json())]).toEqual([403, { code: "port-not-allowed" }]);
    }
  });

  it("F-143/c6: a runner on the HTTP carrier, or below minor 7, can't tunnel, and says so", async () => {
    try {
      for (const [minor, carrier] of [[7, "http"], [6, "websocket"]] as const) {
        await connectRunner(minor, carrier);
        const answer = await post(cliPaths.previewTunnel(boxed.taskId), { port: null });
        expect([answer.status, cliPreviewTunnelRefusalSchema.parse(await answer.json())]).toEqual([409, { code: "runner-cannot-tunnel" }]);
      }
    } finally {
      await connectRunner(7, "websocket");
    }
  });

  it("F-143/c5: a task with no box running gets no ticket, and the CLI's start route starts its app", async () => {
    const none = await post(cliPaths.previewTunnel(boxless.taskId), { port: null });
    expect([none.status, cliPreviewTunnelRefusalSchema.parse(await none.json())]).toEqual([409, { code: "no-box" }]);
    // "Start the app" for the session's member: a box already running gets `app.start`, with no agent turn.
    harness.fakes.outbox.clear();
    const started = await post(cliPaths.startApp(boxed.taskId), {});
    expect([started.status, cliStartAppResponseSchema.parse(await started.json())]).toEqual([200, { state: "running" }]);
    expect(harness.fakes.outbox.commands.map((command) => [command.kind, command.runnerId])).toEqual([["app.start", runnerId]]);
    // A task the member can't open isn't found.
    const other = await sessionFor(harness.fixture.b.admin);
    const foreign = await post(cliPaths.startApp(boxed.taskId), {}, other.token);
    expect([foreign.status, await foreign.json()]).toEqual([404, { code: "not-found" }]);
  });
});
