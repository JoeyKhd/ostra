import { writeEventSearchEntries, writeTaskSearchEntries } from "@ostra/domain";
import { memberIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller, SeededTask } from "../testing/index.ts";

// F-080 (ADR 0054, ticket 26): `search.tasks` and `search.suggest` on a real database, with entries
// written by ticket 11's writers. Every filter token with a near miss that must not match, a prefix,
// and access: a task the member can't open is never shown, snippeted or counted.

let harness: ApiHarness;
let orgA: OrganizationId;
let projectId: ProjectId;
let projectSlug: string;
let repoId: RepoId;
let otherProjectId: ProjectId;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

type Made = { readonly task: SeededTask; readonly projectId: ProjectId; readonly organizationId: OrganizationId };
const made: Record<string, Made> = {};

const seed = async (
  name: string,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly ticketKey?: string;
    readonly state?: "running" | "in_review" | "stopped";
    readonly creatorMemberId: string;
    readonly createdAt: Date;
    readonly repo?: RepoId;
    readonly message?: string;
  },
): Promise<void> => {
  const task = await seedTask(harness, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    title: input.title,
    state: input.state ?? "running",
    creatorMemberId: input.creatorMemberId,
  });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { ticketKey: input.ticketKey ?? null, createdAt: input.createdAt } });
  if (input.repo !== undefined) {
    await harness.test.db.taskRepo.create({
      data: { organizationId: input.organizationId, projectId: input.projectId, taskId: task.taskId, repoId: input.repo, branchName: `ostra/${name}`, baseBranch: "main", state: "no_branch" },
    });
  }
  await harness.test.db.$transaction((tx) =>
    writeTaskSearchEntries(tx, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: task.taskId,
      title: input.title,
      prompt: null,
      ticket: input.ticketKey === undefined ? null : { key: input.ticketKey, title: null },
      creatorMemberId: memberIdSchema.parse(input.creatorMemberId),
    }),
  );
  if (input.message !== undefined) {
    const event = { kind: "agent.message" as const, turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`seg-${name}`), text: input.message };
    const seq = await appendEvent(harness, task, { organizationId: input.organizationId, projectId: input.projectId }, event);
    await harness.test.db.$transaction((tx) => writeEventSearchEntries(tx, { organizationId: input.organizationId, projectId: input.projectId, taskId: task.taskId }, [{ seq, event }]));
  }
  made[name] = { task, projectId: input.projectId, organizationId: input.organizationId };
};

const idOf = (name: string): string => made[name]?.task.taskId ?? `missing ${name}`;
const found = async (caller: AppCaller, query: string): Promise<string[]> =>
  (await caller.search.tasks({ query })).results.map((result) => Object.entries(made).find(([, one]) => one.task.taskId === result.taskId)?.[0] ?? result.taskId).sort();

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  world = await seedConnectionAndModel(harness);
  const project = await seedProject(harness, world, "search-shop");
  projectId = project.projectId;
  repoId = project.repoId;
  projectSlug = (await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).slug;
  otherProjectId = harness.fixture.a.openProject.id;
  const { a, b } = harness.fixture;
  await seed("migration", { organizationId: orgA, projectId, title: "Fix the migration ordering", ticketKey: "OST-12", creatorMemberId: a.member.id, createdAt: new Date("2026-11-10T12:00:00Z"), repo: repoId, message: "I renamed apiVersion in the schema" });
  await seed("hexadecimal", { organizationId: orgA, projectId, title: "Add hexadecimal input", ticketKey: "OST-120", state: "in_review", creatorMemberId: a.insider.id, createdAt: new Date("2026-11-03T12:00:00Z") });
  await seed("elsewhere", { organizationId: orgA, projectId: otherProjectId, title: "Tidy the migrator script", creatorMemberId: a.admin.id, createdAt: new Date("2026-11-15T12:00:00Z") });
  await seed("hidden", { organizationId: orgA, projectId: a.restrictedProject.id, title: "Secret migration plan", ticketKey: "OST-12", creatorMemberId: a.insider.id, createdAt: new Date("2026-11-11T12:00:00Z") });
  await seed("other-organization", { organizationId: b.organization.id, projectId: b.project.id, title: "Their migration", ticketKey: "OST-12", creatorMemberId: b.admin.id, createdAt: new Date("2026-11-11T12:00:00Z") });
});

afterAll(async () => {
  await harness.dispose();
});

describe("search.tasks", () => {
  it("F-080/c1: each filter token narrows the search, and its near miss doesn't match", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const memberName = (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.member.userId } })).username;
    // ticket: OST-12, never OST-120.
    expect(await found(member, "ticket:OST-12")).toEqual(["migration"]);
    expect(await found(member, "ticket:ost-120")).toEqual(["hexadecimal"]);
    // repo: the task's repo, and a repo nobody has finds nothing.
    expect(await found(member, "repo:test1")).toEqual(["migration"]);
    expect(await found(member, "repo:ostra-test/test1")).toEqual(["migration"]);
    expect(await found(member, "repo:test9")).toEqual([]);
    // project: by its slug.
    expect(await found(member, `project:${projectSlug}`)).toEqual(["hexadecimal", "migration"]);
    // status: both spellings.
    expect(await found(member, "status:in-review")).toEqual(["hexadecimal"]);
    expect(await found(member, "status:in_review")).toEqual(["hexadecimal"]);
    expect(await found(member, "status:stopped")).toEqual([]);
    // by: a member, and `me`.
    expect(await found(member, `by:${memberName}`)).toEqual(["migration"]);
    expect(await found(member, "by:me")).toEqual(["migration"]);
    expect(await found(member, "by:nobody-here")).toEqual([]);
    // after: and before: by the day the task was made.
    expect(await found(member, "after:2026-11-09")).toEqual(["elsewhere", "migration"]);
    expect(await found(member, "after:2026-11-10")).toEqual(["elsewhere"]);
    expect(await found(member, "before:2026-11-10")).toEqual(["hexadecimal"]);
    // Combined with text.
    expect(await found(member, `project:${projectSlug} migration`)).toEqual(["migration"]);
  });

  it("F-080/c1: text matches with the last word as a prefix, in titles and in the thread, with snippets that link to the event", async () => {
    const member = await harness.as(harness.fixture.a.member);
    expect(await found(member, "migr")).toEqual(["elsewhere", "migration"]);
    expect(await found(member, "migration")).toEqual(["migration"]);
    expect(await found(member, "hexadecimals")).toEqual([]);
    const thread = await member.search.tasks({ query: "apiVersion" });
    expect(thread.results).toHaveLength(1);
    expect(thread.results[0]).toMatchObject({ taskId: idOf("migration"), projectId, title: "Fix the migration ordering", ticketKey: "OST-12", state: "running" });
    const snippet = thread.results[0]?.snippets[0];
    expect(snippet?.kind).toBe("agent_message");
    expect(typeof snippet?.eventSeq).toBe("number");
    expect(snippet?.parts.some((part) => part.match && part.text.toLowerCase() === "apiversion")).toBe(true);
  });

  it("F-080/c1: results come only from the projects the member can open in the active organization, for a member, a listed member and an admin", async () => {
    const { a } = harness.fixture;
    expect(await found(await harness.as(a.member), "migration")).toEqual(["migration"]);
    expect(await found(await harness.as(a.insider), "migration")).toEqual(["hidden", "migration"]);
    expect(await found(await harness.as(a.admin), "migration")).toEqual(["hidden", "migration"]);
    expect(await found(await harness.as(a.member), "ticket:OST-12")).toEqual(["migration"]);
    // Another organization's task never, even for its admin's words.
    expect(await found(await harness.as(a.admin), "Their")).toEqual([]);
  });

  it("F-080/c1: a hidden task's text never appears in a snippet or a count", async () => {
    const member = await harness.as(harness.fixture.a.member);
    for (const query of ["secret", "migration plan", "ticket:OST-12", "status:running"]) {
      const answer = await member.search.tasks({ query });
      expect(JSON.stringify(answer)).not.toMatch(/secret/i);
      expect(answer.total).toBe(answer.results.length);
      expect(answer.results.map((result) => result.taskId)).not.toContain(idOf("hidden"));
    }
    expect((await member.search.tasks({ query: "secret" })).total).toBe(0);
    expect((await (await harness.as(harness.fixture.a.admin)).search.tasks({ query: "secret" })).total).toBe(1);
  });

  it("F-080/c1: suggest gives the top 8 with the same access, and no search text reaches a log line", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const suggestions = await member.search.suggest({ query: "migr" });
    expect(suggestions.results.length).toBeLessThanOrEqual(8);
    expect(suggestions.results.map((result) => result.taskId).sort()).toEqual([idOf("elsewhere"), idOf("migration")].sort());
    const started = Date.now();
    await member.search.suggest({ query: "hexadeci" });
    expect(Date.now() - started).toBeLessThan(2000);
    const logged = JSON.stringify(harness.logs);
    for (const text of ["migr", "hexadeci", "apiVersion", "OST-12"]) {
      expect(logged).not.toContain(text);
    }
    expect(harness.logs.some((line) => JSON.stringify(line).includes("queryLength"))).toBe(true);
  });
});

describe("search.tasks, a repo in several projects", () => {
  it("F-080/c1: repo: matches a task in any project that lists the repo, not only the first project's", async () => {
    // The same repo, ostra-test/test1, listed by a second project: a row of its own there.
    const second = await seedProject(harness, world, "search-shop-two");
    await seed("second-project", { organizationId: orgA, projectId: second.projectId, title: "Paint the logo", creatorMemberId: harness.fixture.a.member.id, createdAt: new Date("2026-11-12T12:00:00Z"), repo: second.repoId });
    const member = await harness.as(harness.fixture.a.member);
    expect(await found(member, "repo:test1")).toEqual(["migration", "second-project"]);
    expect(await found(member, "repo:ostra-test/test1 logo")).toEqual(["second-project"]);
    expect(await found(member, "repo:test1 status:in-review")).toEqual([]);
  });
});
