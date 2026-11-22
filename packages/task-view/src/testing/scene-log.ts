import { segmentIdSchema, serverOnlyKinds, storedEventSchema, toolCallIdSchema } from "@ostra/protocol";
import type { SegmentId, SessionId, StoredEvent, TaskEvent, TaskEventOf, TaskId, TaskKind, ToolCallId, ToolKind, TurnId } from "@ostra/protocol";
import { eventFixtures } from "@ostra/protocol/testing";

import type { LiveText } from "../live-text.ts";

// Milestone 10 (F-151, spec section 9): the builder the recorded scenes are written with. A scene is
// a task's stored events as the server keeps them (each with its seq, its session's number for a
// runner's event, and the time its peer recorded it), on a clock the scene sets, so every step has
// a real start and end. Pure data: nothing here runs an agent.

/** The day every scene happens on, 2026-11-19, in UTC. */
export const SCENE_DAY = Date.UTC(2026, 10, 19);

/** A time of the scene's day, `"14:02"`, `"14:02:05"` or `"14:02:05.300"`, in ms since the epoch. */
export const sceneTime = (time: string): number => {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?$/.exec(time);
  if (match === null) throw new Error(`a scene time is HH:MM[:SS[.mmm]], not ${time}`);
  const [, hours = "0", minutes = "0", seconds = "0", ms = "0"] = match;
  return SCENE_DAY + ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(ms);
};

/** A scene's ID of an entity: a UUID in its `group` (four hex digits), numbered `n`. */
export const sceneId = (group: string, n: number): string => `0196f1a0-${group}-7000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * One recorded scene: the events a task's thread folds, the figures `tasks.get` gives with them, and
 * the moment it shows. Every later ticket's tests and the seeded world read the same scenes.
 */
export type Scene = {
  readonly name: string;
  readonly taskId: TaskId;
  /** The task's kind, as `tasks.get` gives it: the fold's `taskKind`. */
  readonly kind: TaskKind;
  readonly events: readonly StoredEvent[];
  /** The viewer's partial text, for a scene caught mid-sentence. */
  readonly liveText: readonly LiveText[];
  /** The moment the scene shows, in ms since the epoch: the live step's clock reads it. */
  readonly now: number;
};

export type SceneLog = {
  readonly taskId: TaskId;
  /** The events so far. */
  readonly events: () => readonly StoredEvent[];
  /** The events from here on are this session's. */
  readonly session: (sessionId: SessionId) => void;
  /** Sets the clock to a time of the scene's day. It never runs back. */
  readonly at: (time: string) => void;
  /** Moves the clock on. */
  readonly wait: (ms: number) => void;
  /** The clock now. */
  readonly now: () => number;
  /** Records events at the clock, as the server stores them: a server-only kind has no session number. */
  readonly add: (...events: readonly TaskEvent[]) => void;
  /** A tool call's ID, new in the scene. */
  readonly nextCall: () => ToolCallId;
  /** A segment's ID, new in the scene. */
  readonly nextSegment: () => SegmentId;
};

export const sceneLog = (input: { readonly taskId: TaskId; readonly sessionId: SessionId; readonly start: string; readonly prefix: string }): SceneLog => {
  const events: StoredEvent[] = [];
  const sessionSeqs = new Map<SessionId, number>();
  let sessionId = input.sessionId;
  let clock = sceneTime(input.start);
  let calls = 0;
  let segments = 0;
  return {
    taskId: input.taskId,
    events: () => events,
    session: (next) => {
      sessionId = next;
    },
    at: (time) => {
      const to = sceneTime(time);
      if (to < clock) throw new Error(`the scene's clock runs back to ${time}`);
      clock = to;
    },
    wait: (ms) => {
      clock += ms;
    },
    now: () => clock,
    add: (...more) => {
      for (const event of more) {
        const runnerEvent = !serverOnlyKinds.has(event.kind);
        const sessionSeq = runnerEvent ? (sessionSeqs.get(sessionId) ?? 0) + 1 : null;
        if (sessionSeq !== null) sessionSeqs.set(sessionId, sessionSeq);
        events.push(storedEventSchema.parse({ taskId: input.taskId, seq: events.length + 1, sessionId, sessionSeq, at: clock, event }));
      }
    },
    nextCall: () => {
      calls += 1;
      return toolCallIdSchema.parse(`${input.prefix}-call-${String(calls).padStart(2, "0")}`);
    },
    nextSegment: () => {
      segments += 1;
      return segmentIdSchema.parse(`${input.prefix}-seg-${String(segments).padStart(2, "0")}`);
    },
  };
};

/** A tool call's input and output, as its events carry them. */
type ToolInput = TaskEventOf<"tool.called">["input"];
type ToolOutput = TaskEventOf<"tool.completed">["output"];

/** How long the model takes between two steps, when a scene doesn't say. */
const STEP_GAP_MS = 1_400;

/**
 * A turn's steps, as OpenCode reports them (`read`, `edit`, a command, `grep`, `websearch`,
 * `webfetch`, an MCP server's `{server}_{tool}`), each with a raw path in the workspace: the panel
 * shows paths relative to it (content fix 7). Each call waits `gap` before it starts, then lasts its
 * `ms`.
 */
export type TurnSteps = {
  readonly turnId: TurnId;
  /** The model thinks for `ms`, then says the thought. */
  readonly thought: (text: string, ms: number) => void;
  /** The agent's prose, after `ms` of writing. */
  readonly say: (text: string, ms?: number) => void;
  readonly read: (path: string, lineCount: number, ms?: number) => ToolCallId;
  readonly edit: (path: string, added: number, removed: number, ms?: number) => ToolCallId;
  readonly run: (command: string, exitCode: number | null, ms: number, output: string) => ToolCallId;
  /** A code search (`grep`), with its match count. */
  readonly search: (pattern: string, path: string, matches: number, ms?: number) => ToolCallId;
  /** A web search (`websearch`, a tool of kind `other` with its `query`). */
  readonly webSearch: (query: string, ms?: number) => ToolCallId;
  /** A web fetch (`webfetch`, kind `fetch`) that failed. */
  readonly fetchFailed: (url: string, error: string, ms?: number) => ToolCallId;
  /** Any other tool, by the title the agent names it with. */
  readonly tool: (title: string, input: ToolInput, output: ToolOutput, ms?: number) => ToolCallId;
  /** A call that starts and is still running. */
  readonly start: (kind: ToolKind, title: string, input: ToolInput) => ToolCallId;
  /** The key proxy's count for a model call of the turn. */
  readonly usage: (inputTokens: number, outputTokens: number, reasoningTokens: number) => void;
};

/** `repoDir`: the repo's checkout in the box (`/workspace/calculator-web`). */
export const turnSteps = (log: SceneLog, turnId: TurnId, repoDir: string): TurnSteps => {
  const inRepo = (path: string): string => (path.startsWith("/") ? path : `${repoDir}/${path}`);
  const call = (kind: ToolKind, title: string, input: ToolInput, ms: number, settle: (toolCallId: ToolCallId) => TaskEvent, gap = STEP_GAP_MS): ToolCallId => {
    const toolCallId = log.nextCall();
    log.wait(gap);
    log.add({ kind: "tool.called", turnId, toolCallId, toolKind: kind, title, input });
    log.wait(ms);
    log.add(settle(toolCallId));
    return toolCallId;
  };
  const done = (output: ToolOutput) => (toolCallId: ToolCallId): TaskEvent => ({ kind: "tool.completed", toolCallId, output });
  return {
    turnId,
    thought: (text, ms) => {
      log.wait(ms);
      log.add({ kind: "agent.thought", turnId, segmentId: log.nextSegment(), text });
    },
    say: (text, ms = 2_600) => {
      log.wait(ms);
      log.add({ kind: "agent.message", turnId, segmentId: log.nextSegment(), text });
    },
    read: (path, lineCount, ms = 180) => call("read", "read", { path: inRepo(path) }, ms, done({ lineCount })),
    edit: (path, added, removed, ms = 240) => call("edit", "edit", { paths: [inRepo(path)] }, ms, done({ files: [{ path: inRepo(path), added, removed }] }), 9_000),
    run: (command, exitCode, ms, output) => call("execute", command, { command, cwd: repoDir }, ms, done({ output, truncated: false, exitCode })),
    search: (pattern, path, matches, ms = 120) => call("search", "grep", { pattern, path: inRepo(path) }, ms, done({ matches })),
    webSearch: (query, ms = 2_100) => call("other", "websearch", { query }, ms, done({ output: `Results for ${query}` })),
    fetchFailed: (url, error, ms = 900) => call("fetch", "webfetch", { url, format: "markdown" }, ms, (toolCallId) => ({ kind: "tool.failed", toolCallId, error })),
    tool: (title, input, output, ms = 700) => call("other", title, input, ms, done(output)),
    start: (kind, title, input) => {
      const toolCallId = log.nextCall();
      log.wait(STEP_GAP_MS);
      log.add({ kind: "tool.called", turnId, toolCallId, toolKind: kind, title, input });
      return toolCallId;
    },
    usage: (inputTokens, outputTokens, reasoningTokens) => {
      log.add({ ...eventFixtures["usage.recorded"], inputTokens, outputTokens, reasoningTokens });
    },
  };
};
