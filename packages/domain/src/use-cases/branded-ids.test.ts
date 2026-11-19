import type { Tx } from "@ostra/db";
import type { OrganizationId, PoolId, RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { AuditInput, ChangeNoticeInput, EntityId } from "../ports.ts";
import { branchNameFor } from "./create-prompt-task.ts";
import type { IngestEventsInput } from "./ingest-events.ts";
import { lastAgentMessageInTx, releaseLeaseInTx } from "./record-session-end.ts";
import { deviceSessionIdSchema } from "./register-personal-runner.ts";
import type { DeviceSessionId, DeviceSessionOwner, RegisterPersonalRunnerDeps } from "./register-personal-runner.ts";

// The use-case internals take the branded IDs their callers hold, never a bare string, so a
// `SessionId` can't be passed where a `TaskId` is wanted. The type checks run with `tsc`; the
// runtime ones check the device session's brand.

describe("the IDs the use cases take", () => {
  it("takes a TaskId for the branch name", () => {
    expectTypeOf(branchNameFor).parameter(0).toEqualTypeOf<TaskId>();
  });

  it("takes a TaskId and a SessionId for the last agent message", () => {
    expectTypeOf(lastAgentMessageInTx).parameters.toEqualTypeOf<[tx: Tx, taskId: TaskId, sessionId: SessionId]>();
  });

  it("takes a TaskId to release the lease", () => {
    expectTypeOf(releaseLeaseInTx).parameter(1).toEqualTypeOf<TaskId>();
  });

  it("names a runner by its RunnerId in an ingest frame", () => {
    expectTypeOf<IngestEventsInput["runnerId"]>().toEqualTypeOf<RunnerId>();
  });

  it("holds a device session's ID as a DeviceSessionId", () => {
    expectTypeOf<DeviceSessionOwner["sessionId"]>().toEqualTypeOf<DeviceSessionId>();
    expectTypeOf<Parameters<RegisterPersonalRunnerDeps["revokeSession"]>[0]>().toEqualTypeOf<DeviceSessionId>();
    expectTypeOf<string>().not.toExtend<DeviceSessionId>();
    expectTypeOf<DeviceSessionId>().not.toExtend<TaskId>();
  });

  it("names the record of a notice or an audit entry by an ID, never a bare string", () => {
    expectTypeOf<string>().not.toExtend<EntityId>();
    expectTypeOf<ChangeNoticeInput["entityId"]>().toEqualTypeOf<EntityId>();
    expectTypeOf<AuditInput["entityId"]>().toEqualTypeOf<EntityId | null>();
    expectTypeOf<TaskId>().toExtend<EntityId>();
    expectTypeOf<PoolId>().toExtend<EntityId>();
    expectTypeOf<OrganizationId>().toExtend<EntityId>();
  });

});

describe("the device session's ID", () => {
  it("is the id better-auth gave the session", () => {
    expect(deviceSessionIdSchema.parse("session-1")).toBe("session-1");
  });

  it("is never empty or spaced", () => {
    expect(deviceSessionIdSchema.safeParse("").success).toBe(false);
    expect(deviceSessionIdSchema.safeParse("a b").success).toBe(false);
  });
});
