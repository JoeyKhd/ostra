import type { Db } from "@ostra/db";
import { taskIdSchema, toolKindSchema } from "@ostra/protocol";
import type { TaskId, ToolKind } from "@ostra/protocol";
import { z } from "zod";

// What the agent is doing now, for a list of tasks (F-086, home.md): the newest event of a few kinds,
// worded by the panel. The project's task list and Home's board both read it.

/** The kinds of event the list words as "what the agent is doing now", newest wins. */
const doingKinds = [
  "tool.called",
  "agent.message",
  "agent.thought",
  "environment.setup_started",
  "environment.setup_output",
  "approval.requested",
  "question.asked",
  "git.pushed",
] as const;

export type DoingKind = (typeof doingKinds)[number];

/**
 * What the agent is doing now, for the list: a kind the panel words, and its detail. For a tool
 * call or an approval, `detail` is the command (`execute`) or the path (`edit`, `read`), and
 * `toolKind` says which; for another tool it's the tool's title, with `toolKind` null. For a
 * question it's the question.
 */
export type Doing = { readonly kind: DoingKind; readonly detail: string | null; readonly toolKind: ToolKind | null };

const DETAIL_MAX = 160;

const toolCallPayload = z.looseObject({ toolKind: toolKindSchema, title: z.string(), input: z.unknown() });
const pathInput = z.union([
  z.looseObject({ path: z.string().min(1) }).transform((input) => input.path),
  z.looseObject({ paths: z.tuple([z.string().min(1)], z.string()) }).transform((input) => input.paths[0]),
]);
const toolCallIdPayload = z.looseObject({ toolCallId: z.string() });
const questionPayload = z.looseObject({ message: z.string() });

/** A tool call's command or path, or its title when it names neither. */
const toolDetailOf = (payload: unknown): Pick<Doing, "detail" | "toolKind"> => {
  const call = toolCallPayload.safeParse(payload);
  if (!call.success) return { detail: null, toolKind: null };
  const { toolKind, title, input } = call.data;
  if (toolKind === "execute") return { detail: title.slice(0, DETAIL_MAX), toolKind };
  if (toolKind === "edit" || toolKind === "read") {
    const path = pathInput.safeParse(input);
    if (path.success) return { detail: path.data.slice(0, DETAIL_MAX), toolKind };
  }
  return { detail: title.slice(0, DETAIL_MAX), toolKind: null };
};

/** `toolCall`: the tool call an approval asks about, when there is one. */
const doingOf = (kind: DoingKind, payload: unknown, toolCall: unknown): Doing => {
  switch (kind) {
    case "tool.called":
      return { kind, ...toolDetailOf(payload) };
    case "approval.requested":
      return toolCall === undefined ? { kind, detail: null, toolKind: null } : { kind, ...toolDetailOf(toolCall) };
    case "question.asked": {
      const question = questionPayload.safeParse(payload);
      return { kind, detail: question.success && question.data.message !== "" ? question.data.message.slice(0, DETAIL_MAX) : null, toolKind: null };
    }
    case "agent.message":
    case "agent.thought":
    case "environment.setup_started":
    case "environment.setup_output":
    case "git.pushed":
      return { kind, detail: null, toolKind: null };
    default:
      return kind satisfies never;
  }
};

const latestDoingRow = z.object({ taskId: taskIdSchema, kind: z.enum(doingKinds), payload: z.unknown() });

/** The latest "doing" event of each task given, with an approval's tool call looked up. One round trip per kind of lookup. */
export const loadDoingByTask = async (db: Db, taskIds: readonly string[]): Promise<ReadonlyMap<TaskId, Doing>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const latest: unknown = await db.$queryRaw`
    SELECT DISTINCT ON ("taskId") "taskId", "kind", "payload" FROM "event"
    WHERE "taskId" = ANY(${[...taskIds]}::text[]) AND "kind" = ANY(${[...doingKinds]}::text[])
    ORDER BY "taskId", "seq" DESC`;
  const latestRows = z.array(latestDoingRow).parse(latest);
  // An approval asks about a tool call: its command or path is what the row shows.
  const asked = latestRows.flatMap((row) => {
    const call = row.kind === "approval.requested" ? toolCallIdPayload.safeParse(row.payload) : null;
    return call?.success === true ? [{ taskId: row.taskId, toolCallId: call.data.toolCallId }] : [];
  });
  const calls =
    asked.length === 0
      ? []
      : z.array(z.object({ taskId: taskIdSchema, payload: z.unknown() })).parse(
          await db.$queryRaw`
            SELECT "taskId", "payload" FROM "event"
            WHERE "taskId" = ANY(${asked.map((row) => row.taskId)}::text[]) AND "kind" = 'tool.called'
              AND "payload"->>'toolCallId' = ANY(${asked.map((row) => row.toolCallId)}::text[])`,
        );
  const toolCallOf = (taskId: TaskId, payload: unknown): unknown => {
    const id = toolCallIdPayload.safeParse(payload);
    if (!id.success) return undefined;
    return calls.find((call) => call.taskId === taskId && toolCallIdPayload.safeParse(call.payload).data?.toolCallId === id.data.toolCallId)?.payload;
  };
  return new Map(latestRows.map((row) => [row.taskId, doingOf(row.kind, row.payload, toolCallOf(row.taskId, row.payload))] as const));
};
