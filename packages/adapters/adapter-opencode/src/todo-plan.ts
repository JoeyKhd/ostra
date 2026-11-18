import type { AcpUpdate } from "@ostra/adapter-sdk";
import { z } from "zod";

// OpenCode sends no ACP `plan` update. Its todo list arrives as a `todowrite` tool call: the list
// is in `rawInput.todos` while the call runs, and in `rawOutput.metadata.todos` when it ends
// (spike 1, T5). The adapter turns each into the ACP `plan` update the shared mapping knows, so
// `plan.updated` keeps its place in the stream, and keeps the tool call itself out of the
// transcript: the plan is how the panel shows it.

const todoSchema = z.looseObject({
  content: z.string(),
  status: z.string().nullish(),
  priority: z.string().nullish(),
});

const todosOf = (value: unknown): z.infer<typeof todoSchema>[] | undefined => {
  const parsed = z.looseObject({ todos: z.array(todoSchema) }).safeParse(value);
  return parsed.success ? parsed.data.todos : undefined;
};

const toolCallSchema = z.looseObject({
  toolCallId: z.string().min(1),
  title: z.string().nullish(),
  name: z.string().nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

const priorities = ["high", "medium", "low"] as const;

const toEntry = (todo: z.infer<typeof todoSchema>) => {
  const priority = priorities.find((known) => known === todo.priority) ?? "medium";
  if (todo.status === "cancelled") {
    // A todo OpenCode gave up on isn't part of the plan any more.
    return undefined;
  }
  const status = todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending";
  return { content: todo.content, priority, status };
};

/** What the adapter does with one update. */
export type TodoOutcome =
  /** Not a todo call: the shared mapping takes it as it is. */
  | { readonly kind: "other" }
  /** A todo call with nothing new to show (the call opening, or the same list again). */
  | { readonly kind: "swallow" }
  /** A todo call with a list: the plan, as an ACP `plan` update. */
  | { readonly kind: "plan"; readonly update: AcpUpdate };

export type TodoTracker = {
  readonly read: (update: AcpUpdate) => TodoOutcome;
};

/** One tracker per session: it knows which tool calls are todo calls, and the last list it sent. */
export const createTodoTracker = (): TodoTracker => {
  const todoCalls = new Set<string>();
  let last = "";
  return {
    read: (update) => {
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return { kind: "other" };
      }
      const call = toolCallSchema.safeParse(update);
      if (!call.success) {
        return { kind: "other" };
      }
      const named = `${call.data.name ?? ""} ${call.data.title ?? ""}`.toLowerCase().includes("todowrite");
      if (named) {
        todoCalls.add(call.data.toolCallId);
      }
      if (!todoCalls.has(call.data.toolCallId)) {
        return { kind: "other" };
      }
      const metadata: unknown = Reflect.get(Object(call.data.rawOutput), "metadata");
      const todos = todosOf(metadata) ?? todosOf(call.data.rawInput);
      if (todos === undefined) {
        return { kind: "swallow" };
      }
      const entries = todos.flatMap((todo) => {
        const entry = toEntry(todo);
        return entry === undefined ? [] : [entry];
      });
      const signature = JSON.stringify(entries);
      if (signature === last) {
        return { kind: "swallow" };
      }
      last = signature;
      return { kind: "plan", update: { sessionUpdate: "plan", entries } };
    },
  };
};
