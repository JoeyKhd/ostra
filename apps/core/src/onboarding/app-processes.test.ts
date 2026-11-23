import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideEnvironmentProposal,
  detectRepoEnvironment,
  environmentAppProcessList,
  KEPT_COMMAND_PLACEHOLDER,
  ONBOARDING_NO_APP_TOOLS_LINE,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  proposeAppProcess,
  saveAppProcesses,
  startOnboarding,
  taskAppSupport,
} from "@ostra/domain";
import type { MemberScope, PreviewDeps } from "@ostra/domain";
import type { SeededMember } from "@ostra/db/testing";
import { createBareHarness, pngBytes } from "@ostra/api/testing";
import type { BareHarness } from "@ostra/api/testing";
import {
  APP_SCREENSHOT_CONTENT_TYPE,
  attachmentIdSchema,
  boxIdSchema,
  encodeTaskSpecForMinor,
  environmentProposalIdSchema,
  environmentProposalResponseSchema,
  environmentProposalSchema,
  isTaskOfferable,
  leaseEpochSchema,
  memberIdSchema,
  ONE_ORIGIN_RULE,
  previewKeySchema,
  previewRefusalWords,
  projectIdSchema,
  repoIdSchema,
  runnerPaths,
  sessionIdSchema,
  taskIdSchema,
  taskSpecSchemaV6,
  turnIdSchema,
} from "@ostra/protocol";
import type { EnvironmentProposal, EnvironmentProposalId, RepoId, TaskEvent, TaskId, TaskSpecAppProcess } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import type { SpecDeps } from "../dispatch/task-spec.ts";
import { handleEnvironmentProposalEndpoint } from "../runner-http/environment-proposal.ts";
import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { postJson, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { leaseEpochOne, REPO, seedTaskInCi, startLoopHarness } from "../testing/review-loop.ts";
import { drive } from "../testing/turns.ts";
import type { LoopHarness } from "../testing/review-loop.ts";
import { APP_ID, APP_PRIVATE_KEY, ENV_SECRET, INSTALLATION_ID } from "../testing/world.ts";

// Milestone 8's ticket 15 (F-140, ADR 0068): core's app processes, against Postgres and the fake code
// host. The task spec carries the environment's processes, its screenshots and the `app` tools to a
// minor-7 runner and none of it to a minor-6 one; detection reads the `test-web` fixture's files as
// text; the onboarding task tests the detected processes in its box and proposes them, and "Accept"
// saves them; "Keep it" turns a port the agent announced into a proposal for a project admin.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../e2e/m8-previews-and-library/fixtures/test-web");

let h: LoopHarness;
let gateway: GatewayHarness;
/** The panel's own procedures, on the harness's database: the view the proposal page reads. */
let api: BareHarness;
let repoId: RepoId;

beforeAll(async () => {
  h = await startLoopHarness();
  repoId = repoIdSchema.parse(h.world.repoId);
  // The `test-web` app's files on the repo's default branch, as ticket 34 makes the repo from them.
  for (const file of ["package.json", "vite.config.js"]) {
    h.codeHost.repoFiles.set(`${REPO}@main:${file}`, await readFile(path.join(fixtureDir, file), "utf8"));
  }
  h.codeHost.repoFiles.set(`${REPO}@main:AGENTS.md`, "# Agents\n");
  gateway = await startGateway(h.db, h.test.url, {}, (gw) => [
    handleEnvironmentProposalEndpoint({ db: h.db, tokens: gw.context.tokens, taskTokens: gw.context.taskTokens, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock, secretStore: h.secretStore, logger: h.logger }),
  ]);
  // The panel's procedures on the same rows: `environments.proposal` and `environments.appProcesses.list`.
  api = await createBareHarness({ test: h.test });
});

afterAll(async () => {
  await api.dispose();
  await gateway.stop();
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
  // Every test starts from a saved environment with no app process, and no proposal or onboarding task open.
  await h.db.appProcess.deleteMany({ where: { projectId: h.world.projectId } });
  await h.db.environmentProposal.updateMany({ where: { projectId: h.world.projectId, state: "proposed" }, data: { state: "superseded" } });
  await h.db.task.updateMany({ where: { projectId: h.world.projectId, onboarding: true, state: { notIn: ["stopped", "merged", "done"] } }, data: { state: "stopped", stoppedReason: "requested" } });
  await h.db.environment.update({ where: { projectId: h.world.projectId }, data: { status: "saved", setupScript: "make bootstrap" } });
  await h.db.runnerPresence.update({ where: { runnerId: h.runner.runnerId }, data: { minor: 5 } });
});

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({ organizationId: h.world.organizationId, memberId: memberIdSchema.parse(member.id), role, projectRoles: new Map() });
const admin = (): MemberScope => scopeOf(h.fixture.a.admin, "admin");
const member = (): MemberScope => scopeOf(h.fixture.a.member, "member");
/** Another organization's admin: nothing of this one's is theirs. */
const outsider = (): MemberScope => ({ organizationId: h.fixture.b.organization.id, memberId: memberIdSchema.parse(h.fixture.b.admin.id), role: "admin", projectRoles: new Map() });

const adapters = () => ({ codeHost: h.codeHost, modelProvider: new FakeModelProvider(), secretStore: h.secretStore });
const previewDeps = (): PreviewDeps => ({
  db: h.db,
  jobs: h.jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: h.clock,
  adapters: adapters(),
  settings: { domain: null, localDefault: false, warmMinutes: 60, linkMaxDays: 7, replicaUrl: null },
});
const decideDeps = () => ({ db: h.db, jobs: h.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock, adapters: adapters() });
/** OpenCode's way, as core's registry has it: it reaches ostra's MCP server. */
const mcpSpecDeps = (): SpecDeps => ({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore, agentMemory: () => "mcp" });

const specOf = async (deps: SpecDeps, taskId: TaskId, minor: number) => {
  const built = await buildTaskSpec(deps, { taskId, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochOne, minor });
  if (!built.ok) throw new Error(built.message);
  return built.spec;
};

/** The environment's app processes as their rows hold them, in order. */
const rows = async () =>
  (await h.db.appProcess.findMany({ where: { projectId: h.world.projectId }, orderBy: { position: "asc" } })).map((row) => [row.name, row.port, row.primary, row.command]);

describe("F-140: the task spec", () => {
  it("F-140/c1,c3, F-121/c11: the environment's processes, its screenshots, a service's preview and the app tools go to a minor-7 runner, and none of it to a minor-6 one, whose task page says why", async () => {
    const environment = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } });
    await h.db.service.create({ data: { organizationId: h.world.organizationId, projectId: h.world.projectId, environmentId: environment.id, name: "mailpit", image: "axllent/mailpit:v1.20", port: 8025, variables: [] } });
    const web = { name: "web", repoId, command: "pnpm dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true } as const;
    const api = { name: "api", repoId, folder: "./api", command: "node server.js", port: 3001, ready: { kind: "port" }, label: "API" } as const;
    const save = {
      projectId: h.world.projectId,
      processes: [web, api],
      screenshots: { afterTurn: true, routes: ["/", "/settings"], widths: ["desktop", "phone"] },
      servicePreviews: { mailpit: "Mail" },
    } satisfies Parameters<typeof saveAppProcesses>[2];
    // A project admin saves them; a member can't, and a list that breaks a rule is refused in its words.
    expect(await saveAppProcesses(previewDeps(), member(), save)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await saveAppProcesses(previewDeps(), admin(), { ...save, processes: [web, { ...api, primary: true }] })).toMatchObject({ ok: false, error: "rule-broken", message: "At most one app process is the primary preview." });
    expect(await saveAppProcesses(previewDeps(), admin(), save)).toEqual({ ok: true, saved: 2 });
    const audit = await h.db.auditEntry.findFirstOrThrow({ where: { action: "environment.app-processes-saved" }, orderBy: { createdAt: "desc" } });
    expect(audit.data).toMatchObject({ processes: 2, added: "web,api" });
    expect(JSON.stringify(audit.data)).not.toContain("pnpm dev");

    const task = await seedTaskInCi(h);
    const at7 = await specOf(mcpSpecDeps(), task.taskId, 7);
    expect(at7.environment.appProcesses).toEqual([
      { name: "web", repoId, folder: ".", command: "pnpm dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true, hostRewrite: true },
      { name: "api", repoId, folder: "api", command: "node server.js", port: 3001, ready: { kind: "port" }, label: "API", primary: false, hostRewrite: true },
    ] satisfies TaskSpecAppProcess[]);
    expect(at7.environment.screenshots).toEqual({ afterTurn: true, routes: ["/", "/settings"], widths: ["desktop", "phone"] });
    expect(at7.services?.find((service) => service.name === "mailpit")?.preview).toEqual({ label: "Mail" });
    expect(at7.tools).toEqual(["pr-text", "memory", "app"]);
    // That spec is one a minor-6 runner is never offered.
    expect(isTaskOfferable(at7, 6)).toMatchObject({ offerable: false, reason: "app-processes", minMinor: 7 });

    // An agent that can't reach ostra's MCP server gets the processes and the screenshots, no tools.
    const plain = await specOf({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, task.taskId, 7);
    expect(plain.environment.appProcesses?.map((process) => process.name)).toEqual(["web", "api"]);
    expect(plain.tools).toBeUndefined();

    // A minor-6 runner runs the task as before: none of it, and nothing it can't take.
    const at6 = await specOf(mcpSpecDeps(), task.taskId, 6);
    expect(at6.environment.appProcesses).toBeUndefined();
    expect(at6.environment.screenshots).toBeUndefined();
    expect(at6.services?.find((service) => service.name === "mailpit")?.preview).toBeUndefined();
    expect(at6.tools).toBeUndefined();
    expect(isTaskOfferable(at6, 6)).toEqual({ offerable: true });
    expect(taskSpecSchemaV6.safeParse(encodeTaskSpecForMinor(at6, 6)).success).toBe(true);
    expect(taskSpecSchemaV6.safeParse(encodeTaskSpecForMinor(at7, 6)).success).toBe(true);
    // Its page says the runner needs upgrading for screenshots and previews; at minor 7 it doesn't.
    const ref = { id: task.taskId, organizationId: h.world.organizationId, projectId: h.world.projectId };
    expect(await taskAppSupport(h.db, ref)).toEqual({ kind: "runner-needs-upgrade", words: previewRefusalWords("runner-needs-upgrade") });
    await h.db.runnerPresence.update({ where: { runnerId: h.runner.runnerId }, data: { minor: 7 } });
    expect(await taskAppSupport(h.db, ref)).toEqual({ kind: "supported" });
    await h.db.service.deleteMany({ where: { environmentId: environment.id, name: "mailpit" } });
  });
});

describe("F-140: detection", () => {
  it("F-140/c7: detection over the test-web fixture lists web, api and docs with web as the primary, each marked detected until it's saved", async () => {
    const access = { app: { appId: APP_ID, privateKey: APP_PRIVATE_KEY }, installationId: INSTALLATION_ID, repo: REPO };
    const detected = await detectRepoEnvironment(h.codeHost, access, "main");
    expect(detected.appProcesses.map((process) => ({ name: process.name, port: process.port, primary: process.primary, command: process.command }))).toEqual([
      { name: "web", port: 5173, primary: true, command: "npm run dev" },
      { name: "api", port: 3001, primary: false, command: "npm run api" },
      { name: "docs", port: 4000, primary: false, command: "npm run docs" },
    ]);
    expect(detected.appProcesses.find((process) => process.name === "api")?.label).toBe("API");
    // The proxy's reason names the one origin it keeps.
    expect(detected.reasons).toContainEqual({ file: "vite.config.js", finding: "/api goes to port 3001 through the dev server's proxy: proposed as a process, with one origin kept" });
    // On the environment page: each one detected, until a project admin saves it.
    const listed = environmentAppProcessList([], [{ repoId, processes: detected.appProcesses }]);
    expect(listed.map((entry) => [entry.origin, entry.process.name])).toEqual([
      ["detected", "web"],
      ["detected", "api"],
      ["detected", "docs"],
    ]);
    const web = { name: "web", repoId, folder: ".", command: "npm run dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true, hostRewrite: true } as const;
    expect(environmentAppProcessList([web], [{ repoId, processes: detected.appProcesses }]).map((entry) => [entry.origin, entry.process.name])).toEqual([
      ["saved", "web"],
      ["detected", "api"],
      ["detected", "docs"],
    ]);
  });
});

/** The onboarding task leased to the harness's runner on a `docker` box; returns its task token. */
const lease = async (taskId: TaskId): Promise<string> => {
  const row = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const box = await h.db.box.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId, runnerId: h.runner.runnerId, executor: "docker", state: "ready" } });
  await h.db.lease.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId, epoch: 1, runnerId: h.runner.runnerId, boxId: box.id, state: "active" } });
  await h.db.task.update({ where: { id: taskId }, data: { state: "running", leaseEpoch: 1 } });
  await h.db.session.updateMany({ where: { taskId }, data: { boxId: box.id, state: "running" } });
  return gateway.gateway.context.taskTokens.issue({ organizationId: h.world.organizationId, taskId, leaseEpoch: leaseEpochSchema.parse(1), boxId: boxIdSchema.parse(box.id), runnerId: h.runner.runnerId });
};

const startOnboardingTask = async (): Promise<TaskId> => {
  const started = await startOnboarding({ db: h.db, jobs: h.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock, adapters: { codeHost: h.codeHost, secretStore: h.secretStore } }, admin(), { projectId: h.world.projectId });
  if (!started.ok) throw new Error(`onboarding didn't start: ${started.message}`);
  return started.taskId;
};

const propose = async (taskId: TaskId, token: string, body: EnvironmentProposal): Promise<EnvironmentProposalId> => {
  const answer = await postJson(`${gateway.url}${runnerPaths.taskEnvironmentProposal(taskId)}`, body, token);
  const parsed = environmentProposalResponseSchema.parse(answer.body);
  if (!("proposalId" in parsed)) throw new Error(`refused: ${parsed.code}`);
  return environmentProposalIdSchema.parse(parsed.proposalId);
};

const tested = (name: string, port: number, command: string, extra: Partial<TaskSpecAppProcess> = {}): TaskSpecAppProcess => ({
  name,
  repoId,
  folder: ".",
  command,
  port,
  ready: { kind: "port" },
  label: name === "api" ? "API" : `${name.charAt(0).toUpperCase()}${name.slice(1)}`,
  primary: false,
  hostRewrite: true,
  ...extra,
});

describe("F-140: onboarding", () => {
  it("F-140/c8: the onboarding task starts the detected processes, screenshots the primary, and its proposal's processes are accepted into the environment", async () => {
    // With no app process saved, the task tests what detection finds.
    const taskId = await startOnboardingTask();
    // The prompt: each detected process as data, start_app and the screenshot of the primary, the one-origin convention.
    const { prompt } = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(prompt).toContain('label="draft-app-process"');
    expect(prompt).toContain("web (Web, the primary preview)");
    expect(prompt).toContain("started with: npm run api");
    expect(prompt).toContain("start_app");
    expect(prompt).toContain("take_screenshot");
    expect(prompt).toContain("appProcesses");
    expect(prompt).toContain(ONE_ORIGIN_RULE);
    expect(prompt).toContain("absolute URL");

    // Its box gets the detected processes to start, with the app tools beside the proposal's.
    const token = await lease(taskId);
    const spec = await specOf(mcpSpecDeps(), taskId, 7);
    expect(spec.environment.appProcesses?.map((process) => [process.name, process.port, process.command, process.primary])).toEqual([
      ["web", 5173, "npm run dev", true],
      ["api", 3001, "npm run api", false],
      ["docs", 4000, "npm run docs", false],
    ]);
    expect(spec.tools).toEqual(["environment", "pr-text", "app"]);
    expect(spec.prompt).not.toContain(ONBOARDING_NO_APP_TOOLS_LINE);
    // A minor-6 runner's box has no app tools: the agent leaves the processes out.
    const old = await specOf(mcpSpecDeps(), taskId, 6);
    expect(old.prompt).toContain(ONBOARDING_NO_APP_TOOLS_LINE);
    expect(old.tools).toEqual(["environment", "pr-text"]);

    // The agent's turn through core's real ingest: it starts the declared processes in order, each
    // ready, and takes the primary's screenshot. The event log, the stored attachment and the
    // panel's own view all read the turn back, before any admin accepts the proposal.
    const session = await h.db.session.findFirstOrThrow({ where: { taskId } });
    const driven = drive(h.ingest, { taskId, sessionId: sessionIdSchema.parse(session.id), organizationId: h.world.organizationId }, h.runner, leaseEpochOne);
    const shot = await h.blobs.put(
      { organizationId: h.world.organizationId, task: { projectId: h.world.projectId, taskId } },
      { purpose: "app-screenshot", contentType: APP_SCREENSHOT_CONTENT_TYPE, bytes: pngBytes(512) },
    );
    if (!shot.ok) throw new Error(shot.message);
    const caption = "Web, ready, its /api answered";
    const turnId = turnIdSchema.parse("turn-onboarding");
    const testedProcesses = [
      { name: "web", port: 5173 },
      { name: "api", port: 3001 },
      { name: "docs", port: 4000 },
    ] as const;
    const turn: TaskEvent[] = [
      { kind: "turn.started", turnId },
      ...testedProcesses.flatMap(({ name, port }): TaskEvent[] => [
        { kind: "app.process", name, state: "starting", port, exitCode: null, reason: null, logBlobId: null },
        { kind: "app.process", name, state: "ready", port, exitCode: null, reason: null, logBlobId: null },
      ]),
      {
        kind: "attachment.added",
        attachmentId: attachmentIdSchema.parse("shot-primary"),
        attachmentKind: "screenshot",
        blobId: shot.value.blobId,
        source: "agent",
        target: { process: "web" },
        path: "/",
        width: 1440,
        height: 900,
        durationMs: null,
        frameCount: null,
        caption,
        browser: { name: "Chromium", version: "142.0.7444.59" },
        memberId: null,
        requestId: null,
      },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
    ];
    await driven.send(...turn);
    // The event view: each process's starting and ready, in the list's order.
    const processEvent = z.object({ name: z.string(), state: z.string() });
    const storedEvents = await h.db.event.findMany({ where: { taskId, kind: "app.process" }, orderBy: { seq: "asc" }, select: { payload: true } });
    expect(storedEvents.map((row) => { const parsed = processEvent.parse(row.payload); return [parsed.name, parsed.state]; })).toEqual([
      ["web", "starting"],
      ["web", "ready"],
      ["api", "starting"],
      ["api", "ready"],
      ["docs", "starting"],
      ["docs", "ready"],
    ]);
    // The screenshot, stored: its row names what it shows, and its blob holds the bytes.
    const attachment = await h.db.taskAttachment.findFirstOrThrow({ where: { taskId, attachmentId: attachmentIdSchema.parse("shot-primary") } });
    expect(attachment).toMatchObject({ kind: "screenshot", blobId: shot.value.blobId, targetKind: "process", targetName: "web", path: "/", caption });
    expect(await h.db.blob.findFirstOrThrow({ where: { id: shot.value.blobId, taskId }, select: { purpose: true, size: true } })).toEqual({ purpose: "app-screenshot", size: 512 });
    expect(JSON.stringify(h.records)).not.toContain(caption);

    // A command holding a secret's value is refused, as a script is.
    const base: EnvironmentProposal = { repos: [{ repoId, setupScript: "npm install", checks: [], variableNames: [] }], services: [], notes: "The frontend calls /api through Vite's proxy." };
    const leaked = await postJson(`${gateway.url}${runnerPaths.taskEnvironmentProposal(taskId)}`, { ...base, appProcesses: [tested("api", 3001, `API_SECRET=${ENV_SECRET} npm run api`)] }, token);
    expect(environmentProposalResponseSchema.parse(leaked.body)).toEqual({ code: "secret-found", found: ["one of the organization's secrets"] });

    // The admin had declared a frontend on 5173 and Storybook; the tested processes come in.
    await saveAppProcesses(previewDeps(), admin(), {
      projectId: h.world.projectId,
      processes: [
        { name: "frontend", repoId, command: "vite", port: 5173, ready: { kind: "port" }, label: "Frontend", primary: true },
        { name: "storybook", repoId, command: "storybook dev -p 6006", port: 6006, ready: { kind: "port" }, label: "Storybook" },
      ],
      screenshots: { afterTurn: true, routes: ["/"], widths: ["desktop"] },
      servicePreviews: {},
    });
    const proposalId = await propose(taskId, token, {
      ...base,
      appProcesses: [tested("web", 5173, "npm run dev", { ready: { kind: "http", path: "/" }, primary: true }), tested("api", 3001, "npm run api"), tested("docs", 4000, "npm run docs")],
    });
    const stored = await h.db.environmentProposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(stored.source).toBe("onboarding");
    expect(environmentProposalSchema.parse(stored.body).appProcesses?.map((process) => process.name)).toEqual(["web", "api", "docs"]);

    // The panel's own view, on the same rows: the processes it tested, and the screenshot the task
    // took of the primary, downloadable from the task, before an admin has accepted anything.
    const projectId = projectIdSchema.parse(h.world.projectId);
    const caller = await api.as(h.fixture.a.admin);
    const view = await caller.environments.proposal({ projectId });
    expect(view?.appProcesses.proposed.map((process) => [process.name, process.port])).toEqual([
      ["web", 5173],
      ["api", 3001],
      ["docs", 4000],
    ]);
    expect(view?.screenshot).toMatchObject({
      attachmentId: attachment.attachmentId,
      kind: "screenshot",
      target: { kind: "process", name: "web" },
      width: 1440,
      height: 900,
      path: "/",
      caption,
    });
    expect(view?.screenshot?.downloadPath).toBe(`/api/tasks/${taskId}/attachments/${attachment.attachmentId}`);

    const accepted = await decideEnvironmentProposal(decideDeps(), admin(), { proposalId, decision: { kind: "accept", edited: null } });
    expect(accepted).toMatchObject({ ok: true });
    // Web takes the frontend's place (same port), Storybook stays without the primary, API and Docs are added.
    expect(await rows()).toEqual([
      ["web", 5173, true, "npm run dev"],
      ["storybook", 6006, false, "storybook dev -p 6006"],
      ["api", 3001, false, "npm run api"],
      ["docs", 4000, false, "npm run docs"],
    ]);
    const environment = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } });
    expect(environment.setupScript).toBe("npm install");
    const entry = await h.db.auditEntry.findFirstOrThrow({ where: { action: "environment.proposal-accepted" }, orderBy: { createdAt: "desc" } });
    expect(entry.data).toMatchObject({ proposalId, appProcesses: 3, source: "onboarding" });
    // The environment page's view of a saved process reads the turn's newest event: web got ready.
    const listed = await caller.environments.appProcesses.list({ projectId });
    expect(listed.processes.find((process) => process.name === "web")?.lastBox).toMatchObject({ state: "ready", taskId, exitCode: null, reason: null });
    expect(JSON.stringify(h.records)).not.toContain("npm run docs");
  });
});

describe("F-140: Keep it", () => {
  it("F-140/c9: a port the agent announced becomes a proposal with that one process, for a project admin, and Accept adds it alone once its command is named", async () => {
    const task = await seedTaskInCi(h);
    const announced = (port: number, label: string) => ({ key: previewKeySchema.parse(`port-${String(port)}`), target: { port }, port, label, primary: false, path: "/", source: "announced" as const });
    await task.driven.send(
      { kind: "turn.started", turnId: turnIdSchema.parse("turn-keep") },
      {
        kind: "preview.list",
        previews: [
          { key: previewKeySchema.parse("app-web"), target: { process: "web" }, port: 5173, label: "Web", primary: true, path: "/", source: "declared" },
          announced(4100, "Docs"),
          announced(4200, "Admin"),
        ],
      },
    );
    // The announced ports are the task's rows; the declared one is the environment's.
    expect((await h.db.taskPreview.findMany({ where: { taskId: task.taskId }, orderBy: { port: "asc" } })).map((row) => [row.key, row.label])).toEqual([
      ["port-4100", "Docs"],
      ["port-4200", "Admin"],
    ]);
    const before = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId }, include: { checks: true } });

    const key = previewKeySchema.parse("port-4100");
    expect(await proposeAppProcess(previewDeps(), outsider(), { taskId: task.taskId, key })).toMatchObject({ ok: false, error: "not-found" });
    expect(await proposeAppProcess(previewDeps(), member(), { taskId: task.taskId, key: previewKeySchema.parse("port-4300") })).toMatchObject({ ok: false, error: "not-announced" });
    const kept = await proposeAppProcess(previewDeps(), member(), { taskId: task.taskId, key });
    if (!kept.ok) throw new Error(kept.message);
    expect(await proposeAppProcess(previewDeps(), member(), { taskId: task.taskId, key })).toMatchObject({ ok: false, error: "already-kept" });

    const proposal = await h.db.environmentProposal.findUniqueOrThrow({ where: { id: kept.proposalId } });
    expect(proposal).toMatchObject({ source: "kept", state: "proposed", taskId: task.taskId });
    const body = environmentProposalSchema.parse(proposal.body);
    expect(body.appProcesses).toEqual([tested("docs", 4100, KEPT_COMMAND_PLACEHOLDER)]);
    expect(proposal.notes).toContain("Kept from a task");
    expect((await h.db.taskPreview.findFirstOrThrow({ where: { taskId: task.taskId, key } })).keptProposalId).toBe(kept.proposalId);
    expect(await h.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "environment_proposal", state: "open" } })).toMatchObject({ audience: "project_members" });
    expect(await h.db.auditEntry.count({ where: { action: "environment.app-process-kept", actorId: h.fixture.a.member.id } })).toBe(1);

    // A fresh box's list no longer has the agent's ports: the kept one stays, the other goes.
    await task.driven.send({ kind: "preview.list", previews: [] });
    expect((await h.db.taskPreview.findMany({ where: { taskId: task.taskId } })).map((row) => row.key)).toEqual(["port-4100"]);

    // "Accept" as it is: its command isn't named yet. "Edit and accept" names it, and only the process changes.
    expect(await decideEnvironmentProposal(decideDeps(), admin(), { proposalId: kept.proposalId, decision: { kind: "accept", edited: null } })).toMatchObject({ ok: false, error: "invalid-input", message: "Name the command that starts Docs first: edit the proposal, then accept it." });
    const edited: EnvironmentProposal = { ...body, appProcesses: [tested("docs", 4100, "npm run docs -- --port 4100")] };
    expect(await decideEnvironmentProposal(decideDeps(), member(), { proposalId: kept.proposalId, decision: { kind: "accept", edited } })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await decideEnvironmentProposal(decideDeps(), admin(), { proposalId: kept.proposalId, decision: { kind: "accept", edited } })).toMatchObject({ ok: true });
    expect(await rows()).toEqual([["docs", 4100, false, "npm run docs -- --port 4100"]]);
    const after = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId }, include: { checks: true } });
    expect(after.setupScript).toBe(before.setupScript);
    expect(after.checks.map((check) => check.name)).toEqual(before.checks.map((check) => check.name));
    // A process changes what runs after the setup, not the setup: the snapshot stands.
    expect(h.jobs.jobs.filter((job) => job.job === "snapshot.schedule")).toEqual([]);
    expect(taskIdSchema.parse(proposal.taskId)).toBe(task.taskId);
  });
});
