import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import { reasoningControlsFixtures } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { canSetTaskEffort } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { clampEffort, effectiveReasoning } from "./reasoning.ts";

// F-137 (ADR 0066): which controls a model runs with. The clamp's table is the protocol's
// (`packages/protocol/src/agent/effort.test.ts`); the domain re-exports the same function.

const { effort: catalog, toggle: admin, none } = reasoningControlsFixtures;

describe("effectiveReasoning", () => {
  it("F-137: the admin's controls, else the catalog's, else none", () => {
    expect(effectiveReasoning({ adminReasoning: admin, catalogReasoning: catalog })).toEqual(admin);
    expect(effectiveReasoning({ adminReasoning: null, catalogReasoning: catalog })).toEqual(catalog);
    expect(effectiveReasoning({ adminReasoning: admin, catalogReasoning: null })).toEqual(admin);
    expect(effectiveReasoning({ adminReasoning: null, catalogReasoning: null })).toEqual({ supported: false });
    // An admin who says a model doesn't reason wins over a catalog that says it does.
    expect(effectiveReasoning({ adminReasoning: none, catalogReasoning: catalog })).toEqual({ supported: false });
  });

  it("F-137: the domain's clamp is the protocol's", () => {
    expect(clampEffort("medium", ["default", "low", "high"])).toEqual({ level: "high", adjusted: true });
  });
});

describe("canSetTaskEffort", () => {
  const organizationId = organizationIdSchema.parse("org-a");
  const driverId = memberIdSchema.parse("member-driver");
  const scope = (memberId: string, role: "admin" | "member", org = organizationId): MemberScope => ({
    organizationId: org,
    memberId: memberIdSchema.parse(memberId),
    role,
    projectRoles: new Map(),
  });

  it("F-137: only the task's driver sets its level: not a watcher, not an admin, not another organization", () => {
    expect(canSetTaskEffort(scope("member-driver", "member"), { organizationId, driverMemberId: driverId })).toBe(true);
    expect(canSetTaskEffort(scope("member-watcher", "member"), { organizationId, driverMemberId: driverId })).toBe(false);
    expect(canSetTaskEffort(scope("member-admin", "admin"), { organizationId, driverMemberId: driverId })).toBe(false);
    expect(canSetTaskEffort(scope("member-driver", "member", organizationIdSchema.parse("org-b")), { organizationId, driverMemberId: driverId })).toBe(false);
    expect(canSetTaskEffort(scope("member-driver", "member"), { organizationId, driverMemberId: null })).toBe(false);
  });
});
