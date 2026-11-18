// Reading a run's type-only event log (events.jsonl) back as its tool calls:
// which tool each one used, and whether it completed or failed. The escape
// check needs this to tell a call the permission rule refused from one that
// failed for another reason, and from one that worked.

import { z } from "zod";

const eventLine = z.looseObject({
  update: z.string().nullish(),
  toolCallId: z.string().nullish(),
  toolKind: z.string().nullish(),
  status: z.string().nullish(),
});

export type ToolCallResult = {
  readonly id: string;
  /** The ACP tool kind (`edit`, `read`, `execute`...), from the call's first event. */
  readonly kind: string | null;
  /** The last terminal status seen; `unfinished` when none. */
  readonly status: "completed" | "failed" | "unfinished";
};

/** The tool calls of an event log, in the order they began. Lines that are not events are skipped. */
export const toolCallResults = (eventsJsonl: string): ToolCallResult[] => {
  const calls = new Map<string, { kind: string | null; status: ToolCallResult["status"] }>();
  for (const line of eventsJsonl.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = eventLine.safeParse(json);
    if (!parsed.success) continue;
    const { update, toolCallId, toolKind, status } = parsed.data;
    if ((update !== "tool_call" && update !== "tool_call_update") || toolCallId === null || toolCallId === undefined) continue;
    const call = calls.get(toolCallId) ?? { kind: null, status: "unfinished" as const };
    if (call.kind === null && toolKind !== null && toolKind !== undefined) call.kind = toolKind;
    if (status === "completed" || status === "failed") call.status = status;
    calls.set(toolCallId, call);
  }
  return [...calls.entries()].map(([id, call]) => ({ id, kind: call.kind, status: call.status }));
};
