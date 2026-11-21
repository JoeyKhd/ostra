import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { mayReach } from "@ostra/domain";
import { previewKeySchema, repoIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedAnnouncedPreview, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// Milestone 8, ticket 16 (F-140, F-121; ADR 0068): the environment's App tab through the panel's own
// procedures, on Postgres. A restricted project's admin saves its app processes, its screenshots
// after each turn and a service's preview label; its member reads them and is refused each save; an
// organization member it doesn't list and another organization's admin find nothing. Each rule comes
// back in its words; the audit entry names processes and fields, never a command. "Keep it" turns a
// port an agent announced into a proposal, which "Accept" refuses until its command is named.

let harness: ApiHarness;
let organizationId: OrganizationId;
let projectId: ProjectId;
let repoId: RepoId;
/** The restricted project's admin, no organization admin. */
let projectAdmin: SeededMember;
/** The restricted project's member. */
let projectMember: SeededMember;
/** An organization member the project doesn't list. */
let outsider: SeededMember;

let unique = 0;
const label = (prefix: string): string => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

const seedMember = async (): Promise<SeededMember> => {
  const name = label("person");
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name}@example.com`, username: name } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } }));
};

/** What a call ends in: `ok`, or a tRPC error's code. */
const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    throw error;
  }
};

const as = (member: SeededMember): Promise<AppCaller> => harness.as(member);

/** The secret-looking text a command carries: it must reach no audit entry and no log line. */
const SECRET_FLAG = `--token=${randomUUID()}`;

const web = () => ({ name: "web", repoId, command: "pnpm dev", port: 5173, ready: { kind: "http" as const, path: "/" }, label: "Web", primary: true });
const api = () => ({ name: "api", repoId, folder: "./api", command: `node server.js ${SECRET_FLAG}`, port: 3001, ready: { kind: "port" as const }, label: "API" });

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const made = await seedProject(harness, world, label("app"));
  projectId = made.projectId;
  repoId = repoIdSchema.parse(made.repoId);
  const admin = await as(harness.fixture.a.admin);
  await admin.projects.setAccess({ projectId, access: "restricted" });
  projectAdmin = await seedMember();
  projectMember = await seedMember();
  outsider = await seedMember();
  await admin.projects.setMember({ projectId, memberId: projectAdmin.id, role: "admin" });
  await admin.projects.setMember({ projectId, memberId: projectMember.id, role: "member" });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

describe("the environment's app processes (F-140)", () => {
  it("F-140/c1,c2: a project admin saves the app's processes in their start order, a project member is refused, and both read them with every field", async () => {
    const asAdmin = await as(projectAdmin);
    const asMember = await as(projectMember);
    expect(await outcomeOf(() => asMember.environments.appProcesses.save({ projectId, processes: [web(), api()] }))).toBe("FORBIDDEN");
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.appProcesses.save({ projectId, processes: [web(), api()] })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => as(harness.fixture.b.admin).then((caller) => caller.environments.appProcesses.save({ projectId, processes: [web(), api()] })))).toBe("NOT_FOUND");
    expect(await harness.test.db.appProcess.count({ where: { projectId } })).toBe(0);

    expect(await asAdmin.environments.appProcesses.save({ projectId, processes: [web(), api()] })).toEqual({ ok: true, saved: 2 });
    const listed = await asMember.environments.appProcesses.list({ projectId });
    expect(listed.canEdit).toBe(false);
    expect(listed.processes).toEqual([
      { name: "web", repoId, folder: ".", command: "pnpm dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true, hostRewrite: true, lastBox: null },
      { name: "api", repoId, folder: "api", command: `node server.js ${SECRET_FLAG}`, port: 3001, ready: { kind: "port" }, label: "API", primary: false, hostRewrite: true, lastBox: null },
    ]);
    expect((await asAdmin.environments.appProcesses.list({ projectId })).canEdit).toBe(true);
    // An organization admin manages every project; outside the project, nothing of it is found.
    expect(await (await as(harness.fixture.a.admin)).environments.appProcesses.save({ projectId, processes: [api(), { ...web(), hostRewrite: false }] })).toEqual({ ok: true, saved: 2 });
    expect((await asMember.environments.appProcesses.list({ projectId })).processes.map((process) => [process.name, process.hostRewrite])).toEqual([
      ["api", true],
      ["web", false],
    ]);
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.appProcesses.list({ projectId })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => as(harness.fixture.b.admin).then((caller) => caller.environments.appProcesses.list({ projectId })))).toBe("NOT_FOUND");
  });

  it("F-140/c2: each rule's refusal comes back in its words, for the field it's about, and nothing is saved", async () => {
    const asAdmin = await as(projectAdmin);
    await asAdmin.environments.appProcesses.save({ projectId, processes: [web(), api()] });
    const before = await harness.test.db.appProcess.findMany({ where: { projectId }, orderBy: { position: "asc" }, select: { name: true, port: true, primary: true } });
    const refused = (processes: Parameters<typeof asAdmin.environments.appProcesses.save>[0]["processes"]) => asAdmin.environments.appProcesses.save({ projectId, processes });

    expect(await refused([web(), { ...api(), primary: true }])).toEqual({
      ok: false,
      reason: "rule-broken",
      message: "At most one app process is the primary preview.",
      issues: [{ rule: "one-primary", message: "At most one app process is the primary preview." }],
    });
    expect(await refused([web(), { ...api(), name: "web" }])).toMatchObject({ ok: false, issues: [{ rule: "unique-name", name: "web", message: "Two app processes are named web: each name is used once." }] });
    expect(await refused([web(), { ...api(), port: 5173 }])).toMatchObject({ ok: false, issues: [{ rule: "unique-port", port: 5173, message: "Two app processes listen on port 5173: each port is used once." }] });
    // The one port a box keeps at a fixed number, the sidecar's control API, is refused when it's saved.
    expect(await refused([web(), { ...api(), port: 7101 }])).toMatchObject({
      ok: false,
      issues: [{ rule: "reserved-port", port: 7101, name: "sidecar-control", message: "Port 7101 is kept by the box itself: pick another for the app." }],
    });
    expect(await refused([web(), { ...api(), repoId: repoIdSchema.parse(randomUUID()) }])).toMatchObject({ ok: false, issues: [{ rule: "unknown-repo", name: "api", message: "The app process api names a repo this project doesn't have." }] });
    // A field that doesn't read is refused at the door: below 1024, a name out of its letters, a path without its `/`, an empty command, a folder outside the repo.
    for (const broken of [
      { ...api(), port: 80 },
      { ...api(), name: "My API" },
      { ...web(), ready: { kind: "http" as const, path: "health" } },
      { ...api(), command: "  " },
      { ...api(), folder: "../elsewhere" },
    ]) {
      expect(await outcomeOf(() => refused([web(), broken]))).toBe("BAD_REQUEST");
    }
    expect(await harness.test.db.appProcess.findMany({ where: { projectId }, orderBy: { position: "asc" }, select: { name: true, port: true, primary: true } })).toEqual(before);

    // The box picks its other ports when it starts: a port saved here that a box then keeps for
    // itself is refused there, by its name, never reached.
    expect(await asAdmin.environments.appProcesses.save({ projectId, processes: [web(), { ...api(), port: 41_000 }] })).toEqual({ ok: true, saved: 2 });
    const targets = [{ key: previewKeySchema.parse("app-api"), target: { process: "api" }, port: 41_000, label: "API", primary: false, path: "/", source: "declared" as const }];
    const reserved = { "key-proxy": 41_000, "git-proxy": null, "mcp-proxy": null, "sidecar-control": 7101, "agent-loopback": null, browser: null };
    expect(mayReach(41_000, targets, reserved)).toEqual({ ok: false, refusal: { reason: "reserved", name: "key-proxy" } });
    expect(mayReach(41_000, targets, { ...reserved, "key-proxy": 41_001 })).toMatchObject({ ok: true, key: "app-api" });
  });

  it("F-140/c1: each save's audit entry names the processes and the fields that changed and whether they moved, never a command's text", async () => {
    const asAdmin = await as(projectAdmin);
    await asAdmin.environments.appProcesses.save({ projectId, processes: [] });
    await asAdmin.environments.appProcesses.save({ projectId, processes: [web(), api()] });
    await asAdmin.environments.appProcesses.save({ projectId, processes: [{ ...api(), command: `node server.js ${SECRET_FLAG} --watch`, label: "Backend" }, web()] });
    const entries = await harness.test.db.auditEntry.findMany({ where: { projectId, action: "environment.app-processes-saved", actorId: projectAdmin.id }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(entries.map((entry) => entry.data)).toEqual([
      expect.objectContaining({ parts: "processes", processes: 2, added: "", removed: "", changed: "api:command+label", reordered: true }),
      expect.objectContaining({ parts: "processes", processes: 2, added: "web,api", removed: "", changed: "", reordered: false }),
    ]);
    const audited = JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { projectId } }));
    expect(audited).not.toContain(SECRET_FLAG);
    expect(audited).not.toContain("pnpm dev");
    expect(JSON.stringify(harness.logs)).not.toContain(SECRET_FLAG);
  });
});

describe("the screenshots after each turn (F-121)", () => {
  it("F-121/c1: a project admin sets the routes and widths, a member reads them and is refused the save, and they're taken only once a primary is declared", async () => {
    const asAdmin = await as(projectAdmin);
    const asMember = await as(projectMember);
    await asAdmin.environments.appProcesses.save({ projectId, processes: [{ ...web(), primary: false }] });
    expect(await asMember.environments.screenshots.get({ projectId })).toEqual({ afterTurn: true, routes: ["/"], widths: ["desktop"], primary: null, takes: false });

    const settings = { projectId, afterTurn: true, routes: ["/", "/settings?tab=2"], widths: ["desktop" as const, "phone" as const] };
    expect(await outcomeOf(() => asMember.environments.screenshots.save(settings))).toBe("FORBIDDEN");
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.screenshots.get({ projectId })))).toBe("NOT_FOUND");
    expect(await asAdmin.environments.screenshots.save(settings)).toEqual({ afterTurn: true, routes: ["/", "/settings?tab=2"], widths: ["desktop", "phone"], primary: null, takes: false });
    // A primary declared: they're taken. The processes' save leaves the screenshots as they are, and the screenshots' leaves the processes.
    await asAdmin.environments.appProcesses.save({ projectId, processes: [web()] });
    expect(await asMember.environments.screenshots.get({ projectId })).toEqual({ afterTurn: true, routes: ["/", "/settings?tab=2"], widths: ["desktop", "phone"], primary: "web", takes: true });
    expect(await asAdmin.environments.screenshots.save({ ...settings, afterTurn: false })).toMatchObject({ afterTurn: false, primary: "web", takes: false });
    expect((await asMember.environments.appProcesses.list({ projectId })).processes.map((process) => process.name)).toEqual(["web"]);
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { projectId, action: "environment.app-processes-saved" }, orderBy: { createdAt: "desc" } });
    expect(entry.data).toMatchObject({ parts: "screenshots", screenshotsAfterTurn: false, added: "", removed: "", changed: "" });

    // A route from `/` only, each once, at most 5; a width of the two, each once.
    for (const broken of [
      { ...settings, routes: ["settings"] },
      { ...settings, routes: ["//evil.example.com"] },
      { ...settings, routes: ["/", "/"] },
      { ...settings, routes: ["/a", "/b", "/c", "/d", "/e", "/f"] },
      { ...settings, routes: [] },
      { ...settings, widths: ["desktop" as const, "desktop" as const] },
    ]) {
      expect(await outcomeOf(() => asAdmin.environments.screenshots.save(broken))).toBe("BAD_REQUEST");
    }
  });
});

describe("a service with a web UI (F-140)", () => {
  it("F-140/c3: a project admin marks a service as a preview under a label, a member can't, and a service without a port can't be one", async () => {
    const asAdmin = await as(projectAdmin);
    const asMember = await as(projectMember);
    const mail = await asAdmin.environments.services.save({ projectId, name: "mailpit", image: "axllent/mailpit:v1.20", port: 8025, variables: [], healthCheck: null });
    const queue = await asAdmin.environments.services.save({ projectId, name: "queue", image: "redis:7", port: null, variables: [], healthCheck: null });
    expect(await outcomeOf(() => asMember.environments.services.setPreview({ projectId, serviceId: mail.serviceId, label: "Mail" }))).toBe("FORBIDDEN");
    expect(await asAdmin.environments.services.setPreview({ projectId, serviceId: mail.serviceId, label: "Mail" })).toEqual({ serviceId: mail.serviceId, previewLabel: "Mail" });
    const listed = await asMember.environments.services.list({ projectId });
    expect(listed.map((service) => [service.name, service.previewLabel])).toEqual([
      ["mailpit", "Mail"],
      ["queue", null],
    ]);
    expect(await outcomeOf(() => asAdmin.environments.services.setPreview({ projectId, serviceId: queue.serviceId, label: "Queue" }))).toBe("BAD_REQUEST");
    expect(await outcomeOf(() => asAdmin.environments.services.setPreview({ projectId, serviceId: mail.serviceId, label: "  " }))).toBe("BAD_REQUEST");
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.services.setPreview({ projectId, serviceId: mail.serviceId, label: "Mail" })))).toBe("NOT_FOUND");
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { projectId, action: "environment.app-processes-saved" }, orderBy: { createdAt: "desc" } });
    expect(entry.data).toMatchObject({ parts: "service-previews", servicePreviews: 1 });
    // Turned off, it's no preview; the other services keep theirs.
    expect(await asAdmin.environments.services.setPreview({ projectId, serviceId: mail.serviceId, label: null })).toEqual({ serviceId: mail.serviceId, previewLabel: null });
    expect((await asMember.environments.services.list({ projectId })).map((service) => service.previewLabel)).toEqual([null, null]);
  });
});

describe("detection's processes (F-140, F-112)", () => {
  it("F-140/c7: what detection reads and the list lacks comes back marked detected, and the environment's detection carries the processes", async () => {
    harness.fakes.codeHost.files.set(
      "ostra-test/test1",
      new Map([
        ["package.json", JSON.stringify({ scripts: { dev: "vite --port 5173", docs: "vitepress dev docs --port 4000", test: "vitest --port 9999" } })],
        ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
      ]),
    );
    const asAdmin = await as(projectAdmin);
    await asAdmin.environments.appProcesses.save({ projectId, processes: [web()] });
    const detection = await asAdmin.environments.detect({ projectId });
    expect(detection[0]?.detection.appProcesses.map((process) => [process.name, process.port, process.primary])).toEqual([
      ["web", 5173, true],
      ["docs", 4000, false],
    ]);
    const detected = await (await as(projectMember)).environments.appProcesses.detected({ projectId });
    expect(detected.processes).toEqual([
      { origin: "detected", repoId, repo: "ostra-test/test1", process: { name: "docs", label: "Docs", port: 4000, command: "pnpm docs", folder: ".", ready: { kind: "port" }, primary: false, source: "package.json" } },
    ]);
    expect(detected.unread).toEqual([]);
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.appProcesses.detected({ projectId })))).toBe("NOT_FOUND");
  });
});

describe('"Keep it" (F-140)', () => {
  it('F-140/c9: a member keeps a port the agent announced, a project admin sees the proposal it made, and "Accept" waits until "Edit and accept" names its command', async () => {
    const asAdmin = await as(projectAdmin);
    const asMember = await as(projectMember);
    await asAdmin.environments.appProcesses.save({ projectId, processes: [web()] });
    const task = await seedTask(harness, { organizationId, projectId, title: "Add a storybook", state: "running", driverMemberId: projectMember.id });
    const key = await seedAnnouncedPreview(harness, { taskId: task.taskId, organizationId, projectId }, { port: 6006, label: "Storybook" });

    expect(await outcomeOf(() => as(outsider).then((caller) => caller.tasks.keepPreview({ taskId: task.taskId, key })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => as(harness.fixture.b.admin).then((caller) => caller.tasks.keepPreview({ taskId: task.taskId, key })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => asMember.tasks.keepPreview({ taskId: task.taskId, key: previewKeySchema.parse("port-6007") }))).toBe("NOT_FOUND");
    const kept = await asMember.tasks.keepPreview({ taskId: task.taskId, key });
    expect(await outcomeOf(() => asMember.tasks.keepPreview({ taskId: task.taskId, key }))).toBe("CONFLICT");
    expect(await harness.test.db.auditEntry.count({ where: { projectId, action: "environment.app-process-kept", actorId: projectMember.id } })).toBe(1);

    // The App tab lists it as kept from the task, by whom, waiting for its command.
    const listed = await asAdmin.environments.appProcesses.list({ projectId });
    expect(listed.kept).toHaveLength(1);
    expect(listed.kept[0]).toMatchObject({
      proposalId: kept.proposalId,
      task: { taskId: task.taskId, title: "Add a storybook" },
      keptBy: { memberId: projectMember.id },
      process: { name: "storybook", port: 6006, label: "Storybook", primary: false },
      waitsForCommand: true,
    });
    expect(listed.kept[0]?.keptBy?.name).toMatch(/^person-/);
    // The proposal says where it came from, and shows the process against the list as it is.
    const proposal = await asAdmin.environments.proposal({ projectId });
    expect(proposal).toMatchObject({ proposalId: kept.proposalId, source: "kept", keptBy: { memberId: projectMember.id }, waitsForCommand: "storybook", canDecide: true });
    expect(proposal?.appProcesses.diff).toMatchObject({ added: [expect.objectContaining({ name: "storybook", port: 6006 })], changed: [], kept: ["web"] });
    expect((await asMember.environments.proposal({ projectId }))?.canDecide).toBe(false);

    // "Accept" as it is: refused in words. "Edit and accept" with the command: the process joins the list's end.
    expect(await outcomeOf(() => asAdmin.environments.decideProposal({ proposalId: kept.proposalId, decision: "accept", edited: null, reason: null }))).toBe("BAD_REQUEST");
    const body = proposal?.body;
    if (body === null || body === undefined) {
      throw new Error("the open proposal has no body");
    }
    const edited = { ...body, appProcesses: (body.appProcesses ?? []).map((process) => ({ ...process, command: "pnpm storybook --port 6006 --ci" })) };
    await asAdmin.environments.decideProposal({ proposalId: kept.proposalId, decision: "edit-and-accept", edited, reason: null });
    const after = await asMember.environments.appProcesses.list({ projectId });
    expect(after.processes.map((process) => [process.name, process.port, process.command])).toEqual([
      ["web", 5173, "pnpm dev"],
      ["storybook", 6006, "pnpm storybook --port 6006 --ci"],
    ]);
    expect(after.kept).toEqual([]);
  });

  it("F-140/c9: the App tab's Review accepts a kept process as the admin leaves it, its command named, and a member is refused", async () => {
    const asAdmin = await as(projectAdmin);
    const asMember = await as(projectMember);
    const task = await seedTask(harness, { organizationId, projectId, title: "Add the docs", state: "running", driverMemberId: projectMember.id });
    const key = await seedAnnouncedPreview(harness, { taskId: task.taskId, organizationId, projectId }, { port: 4000, label: "Docs" });
    const kept = await asMember.tasks.keepPreview({ taskId: task.taskId, key });
    const reviewed = { name: "docs", repoId, folder: "docs", command: "pnpm docs:dev", port: 4000, ready: { kind: "http" as const, path: "/" }, label: "Docs", primary: false, hostRewrite: true };

    expect(await outcomeOf(() => asMember.environments.appProcesses.acceptKept({ projectId, proposalId: kept.proposalId, process: reviewed }))).toBe("FORBIDDEN");
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.environments.appProcesses.acceptKept({ projectId, proposalId: kept.proposalId, process: reviewed })))).toBe("NOT_FOUND");
    await asAdmin.environments.appProcesses.acceptKept({ projectId, proposalId: kept.proposalId, process: reviewed });
    const after = await asMember.environments.appProcesses.list({ projectId });
    expect(after.processes.find((process) => process.name === "docs")).toMatchObject({ folder: "docs", command: "pnpm docs:dev", port: 4000, ready: { kind: "http", path: "/" } });
    expect(after.kept.find((one) => one.proposalId === kept.proposalId)).toBeUndefined();
    // Decided once: a second Accept finds nothing open.
    expect(await outcomeOf(() => asAdmin.environments.appProcesses.acceptKept({ projectId, proposalId: kept.proposalId, process: reviewed }))).toBe("NOT_FOUND");
  });
});
