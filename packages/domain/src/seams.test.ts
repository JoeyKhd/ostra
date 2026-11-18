import { readdir } from "node:fs/promises";
import path from "node:path";

import { memberIdSchema, organizationIdSchema, projectIdSchema, providerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { requireOrganizationAdmin, requireOrganizationMember, requireProjectAccess, visibleProjects } from "./access.ts";
import type { MemberScope, ProjectAccessInfo } from "./access.ts";
import * as domain from "./index.ts";
import { jobKey, jobNames, parseJobPayload } from "./jobs.ts";

const organizationA = organizationIdSchema.parse("org-a");
const organizationB = organizationIdSchema.parse("org-b");
const open: ProjectAccessInfo = { id: projectIdSchema.parse("p-open"), organizationId: organizationA, access: "open" };
const restricted: ProjectAccessInfo = { id: projectIdSchema.parse("p-restricted"), organizationId: organizationA, access: "restricted" };
const elsewhere: ProjectAccessInfo = { id: projectIdSchema.parse("p-b"), organizationId: organizationB, access: "open" };

const scope = (role: MemberScope["role"], projectRoles: MemberScope["projectRoles"] = new Map()): MemberScope => ({
  organizationId: organizationA,
  memberId: memberIdSchema.parse(`member-${role}`),
  role,
  projectRoles,
});

describe("access checks (ADR 0026)", () => {
  it("hides another organization: not-found, never forbidden", () => {
    expect(requireOrganizationMember(scope("admin"), organizationB)).toEqual({ ok: false, code: "not-found" });
    expect(requireOrganizationAdmin(scope("admin"), organizationB)).toEqual({ ok: false, code: "not-found" });
    expect(requireProjectAccess(scope("admin"), elsewhere, "read")).toEqual({ ok: false, code: "not-found" });
  });

  it("lets a member in, and only an admin administer", () => {
    expect(requireOrganizationMember(scope("member"), organizationA).ok).toBe(true);
    expect(requireOrganizationAdmin(scope("member"), organizationA)).toEqual({ ok: false, code: "forbidden" });
    expect(requireOrganizationAdmin(scope("admin"), organizationA).ok).toBe(true);
  });

  it("opens an open project to every member, and its settings to admins", () => {
    expect(requireProjectAccess(scope("member"), open, "read")).toMatchObject({ ok: true, value: { role: "member" } });
    expect(requireProjectAccess(scope("member"), open, "admin")).toEqual({ ok: false, code: "forbidden" });
    expect(requireProjectAccess(scope("member", new Map([[open.id, "admin"]])), open, "admin").ok).toBe(true);
  });

  it("hides a restricted project from a member who isn't listed, not from admins or insiders", () => {
    expect(requireProjectAccess(scope("member"), restricted, "read")).toEqual({ ok: false, code: "not-found" });
    expect(requireProjectAccess(scope("admin"), restricted, "admin").ok).toBe(true);
    const insider = scope("member", new Map([[restricted.id, "member"]]));
    expect(requireProjectAccess(insider, restricted, "read").ok).toBe(true);
    expect(requireProjectAccess(insider, restricted, "admin")).toEqual({ ok: false, code: "forbidden" });
    expect(visibleProjects(scope("member"), [open, restricted, elsewhere])).toEqual([open]);
  });
});

describe("the job catalogue (ADR 0037)", () => {
  it("has milestone 1's jobs", () => {
    expect([...jobNames].sort()).toEqual(
      [
        "catalog.refresh",
        "provider.refresh-models",
        "task.dispatch",
        "task.grace",
        "task.offer-timeout",
        "task.open-pull-requests",
        "task.session-ended",
      ].sort(),
    );
  });

  it("keys a job by what it does", () => {
    const base = { organizationId: organizationA, taskId: taskIdSchema.parse("t1") };
    expect(jobKey("task.dispatch", { ...base, sessionId: sessionIdSchema.parse("s1"), leaseEpoch: 2 })).toBe("task:t1:dispatch:2");
    expect(jobKey("task.session-ended", { ...base, sessionId: sessionIdSchema.parse("s1"), eventSeq: 40 })).toBe(
      "task:t1:session-ended:40",
    );
    expect(jobKey("provider.refresh-models", { organizationId: organizationA, providerId: providerIdSchema.parse("p1") })).toBe(
      "provider:p1:refresh-models",
    );
    expect(jobKey("catalog.refresh", {})).toBe("catalog:refresh");
  });

  it("parses a payload off the queue strictly: IDs only, no extra field", () => {
    const payload = { organizationId: "org-a", taskId: "t1", leaseEpoch: 1 };
    expect(parseJobPayload("task.grace", payload)).toEqual({ ok: true, payload });
    expect(parseJobPayload("task.grace", { ...payload, prompt: "secret plans" })).toEqual({ ok: false });
    expect(parseJobPayload("task.grace", { ...payload, leaseEpoch: 0 })).toEqual({ ok: false });
  });
});

describe("the use-case seams", () => {
  const useCases = {
    dispatchTask: "26",
    acceptOffer: "26",
    issueTaskCredentials: "26",
    recordSessionEnd: "27",
    openPullRequests: "27",
  } as const;

  it("has a file for every use case the spec lists", async () => {
    const files = await readdir(path.join(import.meta.dirname, "use-cases"));
    const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace("git-hub", "github");
    for (const name of Object.keys(useCases)) {
      expect(files).toContain(`${kebab(name)}.ts`);
    }
  });

  it.each(Object.entries(useCases))("%s is exported, and its body names ticket %s until it's written", (name, ticket) => {
    const useCase: unknown = Reflect.get(domain, name);
    expect(typeof useCase).toBe("function");
    if (typeof useCase !== "function") {
      return;
    }
    expect(() => {
      Reflect.apply(useCase, undefined, [{}, {}]);
    }).toThrow(`not implemented: ticket ${ticket}`);
  });

  it("gives every use case that takes a request an input schema", () => {
    for (const name of [
      "createFirstAdmin",
      "addModelProvider",
      "connectGitHubApp",
      "createProject",
      "saveEnvironment",
      "registerPersonalRunner",
      "createPromptTask",
      "acceptOffer",
      "issueTaskCredentials",
      "ingestEvents",
      "stopTask",
    ]) {
      const schema: unknown = Reflect.get(domain, `${name}InputSchema`);
      expect(typeof Reflect.get(Object(schema), "safeParse"), `${name}InputSchema`).toBe("function");
    }
  });

  it("refuses an unknown field in a prompt task and a stop", () => {
    expect(domain.createPromptTaskInputSchema.safeParse({ projectId: "p1", prompt: "Add tests", extra: true }).success).toBe(false);
    expect(domain.createPromptTaskInputSchema.safeParse({ projectId: "p1", prompt: "Add tests" }).success).toBe(true);
    expect(domain.stopTaskInputSchema.safeParse({ taskId: "t1", force: true }).success).toBe(false);
  });
});
