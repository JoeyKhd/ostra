import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketKeySchema,
} from "./ids.ts";
import type { OrganizationId, ProjectId, SessionId, TaskId, TicketKey } from "./ids.ts";
import * as protocol from "./index.ts";

const idSchemas = Object.entries(protocol).flatMap(([name, value]) =>
  name.endsWith("IdSchema") && value instanceof z.ZodType ? [[name, value] as const] : [],
);

describe("branded IDs", () => {
  it("covers every ID the domain model names", () => {
    const names = idSchemas.map(([name]) => name);
    for (const expected of [
      "organizationIdSchema",
      "projectIdSchema",
      "taskIdSchema",
      "sessionIdSchema",
      "runnerIdSchema",
      "poolIdSchema",
      "boxIdSchema",
      "providerIdSchema",
      "noteIdSchema",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(idSchemas)("%s accepts a plain ID and keeps its value", (_name, schema) => {
    expect(schema.parse("abc-123")).toBe("abc-123");
  });

  it.each(idSchemas)("%s rejects an empty string, whitespace and non-strings", (_name, schema) => {
    for (const bad of ["", " ", "has space", "tab\t", 42, null, undefined, {}]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it("gives every ID its own type", () => {
    expectTypeOf<TaskId>().not.toEqualTypeOf<SessionId>();
    expectTypeOf<OrganizationId>().not.toEqualTypeOf<ProjectId>();
    expectTypeOf<TaskId>().toExtend<string>();
    expectTypeOf<TaskId>().toEqualTypeOf<z.infer<typeof taskIdSchema>>();
  });

  it("does not let one kind of ID stand in for another", () => {
    const taskId = taskIdSchema.parse("t1");
    const sessionId = sessionIdSchema.parse("t1");
    const needsTask = (id: TaskId): TaskId => id;

    expect(needsTask(taskId)).toBe("t1");
    // @ts-expect-error a SessionId is not a TaskId, even with the same value
    expect(needsTask(sessionId)).toBe("t1");
    // @ts-expect-error a bare string is not a TaskId
    expect(needsTask("t1")).toBe("t1");
  });

  it("is not satisfied by another ID's schema", () => {
    expectTypeOf(runnerIdSchema.parse("r1")).not.toEqualTypeOf<TaskId>();
    expect(projectIdSchema.parse("p1")).toBe("p1");
    expect(organizationIdSchema.parse("o1")).toBe("o1");
  });
});

describe("TicketKey", () => {
  it.each(["CALC-161", "A-1", "OSTRA2-10", "MY_PROJ-7"])("accepts %s", (key) => {
    expect(ticketKeySchema.parse(key)).toBe(key);
  });

  // The tracker owns the key format, so only the checks every ID has apply for now.
  it.each(["", "CALC-1 ", " CALC-1", "CALC 161"])("rejects %j", (key) => {
    expect(ticketKeySchema.safeParse(key).success).toBe(false);
  });

  it("is a type of its own", () => {
    expectTypeOf<TicketKey>().not.toEqualTypeOf<string>();
    expectTypeOf<TicketKey>().toExtend<string>();
  });
});
