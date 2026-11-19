import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  clientMessageIdSchema,
  memberIdSchema,
  segmentIdSchema,
  storedEventSchema,
  taskEventKinds,
} from "@ostra/protocol";
import type { StoredEvent, TaskEvent, TaskEventKind } from "@ostra/protocol";
import { eventFixtures, fixtureIds } from "@ostra/protocol/testing";

import { foldCoverage } from "./coverage.ts";
import { deriveTaskState } from "./derive-state.ts";
import { foldTaskEvents, pullRequestsOf } from "./fold.ts";
import { applyLiveTextFrame, emptyLiveText, pruneLiveText, visibleLiveText } from "./live-text.ts";
import type { LiveText } from "./live-text.ts";
import {
  allKindsSession,
  longSession,
  recordedOpenCodeSession,
  storeEvents,
} from "./testing/index.ts";
import type { TaskUIMessage, TaskUIPart } from "./ui-types.ts";

const partsOf = (messages: readonly TaskUIMessage[]): TaskUIPart[] =>
  messages.flatMap((m) => m.parts);
const typesOf = (messages: readonly TaskUIMessage[]): Set<string> =>
  new Set(partsOf(messages).map((p) => p.type));
const f = eventFixtures;

describe("foldCoverage", () => {
  it("names every event kind of the protocol", () => {
    expect(Object.keys(foldCoverage).sort()).toEqual([...taskEventKinds].sort());
  });
});

// What each kind must leave in the thread, given the prefix a real session would have before it.
const turnPrefix: TaskEvent[] = [f["turn.started"]];
const toolPrefix: TaskEvent[] = [...turnPrefix, f["tool.called"]];
const approvalPrefix: TaskEvent[] = [...toolPrefix, f["approval.requested"]];
const questionPrefix: TaskEvent[] = [...turnPrefix, f["question.asked"]];

type KindCase = {
  readonly prefix: readonly TaskEvent[];
  readonly check: (messages: TaskUIMessage[]) => void;
};

const findPart = (messages: readonly TaskUIMessage[], type: string): TaskUIPart | undefined =>
  partsOf(messages).find((p) => p.type === type);

const toolEdit = (messages: readonly TaskUIMessage[]) => {
  const part = findPart(messages, "tool-edit");
  if (part?.type !== "tool-edit") throw new Error("no edit part");
  return part;
};

const lastTurnMeta = (messages: readonly TaskUIMessage[]) =>
  messages.filter((m) => m.role === "assistant").at(-1)?.metadata;

const kindCases: Readonly<Record<TaskEventKind, KindCase>> = {
  "user.message": {
    prefix: [],
    check: (m) => {
      expect(m[0]?.role).toBe("user");
      expect(m[0]?.metadata?.author?.memberId).toBe(fixtureIds.member);
    },
  },
  "turn.started": {
    prefix: [],
    check: (m) => {
      expect(m[0]?.metadata?.turnState).toBe("running");
    },
  },
  "turn.ended": {
    prefix: turnPrefix,
    check: (m) => {
      expect(m[0]?.metadata?.stopReason).toBe("end_turn");
    },
  },
  "turn.failed": {
    prefix: turnPrefix,
    check: (m) => {
      expect(m[0]?.metadata?.error).toContain("500");
    },
  },
  "turn.cancel_requested": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "agent.message": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("text");
    },
  },
  "agent.thought": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("reasoning");
    },
  },
  "agent.content": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("source-url");
    },
  },
  "tool.called": {
    prefix: turnPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("input-available");
    },
  },
  "tool.progress": {
    // An edit's progress doesn't fit its output schema: the call stays running, nothing breaks.
    prefix: toolPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("input-available");
    },
  },
  "tool.completed": {
    prefix: toolPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("output-available");
      if (part.state === "output-available") expect(part.output.files[0]?.added).toBe(12);
    },
  },
  "tool.failed": {
    prefix: toolPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("output-error");
      if (part.state === "output-error") expect(part.errorText).toBe("permission denied");
    },
  },
  "approval.requested": {
    prefix: toolPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("approval-requested");
    },
  },
  "approval.answered": {
    prefix: approvalPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("approval-responded");
    },
  },
  "approval.auto_answered": {
    prefix: approvalPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("approval-responded");
      expect(part.approval?.isAutomatic).toBe(true);
    },
  },
  "approval.closed": {
    prefix: approvalPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("output-error");
    },
  },
  "question.asked": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-question");
    },
  },
  "question.answered": {
    prefix: questionPrefix,
    check: (m) => {
      const part = findPart(m, "data-question");
      expect(part?.type === "data-question" ? part.data.status.state : undefined).toBe("answered");
    },
  },
  "question.closed": {
    prefix: questionPrefix,
    check: (m) => {
      const part = findPart(m, "data-question");
      expect(part?.type === "data-question" ? part.data.status.state : undefined).toBe("closed");
    },
  },
  "plan.updated": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-plan");
    },
  },
  "compaction.updated": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-compaction");
    },
  },
  "session.config_changed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "driver.changed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-driver");
    },
  },
  "runner.connected": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "runner.lost": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "session.restored": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "session.crashed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "pr.opened": {
    prefix: [f["pr.text_set"]],
    check: (m) => {
      const part = findPart(m, "data-pr");
      expect(part?.type === "data-pr" ? part.data.title : undefined).toBe("Add CONTRIBUTING.md");
    },
  },
  "agent.unknown": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-unsupported");
    },
  },
  "environment.setup_started": {
    prefix: [],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.state : undefined).toBe("running");
    },
  },
  "environment.setup_output": {
    prefix: [f["environment.setup_started"]],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.output : undefined).toEqual([
        { stream: "stdout", text: "Installing...\n" },
      ]);
    },
  },
  "environment.setup_finished": {
    prefix: [f["environment.setup_started"]],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.state : undefined).toBe("succeeded");
      expect(m).toHaveLength(1);
    },
  },
  "git.pushed": {
    prefix: [],
    check: (m) => {
      const part = findPart(m, "data-pushed");
      expect(part?.type === "data-pushed" ? part.data.hidden : undefined).toBe(false);
    },
  },
  "pr.text_set": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-pr-text");
    },
  },
  "session.ended": {
    prefix: [],
    check: (m) => {
      const part = findPart(m, "data-session-end");
      expect(part?.type === "data-session-end" ? part.data.outcome : undefined).toBe(
        "with-changes",
      );
    },
  },
  "usage.recorded": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
    },
  },
  "session.usage": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.context).toEqual({ used: 12_000, size: 200_000 });
    },
  },
  // The server acts on it (it holds new dispatches on the provider); the thread shows nothing.
  "provider.rate_limited": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
      expect(typesOf(m)).not.toContain("data-unsupported");
    },
  },
};

describe("foldTaskEvents, one kind at a time", () => {
  for (const kind of taskEventKinds) {
    it(`folds ${kind} (protocol fixture)`, () => {
      const cases: Readonly<Record<TaskEventKind, KindCase>> = kindCases;
      const { prefix, check } = cases[kind];
      const messages = foldTaskEvents(storeEvents([...prefix, f[kind]]), []);
      expect(typesOf(messages)).not.toContain("data-problem");
      check(messages);
    });
  }
});

describe("foldTaskEvents, a session with every kind", () => {
  const messages = foldTaskEvents(storeEvents(allKindsSession()), []);

  it("shows no problem row for a coherent session", () => {
    expect(partsOf(messages).filter((p) => p.type === "data-problem")).toEqual([]);
  });

  it("settles the approvals of the second turn as receipts", () => {
    const execs = partsOf(messages).flatMap((p) => (p.type === "tool-execute" ? [p] : []));
    expect(execs.find((p) => p.title === "ls")?.state).toBe("output-available");
    expect(execs.find((p) => p.title === "rm -rf build")?.state).toBe("output-error");
    expect(execs.find((p) => p.title === "pnpm test")?.state).toBe("output-error");
  });

  it("keeps object identity for messages that didn't change", () => {
    const again = foldTaskEvents(storeEvents(allKindsSession()), [], { previous: messages });
    again.forEach((message, i) => {
      expect(message).toBe(messages[i]);
    });
  });

  it("gives a changed message a new object and keeps the others", () => {
    const events = allKindsSession();
    const extra: TaskEvent = { kind: "session.config_changed", key: "mode", value: "plan" };
    const again = foldTaskEvents(storeEvents([...events, extra]), [], { previous: messages });
    expect(again.slice(0, messages.length).every((m, i) => m === messages[i])).toBe(true);
    expect(again).toHaveLength(messages.length + 1);
  });

  it("lists the pull requests", () => {
    expect(pullRequestsOf(messages).map((pr) => pr.number)).toEqual([1]);
  });
});

describe("foldTaskEvents, the read side", () => {
  it("shows a kind this build doesn't know as an unsupported row", () => {
    const future = storedEventSchema.parse({
      taskId: fixtureIds.task,
      seq: 1,
      sessionId: fixtureIds.session,
      sessionSeq: 1,
      at: 1,
      event: { kind: "agent.from_the_future", x: 1 },
    });
    const part = foldTaskEvents([future], [])[0]?.parts[0];
    expect(part?.type).toBe("data-unsupported");
    expect(part?.type === "data-unsupported" ? part.data : undefined).toEqual({
      seq: 1,
      rawKind: "agent.from_the_future",
      acp: false,
    });
  });

  it("marks a tool update for an unknown call as a problem row, not a crash", () => {
    const messages = foldTaskEvents(storeEvents([f["tool.completed"]]), []);
    expect(typesOf(messages)).toContain("data-problem");
  });

  it("marks the hidden ref push as hidden", () => {
    const hidden: TaskEvent = { ...f["git.pushed"], ref: `refs/ostra/wip/${fixtureIds.task}` };
    const part = findPart(foldTaskEvents(storeEvents([hidden]), []), "data-pushed");
    expect(part?.type === "data-pushed" ? part.data.hidden : undefined).toBe(true);
  });
});

describe("partial text", () => {
  const live = (segmentId: string, text = "partial"): LiveText => ({
    sessionId: fixtureIds.session,
    turnId: fixtureIds.turn,
    segmentId: segmentIdSchema.parse(segmentId),
    kind: "message",
    text,
    awaitingSnapshot: false,
  });
  const streaming = (messages: readonly TaskUIMessage[]) =>
    partsOf(messages).filter((p) => p.type === "text" && p.state === "streaming");

  it("is shown in its turn until the completed message arrives", () => {
    const started = storeEvents([f["turn.started"]]);
    expect(streaming(foldTaskEvents(started, [live("seg-1")]))).toHaveLength(1);
    const done = storeEvents([f["turn.started"], f["agent.message"]]);
    expect(streaming(foldTaskEvents(done, [live("seg-1")]))).toEqual([]);
    expect(streaming(foldTaskEvents(done, [live("seg-other")]))).toHaveLength(1);
  });

  it("opens a turn that has no committed event yet", () => {
    const messages = foldTaskEvents([], [live("seg-1", "Hel")]);
    expect(messages[0]?.metadata?.turnState).toBe("running");
    expect(streaming(messages)).toHaveLength(1);
  });

  const frame = (offset: number, text: string) => ({
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    turnId: fixtureIds.turn,
    segmentId: segmentIdSchema.parse("seg-1"),
    kind: "message" as const,
    offset,
    text,
  });

  it("applies a snapshot, then deltas at the right offset", () => {
    let state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    state = applyLiveTextFrame(state, frame(3, "lo"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hello"]);
  });

  it("drops a delta at the wrong offset and waits for the next snapshot", () => {
    let state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    state = applyLiveTextFrame(state, frame(9, "zzz"));
    state = applyLiveTextFrame(state, frame(3, "lo"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hel"]);
    state = applyLiveTextFrame(state, frame(0, "Hello, world"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hello, world"]);
  });

  it("ignores a delta for a segment it has no snapshot of", () => {
    const state = applyLiveTextFrame(emptyLiveText, frame(4, "late"));
    expect(visibleLiveText(state)).toEqual([]);
    expect(applyLiveTextFrame(state, frame(8, "more"))).toBe(state);
  });

  it("is pruned when its message is committed or its turn ends", () => {
    const state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    expect(pruneLiveText(state, storeEvents([f["agent.message"]])).size).toBe(0);
    expect(pruneLiveText(state, storeEvents([f["turn.ended"]])).size).toBe(0);
    expect(pruneLiveText(state, storeEvents([f["runner.lost"]]))).toBe(state);
  });
});

describe("optimistic messages", () => {
  const optimistic = [
    {
      clientMessageId: clientMessageIdSchema.parse("client-msg-1"),
      memberId: memberIdSchema.parse(fixtureIds.member),
      text: "Add a CONTRIBUTING.md",
      delivery: "immediate" as const,
    },
  ];

  it("shows the driver's message at once and replaces it with the committed one (same id)", () => {
    const before = foldTaskEvents([], [], { optimistic });
    expect(before[0]?.id).toBe("user:client-msg-1");
    expect(before[0]?.metadata?.optimistic).toBe(true);
    const after = foldTaskEvents(storeEvents([f["user.message"]]), [], { optimistic });
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("user:client-msg-1");
    expect(after[0]?.metadata?.optimistic).toBeUndefined();
  });
});

describe("a recorded OpenCode session", () => {
  const events: StoredEvent[] = recordedOpenCodeSession.map((raw) => storedEventSchema.parse(raw));
  const messages = foldTaskEvents(events, []);
  const parts = partsOf(messages);
  const count = (kind: TaskEventKind) => events.filter((e) => e.event.kind === kind).length;

  it("folds with no problem row", () => {
    expect(parts.filter((p) => p.type === "data-problem")).toEqual([]);
  });

  it("drops nothing: every call, message and thought has its part", () => {
    const toolParts = parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool");
    expect(toolParts).toHaveLength(count("tool.called"));
    expect(parts.filter((p) => p.type === "text")).toHaveLength(
      count("agent.message") + count("user.message"),
    );
    expect(parts.filter((p) => p.type === "reasoning")).toHaveLength(count("agent.thought"));
    expect(parts.filter((p) => p.type === "data-unsupported")).toHaveLength(count("agent.unknown"));
    for (const type of [
      "tool-read",
      "tool-edit",
      "tool-execute",
      "dynamic-tool",
      "data-plan",
      "data-setup",
      "data-pushed",
      "data-pr",
      "data-pr-text",
      "data-session-end",
      "data-compaction",
      "data-system",
    ]) {
      expect(typesOf(messages)).toContain(type);
    }
  });

  it("renders a read that failed as an error, and the edit with its counts", () => {
    const reads = parts.flatMap((p) => (p.type === "tool-read" ? [p] : []));
    expect(reads.map((p) => p.state)).toContain("output-error");
    const edit = parts.find((p) => p.type === "tool-edit");
    expect(
      edit?.type === "tool-edit" && edit.state === "output-available"
        ? edit.output.files[0]
        : undefined,
    ).toMatchObject({ path: "README.md", added: 1, removed: 1 });
  });

  it("derives what the agent is doing, the tokens and the PR", () => {
    const state = deriveTaskState(events);
    expect(state.activity).toEqual({ kind: "session-ended", outcome: "with-changes" });
    expect(state.turnRunning).toBe(false);
    expect(state.tokens.inputTokens).toBe(43_284);
    expect(state.pullRequests.map((pr) => pr.url)).toEqual([
      "https://github.com/ostra-test/test1/pull/7",
    ]);
    expect(state.branches).toHaveLength(1);
    expect(state.headSeq).toBe(events.length);
  });

  it("derives a running tool part-way through", () => {
    const upTo = events.findIndex((e) => e.event.kind === "tool.progress");
    const state = deriveTaskState(events.slice(0, upTo + 1));
    expect(state.activity).toMatchObject({ kind: "tool", toolKind: "execute" });
    expect(state.turnRunning).toBe(true);
  });
});

describe("deriveTaskState", () => {
  it("is idle with no events, setting up during setup, and waits on an approval", () => {
    expect(deriveTaskState([]).activity).toEqual({ kind: "idle" });
    expect(deriveTaskState(storeEvents([f["environment.setup_started"]])).activity).toEqual({
      kind: "setting-up",
    });
    const failed: TaskEvent = { ...f["environment.setup_finished"], exitCode: 2 };
    expect(deriveTaskState(storeEvents([failed])).activity).toEqual({
      kind: "setup-failed",
      exitCode: 2,
    });
    const waiting = deriveTaskState(storeEvents(approvalPrefix));
    expect(waiting.activity).toEqual({ kind: "waiting-approval" });
    expect(waiting.pendingApprovalIds).toEqual([fixtureIds.approval]);
  });

  it("follows the driver and a stop request", () => {
    const state = deriveTaskState(
      storeEvents([f["turn.started"], f["driver.changed"], f["turn.cancel_requested"]]),
      {
        initialDriver: fixtureIds.member,
      },
    );
    expect(state.driverMemberId).toBe(fixtureIds.otherMember);
    expect(state.activity).toEqual({ kind: "stopping" });
  });

  it("shows a crash and a lost runner", () => {
    expect(deriveTaskState(storeEvents([f["session.crashed"]])).activity.kind).toBe("crashed");
    expect(deriveTaskState(storeEvents([f["runner.lost"]])).activity.kind).toBe("runner-lost");
    expect(
      deriveTaskState(storeEvents([f["runner.lost"], f["runner.connected"]])).activity.kind,
    ).toBe("idle");
  });
});

describe("the render budget", () => {
  it("folds 5,000 events well under the budget", () => {
    const events = storeEvents(longSession(5_000));
    expect(events).toHaveLength(5_000);
    foldTaskEvents(events, []); // warm-up
    const start = performance.now();
    const first = foldTaskEvents(events, []);
    const cold = performance.now() - start;
    const again = performance.now();
    foldTaskEvents(events, [], { previous: first });
    const warm = performance.now() - again;
    console.info(
      `fold of 5,000 events: ${cold.toFixed(1)} ms, refold with identity reuse: ${warm.toFixed(1)} ms (${String(first.length)} messages)`,
    );
    expect(typesOf(first)).not.toContain("data-problem");
    // ADR 0036's bar is 1.5 s for the whole default view; the fold is a fraction of it.
    expect(cold).toBeLessThan(300);
  });
});
