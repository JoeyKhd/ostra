import { randomUUID } from "node:crypto";

import { segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appRouter } from "../routers/app-router.ts";
import { appendEvent, createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Ticket 33, ADR 0035: the stream over real HTTP, through tRPC's own fetch adapter. ADR 0035 left
// one thing unverified: that the stream keeps `Last-Event-ID` across untracked frames when it is
// tRPC's SSE and not plain SSE. This reads the actual `text/event-stream` bytes.

let harness: ApiHarness;
let projectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "http")).projectId;
  await harness.hub.start();
});

afterAll(async () => {
  await harness.dispose();
});

type Frame = { readonly id: string | null; readonly event: string; readonly data: string };

/** Opens the SSE endpoint like `httpSubscriptionLink` does, and parses frames as they arrive. */
const openSse = async (input: unknown, headers: Record<string, string>, memberOf: Parameters<ApiHarness["contextOf"]>[0]) => {
  const controller = new AbortController();
  const context = await harness.contextOf(memberOf);
  const url = new URL("http://localhost/api/trpc/stream.subscribe");
  url.searchParams.set("input", JSON.stringify(input));
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(url, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal }),
    router: appRouter,
    createContext: () => context,
  });
  const frames: Frame[] = [];
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      while (reader !== undefined) {
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        const bytes: unknown = chunk.value;
        buffer += bytes instanceof Uint8Array ? decoder.decode(bytes, { stream: true }) : "";
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = new Map(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()] as const));
          frames.push({ id: fields.get("id") ?? null, event: fields.get("event") ?? "message", data: fields.get("data") ?? "" });
        }
      }
    } catch {
      // The stream is closed by the test.
    }
  })();
  return {
    response,
    frames,
    waitFor: async (predicate: (all: readonly Frame[]) => boolean, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out; frames so far: ${JSON.stringify(frames.map((frame) => [frame.id, frame.event]))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await pump;
    },
  };
};

const place = () => ({ organizationId: harness.fixture.a.organization.id, projectId });

const write = async (task: SeededTask, count: number, from = 1) => {
  for (let index = from; index < from + count; index += 1) {
    await appendEvent(harness, task, place(), {
      kind: "agent.message",
      turnId: turnIdSchema.parse("turn-1"),
      segmentId: segmentIdSchema.parse(randomUUID()),
      text: `m${String(index)}`,
    });
  }
};

describe("the stream over HTTP", () => {
  it("is text/event-stream, with an id on every committed event", async () => {
    const task = await seedTask(harness, place());
    await write(task, 3);
    const sse = await openSse({ taskId: task.taskId }, {}, harness.fixture.a.member);
    expect(sse.response.headers.get("content-type")).toContain("text/event-stream");
    await sse.waitFor((all) => all.filter((frame) => frame.id !== null).length === 3);
    expect(sse.frames.filter((frame) => frame.id !== null).map((frame) => frame.id)).toEqual(["1", "2", "3"]);
    const data: unknown = JSON.parse(sse.frames.find((frame) => frame.id === "2")?.data ?? "null");
    expect(JSON.stringify(data)).toContain('"type":"event"');
    expect(JSON.stringify(data)).toContain("m2");
    await sse.close();
  });

  it("resumes from Last-Event-ID with no gap and no duplicate", async () => {
    const task = await seedTask(harness, place());
    await write(task, 6);
    // The client saw up to 4, then the connection dropped; the link reconnects with the last id.
    const sse = await openSse({ taskId: task.taskId, afterSeq: 0 }, { "last-event-id": "4" }, harness.fixture.a.member);
    await sse.waitFor((all) => all.filter((frame) => frame.id !== null).length === 2);
    expect(sse.frames.filter((frame) => frame.id !== null).map((frame) => frame.id)).toEqual(["5", "6"]);
    await write(task, 2, 7);
    await sse.waitFor((all) => all.filter((frame) => frame.id !== null).length === 4);
    expect(sse.frames.filter((frame) => frame.id !== null).map((frame) => frame.id)).toEqual(["5", "6", "7", "8"]);
    await sse.close();
  });

  it("keeps Last-Event-ID across untracked frames: the id is cleared for them and restored after", async () => {
    const task = await seedTask(harness, place());
    await write(task, 2);
    const sse = await openSse({ taskId: task.taskId }, {}, harness.fixture.a.member);
    await sse.waitFor((all) => all.filter((frame) => frame.id !== null && frame.id !== "").length === 2);
    // An untracked frame: a change notice of the organization.
    await harness.test.db.changeNotice.create({ data: { organizationId: harness.fixture.a.organization.id, projectId: null, entity: "task", entityId: "x" } });
    await sse.waitFor((all) => all.some((frame) => frame.event === "restore-id"));
    const change = sse.frames.find((frame) => frame.data.includes('"type":"change"'));
    // The untracked frame clears the id (an  field of its own), so it can't move the resume point ...
    expect(change?.id).toBe("");
    // ... and tRPC restores the last committed id right after it, in an event clients don't listen to.
    expect(sse.frames.find((frame) => frame.event === "restore-id")?.id).toBe("2");
    // What a browser's EventSource would hold, by the SSE rules (an id field sets it, an empty one clears it).
    let held = "";
    for (const frame of sse.frames) {
      if (frame.id !== null) {
        held = frame.id;
      }
    }
    expect(held).toBe("2");
    await sse.close();
  });

  it("sends tRPC's named ping, which a watchdog can see, unlike an SSE comment", () => {
    // The ping interval is the router's setting (15 s). Reading it from the router's config is the
    // check: a 15 s wait in a test would only repeat the library's own.
    expect(appRouter._def._config.sse).toMatchObject({ ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 20_000 } });
  });

  it("answers another organization's task with an error, not events", async () => {
    const task = await seedTask(harness, place());
    await write(task, 2);
    const sse = await openSse({ taskId: task.taskId }, {}, harness.fixture.b.admin);
    await sse.waitFor((all) => all.length > 0);
    expect(sse.frames.some((frame) => frame.id !== null)).toBe(false);
    expect(sse.frames.map((frame) => frame.data).join("\n")).not.toContain("m1");
    await sse.close();
  });
});
