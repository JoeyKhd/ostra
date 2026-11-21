import { describe, expect, it } from "vitest";

import { projectIdSchema } from "@ostra/protocol";

import type { RouterOutputs } from "@/lib/trpc";

import { accessChangeText, joinNames } from "./project-access-view";

// F-087 (project-access.md): the Access tab's words: the admins line's names, and the panel's
// `Last change` told as a sentence from the newest access entry of the audit log.

type AuditEntry = RouterOutputs["audit"]["list"]["entries"][number];

const entry = (action: string, data: unknown, actorName: string | null = "Alex Kim"): AuditEntry => ({
  id: "0193f2c4-7b1e-7c2a-9f00-000000000001",
  at: Date.UTC(2026, 10, 19, 12),
  actor: { kind: "member", id: "m-alex", name: actorName, removed: false },
  action,
  entity: "project",
  entityId: "p-vault",
  entityLabel: "vault",
  project: { id: projectIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), name: "vault" },
  taskId: null,
  data,
});

const names = new Map([["m-sam", "Sam Rivera"], ["m-jun", "Jun Ota"]]);
const nameOf = (memberId: string) => names.get(memberId);

describe("the Access tab's words (F-087)", () => {
  it("joins the organization's admins with commas and `and`", () => {
    expect(joinNames(["Alex Kim"])).toBe("Alex Kim");
    expect(joinNames(["Alex Kim", "Priya Nair"])).toBe("Alex Kim and Priya Nair");
    expect(joinNames(["Alex Kim", "Dana Ortiz", "Priya Nair"])).toBe("Alex Kim, Dana Ortiz and Priya Nair");
  });

  it("tells the last access change as a sentence", () => {
    expect(accessChangeText(entry("project.access-changed", { access: "restricted" }), "vault", nameOf)).toBe("Alex Kim restricted vault");
    expect(accessChangeText(entry("project.access-changed", { access: "open" }), "vault", nameOf)).toBe("Alex Kim opened vault to everyone");
    expect(accessChangeText(entry("project.member-set", { memberId: "m-sam", role: "admin" }), "vault", nameOf)).toBe("Alex Kim made Sam Rivera an admin");
    expect(accessChangeText(entry("project.member-set", { memberId: "m-jun", role: "member" }), "vault", nameOf)).toBe("Alex Kim made Jun Ota a member");
    expect(accessChangeText(entry("project.member-removed", { memberId: "m-jun" }), "vault", nameOf)).toBe("Alex Kim removed Jun Ota");
  });

  it("gives up on an entry it can't tell: an unknown member or actor", () => {
    expect(accessChangeText(entry("project.member-removed", { memberId: "m-gone" }), "vault", nameOf)).toBeNull();
    expect(accessChangeText(entry("project.access-changed", { access: "restricted" }, null), "vault", nameOf)).toBeNull();
  });
});
