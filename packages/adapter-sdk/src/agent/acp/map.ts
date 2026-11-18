import { optionIdSchema, segmentIdSchema, toolCallIdSchema } from "@ostra/protocol";
import type { ApprovalOption, ContentBlock, PlanEntry, SegmentId, TaskEvent, ToolKind } from "@ostra/protocol";
import { z } from "zod";

import type { AcpUpdate, MapContext, PermissionRequest } from "../base.ts";

// The ACP-to-ostra event mapping every agent shares (ADR 0018, ADR 0036, Q124), by the table in
// `research/agent-ui-stream.md`. Ported from spikes/live-stream-and-task-view/src/producer/
// acp-map.ts, reshaped to the driver's seam: one update in, events out, with the mapper keeping
// the open text segment per session.
//
// ACP is vendor-owned, so every schema here tolerates unknown fields (AGENTS.md). Nothing an
// agent sends is dropped silently: an update the table has no row for becomes `agent.unknown`.
// An ACP type never leaves this file: the events are ostra's own.
//
// The rows it implements (the table's numbers):
//   2   user_message_chunk             ignored: the server's `user.message` is authoritative
//   3   agent_message_chunk, text      buffered into one segment, `agent.message` when it closes
//   4   agent_message_chunk, non-text  `agent.content`
//   5   agent_thought_chunk            as 3, `agent.thought`
//   6   tool_call                      `tool.called`. A call that comes without its input (OpenCode
//                                      sends a command or a path in the call's first update) is held
//                                      until that update, and no longer than the next update that
//                                      isn't about a tool call, or the turn's end
//   7   tool_call_update in_progress   `tool.progress`, for any tool with content
//   8   tool_call_update completed     `tool.completed`
//   9   tool_call_update failed        `tool.failed`
//   14  plan                           `plan.updated`
//   15  available_commands_update      ignored (task state, not a message)
//   16  current_mode_update,           `session.config_changed`
//       config_option_update
//   17  session_info_update            ignored (task state)
//   18  usage_update                   `session.usage`, once per turn, when the turn ends
//   19  notice                         ignored (display only, "not part of session history")
//   20  compaction_update              `compaction.updated`; its summary chunks join the summary
//   -   anything else                  `agent.unknown`
// Rows 10 to 13 (permissions and questions) are the driver's callbacks, and 21 to 22 (the turn's
// end) are the base class's.

// ---------- the ACP shapes ostra reads ----------

const location = z.looseObject({ path: z.string() });
const textContent = z.looseObject({ type: z.string(), text: z.string().optional() });
const toolContent = z.looseObject({
  type: z.string(),
  content: textContent.optional(),
  path: z.string().optional(),
  oldText: z.string().nullish(),
  newText: z.string().optional(),
});

const toolCallFields = z.looseObject({
  toolCallId: z.string().min(1),
  title: z.string().nullish(),
  kind: z.string().nullish(),
  status: z.string().nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: z.array(location).nullish(),
  content: z.array(toolContent).nullish(),
});
type ToolCallFields = z.infer<typeof toolCallFields>;

const chunkFields = z.looseObject({ content: z.looseObject({ type: z.string() }), messageId: z.string().nullish() });

const planFields = z.looseObject({
  entries: z.array(
    z.looseObject({
      content: z.string(),
      priority: z.enum(["high", "medium", "low"]).catch("medium"),
      status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
    }),
  ),
});

const modeFields = z.looseObject({ currentModeId: z.string().min(1) });

const configFields = z.looseObject({
  configOptions: z.array(z.looseObject({ id: z.string().min(1), currentValue: z.unknown().optional() })),
});

const usageFields = z.looseObject({ used: z.number().nonnegative(), size: z.number().nonnegative() });

const compactionFields = z.looseObject({ status: z.string().nullish() });
const summaryFields = z.looseObject({ content: textContent.optional() });

const imageContent = z.looseObject({
  type: z.literal("image"),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  uri: z.string().nullish(),
});
const resourceLinkContent = z.looseObject({
  type: z.literal("resource_link"),
  uri: z.string(),
  name: z.string().nullish(),
  title: z.string().nullish(),
});

/** What an update the table doesn't place carries away, capped (the event schema allows 4000). */
const RAW_MAX_CHARS = 4000;
const TOOL_TEXT_MAX_CHARS = 20_000;
const PATCH_MAX_CHARS = 20_000;
const SUMMARY_MAX_CHARS = 20_000;

// JSON.stringify returns undefined for a value JSON can't hold: the types say string, the run time
// does not.
const stringify: (value: unknown) => string | undefined = JSON.stringify;

const rawText = (raw: unknown): string => (stringify(raw) ?? "null").slice(0, RAW_MAX_CHARS);

/** A value as JSON, for an event's `input` and `output`: anything JSON can't hold becomes `null`. */
const toJson = (value: unknown): z.infer<ReturnType<typeof z.json>> => {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : null;
};

const countLines = (text: string | null | undefined): number =>
  text === null || text === undefined || text === "" ? 0 : text.split("\n").length;

const toolKinds = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode"] as const;

const toToolKind = (kind: string | null | undefined): ToolKind => {
  const found = toolKinds.find((known) => known === kind);
  return found ?? "other";
};

const textOf = (call: ToolCallFields): string =>
  (call.content ?? [])
    .map((entry) => entry.content?.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");

const recordOf = (value: unknown): Record<string, unknown> => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
};

/** Normalises a tool call's input for the kinds the panel draws itself (`typedToolSchemas`). */
const normalizeInput = (kind: ToolKind, call: ToolCallFields): z.infer<ReturnType<typeof z.json>> => {
  const raw = recordOf(call.rawInput);
  const path = call.locations?.[0]?.path ?? firstString(raw["filePath"], raw["path"], raw["file_path"]);
  switch (kind) {
    case "read":
      return path === undefined ? toJson(call.rawInput) : { path };
    case "edit": {
      const paths = (call.locations ?? []).map((entry) => entry.path);
      if (paths.length === 0 && path !== undefined) {
        paths.push(path);
      }
      return paths.length === 0 ? toJson(call.rawInput) : { paths };
    }
    case "execute": {
      const command = firstString(raw["command"], raw["cmd"]);
      const cwd = firstString(raw["cwd"], raw["workdir"]);
      return command === undefined ? toJson(call.rawInput) : { command, ...(cwd === undefined ? {} : { cwd }) };
    }
    case "delete":
    case "move":
    case "search":
    case "think":
    case "fetch":
    case "switch_mode":
    case "other":
      return toJson(call.rawInput ?? {});
    default:
      return kind satisfies never;
  }
};

/** Normalises a finished (or progressing) tool call's output for the kinds the panel draws itself. */
const normalizeOutput = (kind: ToolKind, call: ToolCallFields, exitCode: number | null): z.infer<ReturnType<typeof z.json>> => {
  switch (kind) {
    case "edit": {
      const files = (call.content ?? [])
        .filter((entry) => entry.type === "diff" && entry.path !== undefined)
        .map((entry) => ({
          path: entry.path ?? "",
          added: countLines(entry.newText),
          removed: countLines(entry.oldText),
          patch: `${(entry.oldText ?? "").split("\n").map((line) => `-${line}`).join("\n")}\n${(entry.newText ?? "")
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")}`.slice(0, PATCH_MAX_CHARS),
        }));
      return { files };
    }
    case "execute": {
      const text = textOf(call);
      return { output: text.slice(0, TOOL_TEXT_MAX_CHARS), truncated: text.length > TOOL_TEXT_MAX_CHARS, exitCode };
    }
    case "read": {
      const text = textOf(call);
      return text === "" ? {} : { lineCount: countLines(text) };
    }
    case "delete":
    case "move":
    case "search":
    case "think":
    case "fetch":
    case "switch_mode":
    case "other":
      return toJson(call.rawOutput ?? (textOf(call) === "" ? {} : { text: textOf(call).slice(0, TOOL_TEXT_MAX_CHARS) }));
    default:
      return kind satisfies never;
  }
};

/**
 * A call that came without its input: nothing but a working folder, and no location. OpenCode sends
 * a shell call's command, and a read's path, in the call's first update.
 */
const lacksInput = (call: ToolCallFields): boolean => {
  const raw = recordOf(call.rawInput);
  if (toToolKind(call.kind) === "execute") {
    // A shell call's location is the folder it runs in, not what it runs.
    return firstString(raw["command"], raw["cmd"]) === undefined;
  }
  return (call.locations ?? []).length === 0 && Object.keys(raw).every((key) => key === "cwd");
};

/** Held while it lacks its input and nothing has happened yet that the panel must show. */
const stillWaiting = (call: ToolCallFields): boolean =>
  lacksInput(call) && call.status !== "completed" && call.status !== "failed" && (call.content ?? []).length === 0;

/** A held call with what its update added: later fields win, and the input's keys are merged. */
const mergeCallFields = (first: ToolCallFields, next: ToolCallFields): ToolCallFields => ({
  ...first,
  title: next.title ?? first.title,
  kind: next.kind ?? first.kind,
  status: next.status ?? first.status,
  rawInput: { ...recordOf(first.rawInput), ...recordOf(next.rawInput) },
  rawOutput: next.rawOutput ?? first.rawOutput,
  locations: next.locations ?? first.locations,
  content: next.content ?? first.content,
});

// ---------- the mapper ----------

type Open = { readonly part: "message" | "thought"; readonly messageId: string | null; readonly segmentId: SegmentId; text: string };

/** A delta of the text still being written: what live-text frames are made of (ADR 0035). */
export type LiveTextDelta = {
  readonly turnId: MapContext["turnId"];
  readonly segmentId: SegmentId;
  readonly kind: "message" | "thought";
  /** Where in the segment this text starts, in UTF-16 code units. 0 is a new segment. */
  readonly offset: number;
  readonly text: string;
};

export type AcpMapper = {
  /** One update in, events out. It never throws on vendor data. */
  readonly map: (update: AcpUpdate, context: MapContext) => readonly TaskEvent[];
  /** The turn ended: closes the open segment and reports the usage the agent last gave. */
  readonly finishTurn: (context: MapContext) => readonly TaskEvent[];
};

/** One mapper per session: it holds that session's open text segment, tool kinds and config. */
export const createAcpMapper = (options: { readonly onLiveText?: (delta: LiveTextDelta) => void } = {}): AcpMapper => {
  let open: Open | undefined;
  let turnKey = "";
  let segments = 0;
  let usage: { readonly used: number; readonly size: number } | undefined;
  let compactionSummary = "";
  const kindsById = new Map<string, ToolKind>();
  const config = new Map<string, string>();
  /** Calls waiting for their input: emitted with the next update, whichever it is. */
  const held = new Map<string, { readonly turnId: MapContext["turnId"]; readonly fields: ToolCallFields }>();

  const calledEvent = (turnId: MapContext["turnId"], toolCallId: z.infer<typeof toolCallIdSchema>, fields: ToolCallFields): TaskEvent => {
    const toolKind = kindsById.get(toolCallId) ?? toToolKind(fields.kind);
    return {
      kind: "tool.called",
      turnId,
      toolCallId,
      toolKind,
      title: (fields.title ?? toolKind).slice(0, 2000),
      input: normalizeInput(toolKind, fields),
    };
  };

  /** Emits every held call as it stands. */
  const releaseHeld = (out: TaskEvent[]): void => {
    for (const [id, call] of held) {
      held.delete(id);
      const toolCallId = toolCallIdSchema.safeParse(id);
      if (toolCallId.success) {
        out.push(calledEvent(call.turnId, toolCallId.data, call.fields));
      }
    }
  };

  const startTurnIfNew = (context: MapContext): void => {
    if (turnKey !== context.turnId) {
      turnKey = context.turnId;
      segments = 0;
    }
  };

  const flush = (context: MapContext, out: TaskEvent[]): void => {
    const text = open;
    open = undefined;
    if (text === undefined || text.text === "") {
      return;
    }
    out.push(
      text.part === "message"
        ? { kind: "agent.message", turnId: context.turnId, segmentId: text.segmentId, text: text.text }
        : { kind: "agent.thought", turnId: context.turnId, segmentId: text.segmentId, text: text.text },
    );
  };

  /** The one way an update the table has no row for leaves: visible, never dropped (ADR 0018). */
  const unknown = (context: MapContext, out: TaskEvent[], acpKind: string, raw: unknown): void => {
    flush(context, out);
    out.push({ kind: "agent.unknown", acpKind: acpKind.slice(0, 200), raw: rawText(raw) });
  };

  const setConfig = (key: string, value: string, out: TaskEvent[]): void => {
    if (config.get(key) === value) {
      return;
    }
    config.set(key, value);
    out.push({ kind: "session.config_changed", key: key.slice(0, 200), value: value.slice(0, 2000) });
  };

  const text = (part: "message" | "thought", update: AcpUpdate, context: MapContext, out: TaskEvent[]): void => {
    const chunk = chunkFields.safeParse(update);
    if (!chunk.success) {
      unknown(context, out, update.sessionUpdate, update);
      return;
    }
    const content = chunk.data.content;
    const messageId = chunk.data.messageId ?? null;
    if (content.type !== "text") {
      flush(context, out);
      const block = part === "message" ? toContentBlock(content) : undefined;
      if (block === undefined) {
        unknown(context, out, `${update.sessionUpdate}:${content.type}`, update);
      } else {
        out.push({ kind: "agent.content", turnId: context.turnId, block });
      }
      return;
    }
    const piece = textContent.safeParse(content);
    if (!piece.success || piece.data.text === undefined) {
      unknown(context, out, `${update.sessionUpdate}:text`, update);
      return;
    }
    startTurnIfNew(context);
    // A new message ID, a switch between message and thought, or a new turn closes the segment.
    if (open !== undefined && (open.part !== part || open.messageId !== messageId)) {
      flush(context, out);
    }
    if (open === undefined) {
      segments += 1;
      open = { part, messageId, segmentId: segmentIdSchema.parse(`${context.turnId}-s${String(segments)}`), text: "" };
    }
    const offset = open.text.length;
    open.text += piece.data.text;
    options.onLiveText?.({ turnId: context.turnId, segmentId: open.segmentId, kind: part, offset, text: piece.data.text });
  };

  const map = (update: AcpUpdate, context: MapContext): readonly TaskEvent[] => {
    const out: TaskEvent[] = [];
    const kind = update.sessionUpdate;
    // Tool calls run in parallel: only an update that isn't about tools releases the held ones.
    if (kind !== "tool_call" && kind !== "tool_call_update") {
      releaseHeld(out);
    }
    switch (kind) {
      case "agent_message_chunk":
        text("message", update, context, out);
        return out;
      case "agent_thought_chunk":
        text("thought", update, context, out);
        return out;
      case "tool_call": {
        const call = toolCallFields.safeParse(update);
        const toolCallId = toolCallIdSchema.safeParse(call.success ? call.data.toolCallId : undefined);
        if (!call.success || !toolCallId.success) {
          unknown(context, out, kind, update);
          return out;
        }
        flush(context, out);
        const toolKind = toToolKind(call.data.kind);
        kindsById.set(toolCallId.data, toolKind);
        if (stillWaiting(call.data)) {
          held.set(toolCallId.data, { turnId: context.turnId, fields: call.data });
          return out;
        }
        out.push(calledEvent(context.turnId, toolCallId.data, call.data));
        return out;
      }
      case "tool_call_update": {
        const call = toolCallFields.safeParse(update);
        const toolCallId = toolCallIdSchema.safeParse(call.success ? call.data.toolCallId : undefined);
        if (!call.success || !toolCallId.success) {
          unknown(context, out, kind, update);
          return out;
        }
        const waiting = held.get(toolCallId.data);
        if (waiting !== undefined) {
          held.delete(toolCallId.data);
          const merged = mergeCallFields(waiting.fields, call.data);
          if (stillWaiting(merged)) {
            held.set(toolCallId.data, { turnId: waiting.turnId, fields: merged });
            return out;
          }
          out.push(calledEvent(waiting.turnId, toolCallId.data, merged));
        }
        const toolKind = kindsById.get(toolCallId.data) ?? toToolKind(call.data.kind);
        if (call.data.status === "completed") {
          out.push({ kind: "tool.completed", toolCallId: toolCallId.data, output: normalizeOutput(toolKind, call.data, 0) });
        } else if (call.data.status === "failed") {
          out.push({ kind: "tool.failed", toolCallId: toolCallId.data, error: (textOf(call.data) || "tool failed").slice(0, 4000) });
        } else if (call.data.status === "in_progress" && (call.data.content?.length ?? 0) > 0) {
          out.push({ kind: "tool.progress", toolCallId: toolCallId.data, output: normalizeOutput(toolKind, call.data, null) });
        }
        // `pending`, and `in_progress` with nothing new to show: a status change, not an event.
        return out;
      }
      case "plan": {
        const plan = planFields.safeParse(update);
        if (!plan.success) {
          unknown(context, out, kind, update);
          return out;
        }
        flush(context, out);
        const entries: PlanEntry[] = plan.data.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        }));
        out.push({ kind: "plan.updated", turnId: context.turnId, entries });
        return out;
      }
      case "current_mode_update": {
        const mode = modeFields.safeParse(update);
        if (!mode.success) {
          unknown(context, out, kind, update);
          return out;
        }
        setConfig("mode", mode.data.currentModeId, out);
        return out;
      }
      case "config_option_update": {
        const options = configFields.safeParse(update);
        if (!options.success) {
          unknown(context, out, kind, update);
          return out;
        }
        for (const option of options.data.configOptions) {
          const value = option.currentValue;
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            setConfig(option.id, String(value), out);
          }
        }
        return out;
      }
      case "usage_update": {
        const parsed = usageFields.safeParse(update);
        if (!parsed.success) {
          unknown(context, out, kind, update);
          return out;
        }
        // Once per turn: the last figure the agent gave, reported when the turn ends.
        usage = { used: parsed.data.used, size: parsed.data.size };
        return out;
      }
      case "compaction_update": {
        const parsed = compactionFields.safeParse(update);
        const status = parsed.success ? (parsed.data.status ?? "running") : undefined;
        if (status === undefined || !["running", "completed", "done"].includes(status)) {
          unknown(context, out, kind, update);
          return out;
        }
        flush(context, out);
        if (status === "running") {
          compactionSummary = "";
          out.push({ kind: "compaction.updated", turnId: context.turnId, status: "running" });
        } else {
          out.push({
            kind: "compaction.updated",
            turnId: context.turnId,
            status: "done",
            ...(compactionSummary === "" ? {} : { summary: compactionSummary }),
          });
          compactionSummary = "";
        }
        return out;
      }
      case "compaction_summary_chunk": {
        const parsed = summaryFields.safeParse(update);
        if (!parsed.success) {
          unknown(context, out, kind, update);
          return out;
        }
        compactionSummary = `${compactionSummary}${parsed.data.content?.text ?? ""}`.slice(0, SUMMARY_MAX_CHARS);
        return out;
      }
      case "user_message_chunk":
      case "available_commands_update":
      case "session_info_update":
      case "notice":
        // Task state or display only: not a message, and not unknown (rows 2, 15, 17, 19).
        return out;
      default:
        unknown(context, out, kind, update);
        return out;
    }
  };

  const finishTurn = (context: MapContext): readonly TaskEvent[] => {
    const out: TaskEvent[] = [];
    releaseHeld(out);
    flush(context, out);
    if (usage !== undefined) {
      out.push({
        kind: "session.usage",
        contextUsed: Math.round(usage.used),
        contextSize: Math.round(usage.size),
      });
      usage = undefined;
    }
    return out;
  };

  return { map, finishTurn };
};

const toContentBlock = (content: { readonly type: string }): ContentBlock | undefined => {
  const image = imageContent.safeParse(content);
  if (image.success) {
    const mediaType = image.data.mimeType ?? "image/*";
    const url = image.data.data === undefined ? image.data.uri : `data:${mediaType};base64,${image.data.data}`;
    return url === undefined || url === null ? undefined : { type: "image", mediaType, url };
  }
  const link = resourceLinkContent.safeParse(content);
  if (link.success) {
    return { type: "resource_link", uri: link.data.uri, title: link.data.title ?? link.data.name ?? link.data.uri };
  }
  return undefined;
};

/**
 * An ACP permission request's options as the approval card shows them (ADR 0036, F-026): ACP's
 * four kinds become ostra's, and `allow_always` is "allow for this task". An option whose ID
 * can't be an ID is left out; none left means no card.
 */
export const toApprovalOptions = (request: PermissionRequest): readonly ApprovalOption[] => {
  const options: ApprovalOption[] = [];
  for (const option of request.options) {
    const optionId = optionIdSchema.safeParse(option.optionId);
    if (!optionId.success) {
      continue;
    }
    const label = option.name.slice(0, 500);
    switch (option.kind) {
      case "allow_once":
        options.push({ optionId: optionId.data, label, kind: "allow-once", decision: "allow_once" });
        break;
      case "allow_always":
        options.push({ optionId: optionId.data, label, kind: "allow-always", decision: "allow_task" });
        break;
      case "reject_always":
        options.push({ optionId: optionId.data, label, kind: "reject-always", decision: "deny" });
        break;
      default:
        options.push({ optionId: optionId.data, label, kind: "reject-once", decision: "deny" });
        break;
    }
  }
  return options;
};
