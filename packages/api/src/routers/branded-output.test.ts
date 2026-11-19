import type {
  AgentProfileId,
  MemberId,
  OrganizationId,
  PoolId,
  SegmentId,
  SessionId,
  TaskId,
  TurnId,
} from "@ostra/protocol";
import { agentProfileIdSchema, memberIdSchema, organizationIdSchema, poolIdSchema } from "@ostra/protocol";
import type { inferRouterOutputs } from "@trpc/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { loginSessionIdSchema } from "../auth/scope.ts";
import type { LoginSessionId } from "../auth/scope.ts";
import { parseEventRow } from "../stream/hub.ts";
import type { LiveUpdate } from "../stream/hub.ts";
import type { AppRouter } from "./app-router.ts";

// The clients get the IDs of ostra-owned records branded, not as bare strings: a PoolId can't be
// passed where an AgentProfileId is wanted. These are type-level checks (tsc runs them), plus the
// runtime side of the schemas that read rows and bind a value to a login session.

type Outputs = inferRouterOutputs<AppRouter>;

describe("branded IDs in the API's outputs", () => {
  it("brand a project's pools and default profile", () => {
    expectTypeOf<Outputs["projects"]["get"]["pools"][number]["poolId"]>().toEqualTypeOf<PoolId>();
    expectTypeOf<NonNullable<Outputs["projects"]["get"]["defaultCodeProfile"]>["id"]>().toEqualTypeOf<AgentProfileId>();
  });

  it("brand the agent profiles' IDs", () => {
    expectTypeOf<Outputs["agentProfiles"]["list"][number]["id"]>().toEqualTypeOf<AgentProfileId>();
    expectTypeOf<Outputs["agentProfiles"]["setDefaultModel"]["profileId"]>().toEqualTypeOf<AgentProfileId>();
  });

  it("brand the IDs a live update carries", () => {
    expectTypeOf<LiveUpdate["segmentId"]>().toEqualTypeOf<SegmentId>();
    expectTypeOf<LiveUpdate["turnId"]>().toEqualTypeOf<TurnId>();
    expectTypeOf<LiveUpdate["sessionId"]>().toEqualTypeOf<SessionId>();
  });

  it("brand the IDs of a stored event read from a row", () => {
    const event = parseEventRow({
      taskId: "task-1",
      seq: 1,
      sessionId: "session-1",
      sessionSeq: 1,
      occurredAt: new Date(0),
      payload: { kind: "user.message", clientMessageId: "m1", memberId: "member-1", text: "hi", delivery: "immediate" },
    });
    expectTypeOf(event.taskId).toEqualTypeOf<TaskId>();
    expectTypeOf(event.sessionId).toEqualTypeOf<SessionId>();
  });

  it("rejects an ID that is empty or has whitespace at the row boundary", () => {
    expect(() => parseEventRow({ taskId: "", seq: 1, sessionId: "s", sessionSeq: 1, occurredAt: new Date(0), payload: {} })).toThrow();
    expect(() => parseEventRow({ taskId: "t", seq: 1, sessionId: "a b", sessionSeq: 1, occurredAt: new Date(0), payload: {} })).toThrow();
  });
});

describe("the GitHub manifest binding's IDs", () => {
  it("are branded, and the login session is its own ID, not an agent session's", () => {
    expectTypeOf(loginSessionIdSchema.parse("login-1")).toEqualTypeOf<LoginSessionId>();
    expectTypeOf<LoginSessionId>().not.toEqualTypeOf<SessionId>();
    expectTypeOf(memberIdSchema.parse("m")).toEqualTypeOf<MemberId>();
    expectTypeOf(organizationIdSchema.parse("o")).toEqualTypeOf<OrganizationId>();
    expectTypeOf(poolIdSchema.parse("p")).toEqualTypeOf<PoolId>();
    expectTypeOf(agentProfileIdSchema.parse("a")).toEqualTypeOf<AgentProfileId>();
    expect(() => loginSessionIdSchema.parse("")).toThrow();
  });
});
