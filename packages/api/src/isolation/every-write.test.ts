import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import { Prisma } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import {
  agentProfileIdSchema,
  clientMessageIdSchema,
  repoFullNameSchema,
  repoIdSchema,
} from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appRouter } from "../routers/app-router.ts";
import {
  createApiHarness,
  seedConnectionAndModel,
  seedLease,
  seedLinearConnection,
  seedPersonalRunner,
  seedPreviewableTask,
  seedProject,
  trpcFailure,
} from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// Milestone 4, ticket 41 (F-003, F-087; ADR 0026, ADR 0053): the write side of the role matrix.
// Ticket 09's suite (`every-record.test.ts`) calls every query procedure as every role; this one
// takes the writes the two "done when"s name. Every write of the organization's members,
// connections, model providers, runner pools, agent profiles, budgets and projects is called as an
// organization member and as a project admin, and refused, and as an organization admin, and let
// through; a guard fails on a new write in those routers that the list doesn't name. Then a
// project admin edits its project's repos, boards, environment, automations, memory and defaults,
// and a project member is refused each. And members, not only admins, start, drive, steer and
// reopen tasks, and every member who can open the project sees each task and its conversation:
// there is no private task.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

let unique = 0;
const label = (prefix: string) => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

/** A new account and membership in organization A, with the organization role `member` unless said. */
const seedMember = async (role: "admin" | "member" = "member"): Promise<SeededMember> => {
  const name = label("person");
  const user = await harness.test.db.user.create({
    data: { id: randomUUID(), name, email: `${name}@example.com`, username: name },
  });
  return mapMember(
    await harness.test.db.member.create({
      data: {
        id: randomUUID(),
        organizationId: harness.fixture.a.organization.id,
        userId: user.id,
        role,
        createdAt: new Date(),
      },
    }),
  );
};

/** A restricted project on `ostra-test/test1`, with a project admin and two project members listed, none of them an organization admin. */
const restrictedProject = async (slug: string) => {
  const { projectId } = await seedProject(harness, world, label(slug));
  const admin = await harness.as(harness.fixture.a.admin);
  await admin.projects.setAccess({ projectId, access: "restricted" });
  const projectAdmin = await seedMember();
  const driver = await seedMember();
  const colleague = await seedMember();
  await admin.projects.setMember({ projectId, memberId: projectAdmin.id, role: "admin" });
  await admin.projects.setMember({ projectId, memberId: driver.id, role: "member" });
  await admin.projects.setMember({ projectId, memberId: colleague.id, role: "member" });
  return { projectId, projectAdmin, driver, colleague };
};

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

const callPath = (caller: AppCaller, path: string, input: unknown): Promise<unknown> => {
  let target: unknown = caller;
  for (const part of path.split(".")) {
    target = Reflect.get(Object(target), part);
  }
  if (typeof target !== "function") {
    throw new Error(`no procedure ${path}`);
  }
  return Promise.resolve(Reflect.apply(target, undefined, [input]));
};

/** What a call ends in: `ok`, a tRPC error's code, or another error's name. */
const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    return error instanceof Error ? `error ${error.name}` : "error";
  }
};

/** The panel's mutation procedures, read from the router itself. */
const mutationPaths = (): readonly string[] =>
  Object.entries(appRouter._def.procedures)
    .filter(
      ([, procedure]) =>
        Reflect.get(Object(Reflect.get(Object(procedure), "_def")), "type") === "mutation",
    )
    .map(([path]) => path)
    .sort();

/**
 * The writes of F-003's second sentence, by what they manage. Every one is an organization admin's.
 * `runners.revoke` isn't here: a member revokes their own personal runner (F-016), and an
 * organization admin any (its own tests, `runners-revoke.test.ts`).
 */
const ORGANIZATION_ADMIN_WRITES: Readonly<Record<string, readonly string[]>> = {
  members: [
    "members.invite",
    "members.remove",
    "members.revokeInvitation",
    "members.setRole",
    "organization.setMemberRole",
  ],
  connections: [
    "github.completeManifest",
    "github.connectExisting",
    "github.createApp",
    "github.linkInstallation",
    "github.removeInstallation",
    "github.setClientSecret",
    "github.startManifest",
    "github.unlinkInstallation",
    "linear.authorizeUrl",
    "linear.complete",
    "linear.disconnect",
    // Milestone 6 (F-012, ticket 26): turning on agent mode is the install's consent, an organization admin's.
    "linear.enableAgentMode",
    "linear.saveApp",
    "linear.start",
  ],
  "model providers": [
    "providers.chooseDefaultModelProvider",
    "providers.confirmChoice",
    "providers.create",
    "providers.refresh",
    "providers.setDefaultList",
    "providers.setModelPrice",
    "providers.testConnection",
    "providers.update",
    "providers.updateModel",
  ],
  "runner pools": [
    "joinTokens.create",
    "joinTokens.revoke",
    "pools.create",
    "pools.createJoinToken",
    "pools.revokeJoinToken",
    "pools.update",
    "runners.approve",
    "runners.drain",
    "runners.reject",
    "runners.resume",
  ],
  "agent profiles": [
    "agentProfiles.archive",
    "agentProfiles.save",
    "agentProfiles.setDefaultModel",
    "agentProfiles.setRunnerLabels",
  ],
  budgets: ["budgets.clear", "budgets.set"],
  // Milestone 6 (F-040, ticket 26): whether a project's outside tasks wait for approval is an organization admin's switch.
  projects: ["projects.create", "projects.setOutsideApproval"],
};

/**
 * Writes in the admin routers that are a project admin's, with their own tests: "Start from Linear"
 * on a board (F-012, ticket 26: `agent-mode-approvals.test.ts`).
 */
const PROJECT_ADMIN_WRITES_IN_ADMIN_ROUTERS: readonly string[] = ["linear.setBoardAgentMode"];

/** The routers whose every write is an organization admin's: a new one fails the guard until it's listed above. */
const ADMIN_ROUTERS: readonly string[] = [
  "agentProfiles",
  "budgets",
  "github",
  "joinTokens",
  "linear",
  "members",
  "pools",
  "providers",
];

describe("an organization admin manages the organization (F-003)", () => {
  it("F-003/c2: every write of members, connections, model providers, runner pools, agent profiles, budgets and projects refuses an organization member and a project admin, and lets an organization admin through", async () => {
    const listed = Object.values(ORGANIZATION_ADMIN_WRITES).flat();
    const paths = mutationPaths();
    // The guard: the list names only writes that exist, and every write of the admin routers.
    expect(listed.filter((path) => !paths.includes(path))).toEqual([]);
    expect(
      paths.filter(
        (path) => ADMIN_ROUTERS.includes(path.split(".")[0] ?? "") && !listed.includes(path) && !PROJECT_ADMIN_WRITES_IN_ADMIN_ROUTERS.includes(path),
      ),
    ).toEqual([]);

    const { projectAdmin } = await restrictedProject("admin-writes");
    const refusedAs = {
      "organization member": harness.fixture.a.member,
      "project admin": projectAdmin,
    };
    // The refusal comes before the input is read: a call with no input is refused the same way.
    const seen: string[] = [];
    const wanted: string[] = [];
    for (const [who, member] of Object.entries(refusedAs)) {
      const caller = await harness.as(member);
      for (const path of listed) {
        seen.push(`${path} as ${who}: ${await outcomeOf(() => callPath(caller, path, undefined))}`);
        wanted.push(`${path} as ${who}: FORBIDDEN`);
      }
    }
    expect(seen).toEqual(wanted);
    // The organization admin passes the role check: with no input, the call fails only on its input.
    const admin = await harness.as(harness.fixture.a.admin);
    const blocked: string[] = [];
    for (const path of listed) {
      const outcome = await outcomeOf(() => callPath(admin, path, undefined));
      if (outcome === "FORBIDDEN" || outcome === "UNAUTHORIZED") {
        blocked.push(`${path}: ${outcome}`);
      }
    }
    expect(blocked).toEqual([]);
  });

  it("F-003/c2: an organization admin invites a member, starts a connection, adds a model provider, a runner pool, an agent profile, a budget and a project", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const member = await harness.as(a.member);
    const organizationId = a.organization.id;
    const email = `${label("invitee")}@example.com`;
    const providerInput = {
      name: label("Provider"),
      baseUrl: "https://models.example.com/v1",
      apiFormat: "anthropic-messages" as const,
      authScheme: "x-api-key" as const,
      sessionsAtOnce: null,
      allowOnPersonalRunners: false,
      token: "sk-world-model-token-0123456789abcdef",
    };
    const profileInput = {
      name: label("Profile"),
      adapter: "opencode",
      modelId: world.modelId,
      instructions: null,
      approvalRules: [],
      planFirst: false,
      access: { kind: "everyone" as const },
      mcpServers: [],
      skills: [],
    };
    const slug = label("made");
    const projectInput = {
      name: slug,
      slug,
      access: "open" as const,
      repo: {
        connectionId: world.connectionId,
        installationId: world.installationId,
        fullName: repoFullNameSchema.parse("ostra-test/test1"),
      },
    };
    const poolName = label("pool");

    // The member's same calls are refused, and change nothing.
    for (const call of [
      () => member.members.invite({ email, role: "member", projectGrants: [] }),
      () => member.linear.start(),
      () => member.providers.create(providerInput),
      () => member.pools.create({ name: poolName }),
      () => member.agentProfiles.save(profileInput),
      () => member.budgets.set({ projectId: a.openProject.id, monthlyUsd: 25 }),
      () => member.projects.create(projectInput),
    ]) {
      expect(await trpcFailure(call())).toMatchObject({ code: "FORBIDDEN" });
    }
    const counts = async () => ({
      invitations: await harness.test.db.invitation.count({ where: { organizationId } }),
      providers: await harness.test.db.modelProvider.count({ where: { organizationId } }),
      pools: await harness.test.db.runnerPool.count({ where: { organizationId } }),
      profiles: await harness.test.db.agentProfile.count({ where: { organizationId } }),
      budgets: await harness.test.db.budget.count({ where: { organizationId } }),
      projects: await harness.test.db.project.count({ where: { organizationId } }),
    });
    const before = await counts();

    // The admin's go through, each one row more.
    await admin.members.invite({ email, role: "member", projectGrants: [] });
    // A connection starts pending until its app is saved and authorized (`linear.test.ts`). The
    // first case's call started it already; this one goes on with that connection.
    const started = await admin.linear.start();
    expect(
      await harness.test.db.connection.findUniqueOrThrow({ where: { id: started.connectionId } }),
    ).toMatchObject({ organizationId, kind: "linear" });
    await admin.providers.create(providerInput);
    await admin.pools.create({ name: poolName });
    await admin.agentProfiles.save(profileInput);
    await admin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 25 });
    await admin.projects.create(projectInput);
    const after = await counts();
    expect(after).toEqual({
      invitations: before.invitations + 1,
      providers: before.providers + 1,
      pools: before.pools + 1,
      profiles: before.profiles + 1,
      budgets: before.budgets + 1,
      projects: before.projects + 1,
    });
  });
});

describe("a project admin manages its project (F-003, F-087)", () => {
  it("F-003/c3, F-087/c2: a project admin edits its repos, boards, environment, automations, memory and defaults, and a project member of it is refused each", async () => {
    const { projectId, projectAdmin, driver } = await restrictedProject("project-admin");
    const organizationId = harness.fixture.a.organization.id;
    const asAdmin = await harness.as(projectAdmin);
    const asMember = await harness.as(driver);
    // An active tracker connection (the harness's tracker fake): the cases above only started one, which a board can't use yet.
    await harness.test.db.connection.deleteMany({
      where: { organizationId, kind: "linear", state: { not: "active" } },
    });
    if (
      (await harness.test.db.connection.count({ where: { organizationId, kind: "linear" } })) === 0
    ) {
      await seedLinearConnection(harness);
    }
    const [team] = await asAdmin.boards.available({ projectId });
    if (team === undefined) {
      throw new Error("the tracker fake lists no team");
    }
    const repoIds = (
      await harness.test.db.repo.findMany({ where: { projectId }, select: { id: true } })
    ).map((row) => repoIdSchema.parse(row.id));
    const builtIn = await harness.test.db.agentProfile.findFirstOrThrow({
      where: { organizationId, builtIn: true },
      select: { id: true },
    });
    const profileId = agentProfileIdSchema.parse(builtIn.id);
    const environment = {
      baseImage: null,
      setupScript: "corepack enable\n",
      envFiles: [],
      entries: [],
    };
    const rule = {
      kind: "intake_rule" as const,
      name: label("Bugs in"),
      taskKind: "code" as const,
      agentProfileId: null,
      poolLabels: [],
      requireApproval: false,
      filter: { labels: { mode: "any" as const, names: ["bug"] } },
    };
    const edits: readonly (readonly [string, (caller: AppCaller) => Promise<unknown>])[] = [
      ["repos", (caller) => caller.projects.reorderRepos({ projectId, repoIds })],
      ["boards", (caller) => caller.boards.attach({ projectId, teamExternalId: team.externalId })],
      ["environment", (caller) => caller.environments.save({ projectId, environment })],
      ["automations", (caller) => caller.automations.create({ projectId, settings: rule })],
      [
        "defaults",
        (caller) => caller.projects.setDefaultProfile({ projectId, kind: "code", profileId }),
      ],
    ];
    const asMemberSeen: string[] = [];
    const asAdminSeen: string[] = [];
    for (const [what, edit] of edits) {
      asMemberSeen.push(`${what}: ${await outcomeOf(() => edit(asMember))}`);
    }
    // Nothing the member tried is there.
    expect(await harness.test.db.automation.count({ where: { projectId } })).toBe(0);
    expect(await harness.test.db.board.count({ where: { projectId } })).toBe(0);
    for (const [what, edit] of edits) {
      asAdminSeen.push(`${what}: ${await outcomeOf(() => edit(asAdmin))}`);
    }
    expect(asMemberSeen).toEqual(edits.map(([what]) => `${what}: FORBIDDEN`));
    expect(asAdminSeen).toEqual(edits.map(([what]) => `${what}: ok`));
    expect(await harness.test.db.automation.count({ where: { projectId } })).toBe(1);
    expect(await harness.test.db.board.count({ where: { projectId, detachedAt: null } })).toBe(1);
    expect(await asMember.environments.get({ projectId })).toMatchObject({
      status: "saved",
      setupScript: "corepack enable\n",
    });

    // Memory: a project member writes the project's notes; the project admin edits and archives anyone's, and the member can't archive the admin's.
    const note = { scope: "project" as const, projectId, kind: "command" as const, always: false };
    const written = await asMember.memory.save({
      ...note,
      noteId: null,
      expectedVersion: null,
      title: "Run the tests",
      body: "pnpm test",
    });
    const edited = await asAdmin.memory.save({
      ...note,
      noteId: written.noteId,
      expectedVersion: written.version,
      title: "Run the tests",
      body: "pnpm test --run",
    });
    expect(edited.version).toBe(written.version + 1);
    const adminsNote = await asAdmin.memory.save({
      ...note,
      noteId: null,
      expectedVersion: null,
      title: "Deploy",
      body: "pnpm deploy",
    });
    expect(await trpcFailure(asMember.memory.archive({ noteId: adminsNote.noteId }))).toMatchObject(
      { code: "FORBIDDEN" },
    );
    await asAdmin.memory.archive({ noteId: written.noteId });
    expect(
      (await harness.test.db.memoryNote.findUniqueOrThrow({ where: { id: written.noteId } }))
        .status,
    ).toBe("archived");
  });
});

describe("members work tasks, and no task is private (F-003, F-087)", () => {
  it("F-003/c4, F-087/c3: a project member who is no admin starts a task, drives and steers it, a colleague takes it over and stops it, and the first reopens it", async () => {
    const { projectId, driver, colleague } = await restrictedProject("members-work");
    const asDriver = await harness.as(driver);
    const asColleague = await harness.as(colleague);
    const created = await asDriver.tasks.create({ projectId, prompt: "Add a CONTRIBUTING.md" });
    expect(
      await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } }),
    ).toMatchObject({ creatorMemberId: driver.id, driverMemberId: driver.id });

    // The runner took it: the driver steers it, and the colleague, a watcher, takes it over.
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, label("runner"));
    await harness.test.db.task.update({
      where: { id: created.taskId },
      data: { state: "running" },
    });
    await harness.test.db.session.update({
      where: { id: created.sessionId },
      data: { state: "running" },
    });
    await seedLease(
      harness,
      { taskId: created.taskId, sessionId: created.sessionId },
      harness.fixture.a.organization.id,
      projectId,
      runnerId,
    );
    harness.fakes.outbox.clear();
    await asDriver.tasks.send({
      taskId: created.taskId,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      text: "Also say how to run the tests",
    });
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId, kind: "steer" }]);
    expect(await asColleague.tasks.takeOver({ taskId: created.taskId })).toEqual({
      driver: colleague.id,
      changed: true,
    });
    expect(await asColleague.tasks.stop({ taskId: created.taskId })).toEqual({ stopped: true });

    // The first member reopens it with a message, and drives again.
    await asDriver.tasks.reopen({
      taskId: created.taskId,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      text: "Also link it from the README",
    });
    expect(
      await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } }),
    ).toMatchObject({ state: "queued", driverMemberId: driver.id });
  });

  it("F-003/c4,c5, F-087/c3: every member who can open the project sees each task and its conversation; nobody else does, and a task can't be made private", async () => {
    const { projectId, projectAdmin, driver, colleague } = await restrictedProject("no-private");
    const created = await (
      await harness.as(driver)
    ).tasks.create({ projectId, prompt: "Rename the helper" });
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, label("runner"));
    await harness.test.db.task.update({
      where: { id: created.taskId },
      data: { state: "running" },
    });
    await seedLease(
      harness,
      { taskId: created.taskId, sessionId: created.sessionId },
      harness.fixture.a.organization.id,
      projectId,
      runnerId,
    );
    const text = `Keep the old name as an alias ${randomUUID()}`;
    await (
      await harness.as(driver)
    ).tasks.send({
      taskId: created.taskId,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      text,
    });

    for (const reader of [colleague, projectAdmin, harness.fixture.a.admin]) {
      const caller = await harness.as(reader);
      const listed = await caller.tasks.list({ projectId });
      expect(JSON.stringify(listed)).toContain(created.taskId);
      expect(await caller.tasks.get({ taskId: created.taskId })).toMatchObject({
        id: created.taskId,
      });
      // The conversation too: the prompt and the driver's message.
      const history = JSON.stringify(await caller.tasks.history({ taskId: created.taskId }));
      expect(history).toContain(text);
    }
    // An organization member the project doesn't list, and another organization, see none of it.
    for (const outsider of [harness.fixture.a.member, harness.fixture.b.admin]) {
      expect(
        await trpcFailure((await harness.as(outsider)).tasks.get({ taskId: created.taskId })),
      ).toMatchObject({ code: "NOT_FOUND" });
    }
    // There is no private task in v1: no column says so, and `tasks.create` refuses a field for it.
    expect(
      Object.keys(Prisma.TaskScalarFieldEnum).filter((field) =>
        /private|visib|hidden/i.test(field),
      ),
    ).toEqual([]);
    const projectIdOnly: { projectId: ProjectId } = { projectId };
    expect(
      await trpcFailure(
        callPath(await harness.as(driver), "tasks.create", {
          ...projectIdOnly,
          prompt: "Mine alone",
          private: true,
        }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------- previews (milestone 8, F-142) ----------

describe("a preview's writes, by each kind of viewer (F-142)", () => {
  /** Who calls: the organization's admin, the project's member, a person the preview names, an organization member the project doesn't list, another organization's admin, and a link's holder (signed out). */
  type Viewer = "organization admin" | "project member" | "named person" | "outsider" | "another organization" | "link";
  const viewers: readonly Viewer[] = ["organization admin", "project member", "named person", "outsider", "another organization", "link"];

  it("F-142/c3: every write of a task's previews gives each viewer what the table says: a named person opens the preview and keeps their own view, and every other write of the task refuses them", async () => {
    const { projectId, driver } = await restrictedProject("preview-writes");
    const organizationId = harness.fixture.a.organization.id;
    const named = await seedMember();
    const outsider = await seedMember();
    const callerOf = async (viewer: Viewer): Promise<AppCaller> => {
      switch (viewer) {
        case "organization admin":
          return harness.as(harness.fixture.a.admin);
        case "project member":
          return harness.as(driver);
        case "named person":
          return harness.as(named);
        case "outsider":
          return harness.as(outsider);
        case "another organization":
          return harness.as(harness.fixture.b.admin);
        case "link":
          return harness.anonymous();
        default:
          return viewer satisfies never;
      }
    };
    /** A fresh task for each call, whose preview names the named person, with a view and a link of the project member's. */
    const fresh = async () => {
      const task = await seedPreviewableTask(harness, { organizationId, projectId, ownerMemberId: harness.fixture.a.admin.id, driverMemberId: driver.id });
      const asDriver = await harness.as(driver);
      await asDriver.previews.setLevel({ taskId: task.taskId, key: task.key, level: "named", memberIds: [named.id] });
      const view = await asDriver.previews.open({ taskId: task.taskId, key: task.key });
      const link = await asDriver.previews.createLink({ taskId: task.taskId, key: task.key, kind: "expiring", allowInput: false, expiresInHours: null });
      if (!view.ok || !link.ok) {
        throw new Error("the task's view or link didn't open");
      }
      return { task, viewId: view.viewId, linkId: link.linkId };
    };
    type Fresh = Awaited<ReturnType<typeof fresh>>;
    const writes: Readonly<Record<string, (caller: AppCaller, at: Fresh) => Promise<unknown>>> = {
      "previews.open": (caller, at) => caller.previews.open({ taskId: at.task.taskId, key: at.task.key }),
      // On the project member's own view: nobody else's to beat or close.
      "previews.heartbeat": (caller, at) => caller.previews.heartbeat({ viewId: at.viewId }),
      "previews.close": (caller, at) => caller.previews.close({ viewId: at.viewId }),
      "previews.startApp": (caller, at) => caller.previews.startApp({ taskId: at.task.taskId }),
      "previews.takeScreenshot": (caller, at) => caller.previews.takeScreenshot({ taskId: at.task.taskId, key: at.task.key, path: "/", width: "desktop" }),
      "previews.setLevel": (caller, at) => caller.previews.setLevel({ taskId: at.task.taskId, key: at.task.key, level: "members", memberIds: [] }),
      "previews.createLink": (caller, at) => caller.previews.createLink({ taskId: at.task.taskId, key: at.task.key, kind: "expiring", allowInput: true, expiresInHours: 1 }),
      "previews.revokeLink": (caller, at) => caller.previews.revokeLink({ linkId: at.linkId }),
      // Each organization admin, for their own organization only.
      "organization.setPublicPreviewLinks": (caller) => caller.organization.setPublicPreviewLinks({ enabled: false }),
      // The task's own writes: the named person is no member of the project.
      "tasks.send": (caller, at) => caller.tasks.send({ taskId: at.task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Also add a footer" }),
      "tasks.stop": (caller, at) => caller.tasks.stop({ taskId: at.task.taskId }),
      "tasks.takeOver": (caller, at) => caller.tasks.takeOver({ taskId: at.task.taskId }),
      "tasks.interrupt": (caller, at) => caller.tasks.interrupt({ taskId: at.task.taskId }),
    };
    const outsiders = { outsider: "NOT_FOUND", "another organization": "NOT_FOUND", link: "UNAUTHORIZED" } as const;
    const members = { "organization admin": "ok", "project member": "ok", "named person": "NOT_FOUND", ...outsiders } as const;
    const table: Readonly<Record<string, Readonly<Record<Viewer, string>>>> = {
      "previews.open": { ...members, "named person": "ok" },
      "previews.heartbeat": { ...members, "organization admin": "NOT_FOUND" },
      "previews.close": { ...members, "organization admin": "NOT_FOUND" },
      "previews.startApp": members,
      "previews.takeScreenshot": members,
      "previews.setLevel": members,
      "previews.createLink": members,
      "previews.revokeLink": members,
      "organization.setPublicPreviewLinks": { "organization admin": "ok", "project member": "FORBIDDEN", "named person": "FORBIDDEN", outsider: "FORBIDDEN", "another organization": "ok", link: "UNAUTHORIZED" },
      // Only the task's driver steers it or interrupts it; anyone who can open it may stop it or take it over.
      "tasks.send": { ...members, "organization admin": "FORBIDDEN" },
      "tasks.stop": members,
      "tasks.takeOver": members,
      "tasks.interrupt": { ...members, "organization admin": "FORBIDDEN" },
    };
    // The guard: every member write of the previews router has a row.
    expect(mutationPaths().filter((path) => path.startsWith("previews.") && !path.startsWith("previews.link.") && !Object.hasOwn(writes, path))).toEqual([]);
    const seen: Record<string, Record<string, string>> = {};
    for (const [path, write] of Object.entries(writes)) {
      const row: Record<string, string> = {};
      for (const viewer of viewers) {
        const at = await fresh();
        const caller = await callerOf(viewer);
        row[viewer] = await outcomeOf(() => write(caller, at));
      }
      seen[path] = row;
    }
    expect(seen).toEqual(table);
    // A refused write changed nothing: no link is the named person's or the outsider's.
    const links = await harness.test.db.previewLink.findMany({ where: { projectId }, select: { createdByMemberId: true } });
    expect(links.filter((link) => link.createdByMemberId === named.id || link.createdByMemberId === outsider.id)).toEqual([]);
    // Another organization's admin changed their own organization's switch, never this one's.
    expect((await harness.test.db.organizationSetting.findUnique({ where: { organizationId } }))?.publicPreviewLinks ?? false).toBe(false);
  });

  it("F-142/c3: a link's holder reaches only the viewer page's procedures, and only with the link's own token", async () => {
    const { projectId, driver } = await restrictedProject("preview-link");
    const task = await seedPreviewableTask(harness, { organizationId: harness.fixture.a.organization.id, projectId, ownerMemberId: harness.fixture.a.admin.id, driverMemberId: driver.id });
    const asDriver = await harness.as(driver);
    const mine = await asDriver.previews.createLink({ taskId: task.taskId, key: task.key, kind: "expiring", allowInput: false, expiresInHours: null });
    const other = await asDriver.previews.createLink({ taskId: task.taskId, key: task.key, kind: "expiring", allowInput: false, expiresInHours: null });
    if (!mine.ok || !other.ok) {
      throw new Error("no links");
    }
    const token = (url: string): string => url.split("/p/")[1] ?? "";
    const visitor = harness.callerFor({ deps: harness.deps, headers: new Headers({ "x-forwarded-for": "198.51.100.7" }), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });
    const page = await visitor.previews.link.open({ token: token(mine.url) });
    if (page.state !== "live") {
      throw new Error(`the link opened ${page.state}`);
    }
    // Its own view: beaten and closed with its own token, never with another link's.
    expect(await visitor.previews.link.heartbeat({ token: token(other.url), viewId: page.viewId })).toEqual({ state: "unknown" });
    expect(await visitor.previews.link.close({ token: token(other.url), viewId: page.viewId })).toEqual({ state: "unknown" });
    expect(await visitor.previews.link.heartbeat({ token: token(mine.url), viewId: page.viewId })).toEqual({ state: "opening" });
    expect(await visitor.previews.link.close({ token: token(mine.url), viewId: page.viewId })).toEqual({ state: "closed" });
    // Signed out, every other procedure of the task refuses it.
    for (const call of [() => visitor.previews.list({ taskId: task.taskId }), () => visitor.tasks.get({ taskId: task.taskId }), () => visitor.previews.open({ taskId: task.taskId, key: task.key })]) {
      expect(await trpcFailure(call())).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
