import { z } from "zod";
import type { ApprovalOption, TaskEvent } from "../shared/events.ts";
import { ApprovalId, OptionId, SegmentId, ToolCallId, TurnId } from "../shared/ids.ts";
import type { FileChange, ToolKind } from "../shared/tools.ts";

// A small ACP v1 -> ostra event mapper, enough to replay recorded sessions from spike 1 through the
// same server and page as synthetic ones. In the product this is the runner's AgentAdapter (ADR 0018).
// ACP is vendor-owned, so these schemas tolerate unknown fields. Only spike 1's three tiny probe captures
// (message and thought chunks, no tools) have been through it so far: the rest is a hand-written fixture.
//
// The contract that makes "nothing is dropped silently" testable: every input line bumps exactly one
// counter in the report (mapped, ignored by design, or unknown), and every unknown also becomes an
// `agent.unknown` event, which the page shows as an "unsupported" row. So, for any recording,
// lines = mapped + ignoredByDesign + unknown + rejected (JSON that did not parse), and unknown =
// the number of `agent.unknown` events = the number of "unsupported" rows on the page.

const content = z.looseObject({ type: z.string(), text: z.string().optional() });
const location = z.looseObject({ path: z.string() });
const toolContent = z.looseObject({
  type: z.string(),
  content: content.optional(),
  path: z.string().optional(),
  oldText: z.string().nullish(),
  newText: z.string().optional(),
});

const update = z.looseObject({ sessionUpdate: z.string() });
const sessionUpdateParams = z.looseObject({ sessionId: z.string().optional(), update });

const toolCallUpdate = z.looseObject({
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: z.array(location).optional(),
  content: z.array(toolContent).optional(),
});

const planUpdate = z.looseObject({
  entries: z.array(
    z.looseObject({
      content: z.string(),
      priority: z.enum(["high", "medium", "low"]).catch("medium"),
      status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
    }),
  ),
});

const permissionParams = z.looseObject({
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() })),
});

const message = z.looseObject({
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  id: z.union([z.string(), z.number()]).optional(),
});

const stopResult = z.looseObject({ stopReason: z.string() });
const stopReasons = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const compactionStatus = z.enum(["running", "completed", "done"]);

export type AcpReport = {
  mapped: Map<string, number>;
  ignoredByDesign: Map<string, number>;
  unknown: Map<string, number>;
};

export const newReport = (): AcpReport => ({ mapped: new Map(), ignoredByDesign: new Map(), unknown: new Map() });

export const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

export const sumOf = (map: ReadonlyMap<string, number>): number => {
  let total = 0;
  for (const n of map.values()) total += n;
  return total;
};

// Task state, not messages (research/agent-ui-stream.md, mapping rows 15 to 19).
const taskStateUpdates = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "user_message_chunk",
]);

type Pending = { part: "message" | "thought"; text: string; messageId: string | null };

export type AcpMapper = {
  readonly report: AcpReport;
  // One raw ACP line in, ostra events out. It does not throw on vendor data: a line it cannot use is
  // counted as unknown and comes out as an `agent.unknown` event.
  readonly map: (raw: unknown) => TaskEvent[];
  readonly finish: () => TaskEvent[];
};

// JSON.stringify returns undefined for a value JSON cannot hold (the types say string, the runtime does not)
const stringify: (value: unknown) => string | undefined = JSON.stringify;

const rawText = (raw: unknown): string => (stringify(raw) ?? "null").slice(0, 4000);

export const createAcpMapper = (prefix: string): AcpMapper => {
  const report = newReport();
  const safePrefix = prefix.slice(0, 80);
  let turn = 0;
  let segment = 0;
  let turnOpen = false;
  let pending: Pending | null = null;
  const toolKinds = new Map<string, ToolKind>();

  const turnId = (): TurnId => TurnId.parse(`${safePrefix}-turn-${String(turn)}`);

  const ensureTurn = (out: TaskEvent[]): void => {
    if (turnOpen) return;
    turn += 1;
    turnOpen = true;
    out.push({ kind: "turn.started", turnId: turnId() });
  };

  const flushText = (out: TaskEvent[]): void => {
    const text = pending;
    if (text === null) return;
    pending = null;
    segment += 1;
    const segmentId = SegmentId.parse(`${safePrefix}-seg-${String(segment)}`);
    out.push(
      text.part === "message"
        ? { kind: "agent.message", turnId: turnId(), segmentId, text: text.text }
        : { kind: "agent.thought", turnId: turnId(), segmentId, text: text.text },
    );
  };

  // The one way a line this mapper cannot use leaves it: counted, and visible as an unsupported row.
  const unknown = (out: TaskEvent[], key: string, acpKind: string, raw: unknown): void => {
    flushText(out);
    bump(report.unknown, key);
    out.push({ kind: "agent.unknown", acpKind: acpKind.slice(0, 200), raw: rawText(raw) });
  };

  const map = (raw: unknown): TaskEvent[] => {
    const out: TaskEvent[] = [];
    const parsed = message.safeParse(raw);
    if (!parsed.success) {
      unknown(out, "unreadable-line", "unreadable-line", raw);
      return out;
    }
    const msg = parsed.data;
    if (msg.method === "session/prompt") {
      flushText(out);
      turnOpen = false;
      ensureTurn(out);
      bump(report.mapped, "session/prompt");
      return out;
    }
    const stop = stopResult.safeParse(msg.result);
    if (stop.success) {
      flushText(out);
      ensureTurn(out);
      const reason = stopReasons.safeParse(stop.data.stopReason);
      if (reason.success) {
        bump(report.mapped, "stopReason");
        out.push({ kind: "turn.ended", turnId: turnId(), stopReason: reason.data });
      } else {
        // closed as end_turn so the page does not hang on a running turn, and said out loud
        unknown(out, "stopReason:unrecognized", `stopReason:${stop.data.stopReason}`, raw);
        out.push({ kind: "turn.ended", turnId: turnId(), stopReason: "end_turn" });
      }
      turnOpen = false;
      return out;
    }
    if (msg.method === "session/request_permission") {
      const params = permissionParams.safeParse(msg.params);
      if (!params.success) {
        unknown(out, "session/request_permission", "session/request_permission", raw);
        return out;
      }
      const toolCallId = ToolCallId.safeParse(params.data.toolCall.toolCallId);
      const approvalId = ApprovalId.safeParse(`${safePrefix}-approval-${params.data.toolCall.toolCallId}`);
      const options: ApprovalOption[] = [];
      for (const o of params.data.options) {
        const optionId = OptionId.safeParse(o.optionId);
        if (!optionId.success) continue;
        switch (o.kind) {
          case "allow_once":
            options.push({ optionId: optionId.data, label: o.name, kind: "allow-once", decision: "allow_once" });
            break;
          case "allow_always":
            options.push({ optionId: optionId.data, label: o.name, kind: "allow-always", decision: "allow_task" });
            break;
          case "reject_always":
            options.push({ optionId: optionId.data, label: o.name, kind: "reject-always", decision: "deny" });
            break;
          default:
            options.push({ optionId: optionId.data, label: o.name, kind: "reject-once", decision: "deny" });
            break;
        }
      }
      // an option with an unusable id is dropped from the card, so a card with none left is not shown as a card
      if (!toolCallId.success || !approvalId.success || options.length === 0) {
        unknown(out, "session/request_permission", "session/request_permission", raw);
        return out;
      }
      flushText(out);
      ensureTurn(out);
      out.push({ kind: "approval.requested", turnId: turnId(), approvalId: approvalId.data, toolCallId: toolCallId.data, options });
      bump(report.mapped, "session/request_permission");
      return out;
    }
    if (msg.method === undefined && msg.id === undefined) {
      // neither a request, a notification nor a response: not ACP, or a format this mapper has not met
      unknown(out, "no-method-no-id", "no-method-no-id", raw);
      return out;
    }
    if (msg.method !== "session/update") {
      bump(report.ignoredByDesign, msg.method ?? "response");
      return out;
    }
    const params = sessionUpdateParams.safeParse(msg.params);
    if (!params.success) {
      unknown(out, "session/update", "session/update", raw);
      return out;
    }
    const body = params.data.update;
    const kind = body.sessionUpdate;
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const chunk = content.safeParse(body["content"]);
        const part = kind === "agent_message_chunk" ? "message" : "thought";
        if (!chunk.success || chunk.data.type !== "text" || chunk.data.text === undefined) {
          unknown(out, `${kind}:non-text`, kind, body);
          return out;
        }
        ensureTurn(out);
        const messageId = z.string().nullable().catch(null).parse(body["messageId"] ?? null);
        if (pending !== null && (pending.part !== part || pending.messageId !== messageId)) flushText(out);
        pending ??= { part, text: "", messageId };
        pending.text += chunk.data.text;
        bump(report.mapped, kind);
        return out;
      }
      case "tool_call": {
        const call = toolCallUpdate.safeParse(body);
        const toolCallId = ToolCallId.safeParse(call.success ? call.data.toolCallId : undefined);
        if (!call.success || !toolCallId.success) {
          unknown(out, kind, kind, body);
          return out;
        }
        flushText(out);
        ensureTurn(out);
        const toolKind = toToolKind(call.data.kind);
        toolKinds.set(toolCallId.data, toolKind);
        out.push({
          kind: "tool.called",
          turnId: turnId(),
          toolCallId: toolCallId.data,
          toolKind,
          title: call.data.title ?? toolKind,
          input: normalizeInput(toolKind, call.data),
        });
        bump(report.mapped, kind);
        return out;
      }
      case "tool_call_update": {
        const call = toolCallUpdate.safeParse(body);
        const toolCallId = ToolCallId.safeParse(call.success ? call.data.toolCallId : undefined);
        if (!call.success || !toolCallId.success) {
          unknown(out, kind, kind, body);
          return out;
        }
        const toolKind = toolKinds.get(toolCallId.data) ?? toToolKind(call.data.kind);
        if (call.data.status === "completed") {
          out.push({ kind: "tool.completed", toolCallId: toolCallId.data, output: normalizeOutput(toolKind, call.data, 0) });
        } else if (call.data.status === "failed") {
          out.push({ kind: "tool.failed", toolCallId: toolCallId.data, error: textOf(call.data) || "tool failed" });
        } else if (call.data.status === "in_progress" && toolKind === "execute") {
          out.push({ kind: "tool.progress", toolCallId: toolCallId.data, output: normalizeOutput(toolKind, call.data, null) });
        } else {
          bump(report.ignoredByDesign, `${kind}:${call.data.status ?? "no-status"}`);
          return out;
        }
        bump(report.mapped, kind);
        return out;
      }
      case "plan": {
        const plan = planUpdate.safeParse(body);
        if (!plan.success) {
          unknown(out, kind, kind, body);
          return out;
        }
        flushText(out);
        ensureTurn(out);
        out.push({
          kind: "plan.updated",
          turnId: turnId(),
          entries: plan.data.entries.map((e) => ({ content: e.content, priority: e.priority, status: e.status })),
        });
        bump(report.mapped, kind);
        return out;
      }
      case "compaction_update": {
        const status = compactionStatus.safeParse(body["status"] ?? "running");
        if (!status.success) {
          unknown(out, kind, kind, body);
          return out;
        }
        flushText(out);
        ensureTurn(out);
        out.push({ kind: "compaction.updated", turnId: turnId(), status: status.data === "running" ? "running" : "done" });
        bump(report.mapped, kind);
        return out;
      }
      default:
        if (taskStateUpdates.has(kind)) {
          bump(report.ignoredByDesign, kind);
          return out;
        }
        // An update this mapper has no kind for: shown as an "unsupported" row, never dropped (ADR 0018).
        unknown(out, kind, kind, body);
        return out;
    }
  };

  return {
    report,
    map,
    finish: () => {
      const out: TaskEvent[] = [];
      flushText(out);
      return out;
    },
  };
};

const toToolKind = (kind: string | undefined): ToolKind => {
  switch (kind) {
    case "read":
    case "edit":
    case "execute":
    case "delete":
    case "move":
    case "search":
    case "fetch":
    case "think":
    case "switch_mode":
      return kind;
    default:
      return "other";
  }
};

const textOf = (call: z.infer<typeof toolCallUpdate>): string =>
  (call.content ?? [])
    .map((c) => c.content?.text ?? "")
    .filter((t) => t.length > 0)
    .join("\n");

const rawInputRecord = (call: z.infer<typeof toolCallUpdate>): Record<string, unknown> => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(call.rawInput);
  return parsed.success ? parsed.data : {};
};

const normalizeInput = (kind: ToolKind, call: z.infer<typeof toolCallUpdate>): unknown => {
  const raw = rawInputRecord(call);
  const firstPath = call.locations?.[0]?.path ?? z.string().optional().catch(undefined).parse(raw["filePath"] ?? raw["path"]);
  switch (kind) {
    case "read":
      return firstPath === undefined ? call.rawInput : { path: firstPath };
    case "edit": {
      const paths = (call.locations ?? []).map((l) => l.path);
      if (paths.length === 0 && firstPath !== undefined) paths.push(firstPath);
      return paths.length === 0 ? call.rawInput : { paths };
    }
    case "execute": {
      const command = z.string().optional().catch(undefined).parse(raw["command"]);
      return command === undefined ? call.rawInput : { command };
    }
    default:
      return call.rawInput ?? {};
  }
};

const countLines = (text: string | null | undefined): number =>
  text === null || text === undefined || text === "" ? 0 : text.split("\n").length;

const normalizeOutput = (kind: ToolKind, call: z.infer<typeof toolCallUpdate>, exitCode: number | null): unknown => {
  switch (kind) {
    case "edit": {
      const files: FileChange[] = (call.content ?? [])
        .filter((c) => c.type === "diff" && c.path !== undefined)
        .map((c) => ({
          path: c.path ?? "",
          added: countLines(c.newText),
          removed: countLines(c.oldText),
          patch: `${(c.oldText ?? "").split("\n").map((l) => `-${l}`).join("\n")}\n${(c.newText ?? "").split("\n").map((l) => `+${l}`).join("\n")}`.slice(0, 20_000),
        }));
      return { files };
    }
    case "execute": {
      const text = textOf(call);
      return { output: text.slice(0, 20_000), truncated: text.length > 20_000, exitCode };
    }
    case "read":
      return {};
    default:
      return call.rawOutput ?? {};
  }
};
