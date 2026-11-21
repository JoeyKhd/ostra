import type { ThreadMessageLike } from "@assistant-ui/react";
import { approvalDescriptorSchema, approvalMetadataSchema } from "@ostra/task-view";
import type { ApprovalDescriptor, TaskUIMessage, TaskUIPart } from "@ostra/task-view";

// TaskUIMessage → assistant-ui's ThreadMessageLike (ADR 0036). assistant-ui types `args`, `result`
// and data parts as `any`, so ostra's renderers never read them: they read the typed part from
// ostra's own store by id (task-context.ts). What goes in here is only what assistant-ui needs to
// lay out the thread. Ported from spikes/live-stream-and-task-view/src/web/convert.ts.

type ThreadPart = Exclude<ThreadMessageLike["content"], string>[number];
type Approval = NonNullable<Extract<ThreadPart, { type: "tool-call" }>["approval"]>;

const readDescriptor = (descriptor: unknown): ApprovalDescriptor | undefined => {
  const parsed = approvalDescriptorSchema.safeParse(descriptor);
  return parsed.success ? parsed.data : undefined;
};

const optionsOf = (descriptor: ApprovalDescriptor | undefined): NonNullable<Approval["options"]> =>
  (descriptor?.options ?? []).map((option) => ({ id: option.optionId, kind: option.kind, label: option.label }));

type ToolLike = Extract<TaskUIPart, { toolCallId: string }>;

const toolPart = (part: ToolLike): ThreadPart => {
  const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
  const base = { type: "tool-call" as const, toolCallId: part.toolCallId, toolName, args: {} };
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return base;
    case "approval-requested":
      return { ...base, approval: { id: part.approval.id, options: optionsOf(readDescriptor(part.approval.descriptor)) } };
    case "approval-responded":
      return {
        ...base,
        approval: { id: part.approval.id, approved: part.approval.approved, options: optionsOf(readDescriptor(part.approval.descriptor)) },
      };
    case "output-available":
      return { ...base, result: "ok", ...(part.preliminary === true ? { isPreliminary: true } : {}) };
    case "output-error": {
      const closed = approvalMetadataSchema.safeParse(part.toolMetadata);
      const approval = closed.success && closed.data.approval.descriptor.receipt?.state === "closed" ? closed.data.approval : undefined;
      const receipt = approval?.descriptor.receipt;
      return {
        ...base,
        result: part.errorText,
        isError: true,
        ...(approval === undefined
          ? {}
          : {
              approval: {
                id: approval.id,
                options: optionsOf(approval.descriptor),
                resolution: receipt?.state === "closed" && receipt.reason === "expired" ? ("expired" as const) : ("cancelled" as const),
              },
            }),
      };
    }
    case "output-denied":
      return {
        ...base,
        result: "denied",
        approval: { id: part.approval.id, approved: false, options: optionsOf(readDescriptor(part.approval.descriptor)) },
      };
    default:
      return part satisfies never;
  }
};

const convertPart = (part: TaskUIPart): ThreadPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text, status: { type: part.state === "streaming" ? "running" : "complete" } };
    case "reasoning":
      return { type: "reasoning", text: part.text, status: { type: part.state === "streaming" ? "running" : "complete" } };
    case "step-start":
      return null;
    case "file":
      return { type: "image", image: part.url };
    case "source-url":
      return { type: "source", sourceType: "url", id: part.sourceId, url: part.url, ...(part.title === undefined ? {} : { title: part.title }) };
    case "dynamic-tool":
    case "tool-read":
    case "tool-edit":
    case "tool-execute":
      return toolPart(part);
    case "data-plan":
    case "data-question":
    case "data-compaction":
    case "data-setup":
    case "data-pushed":
    case "data-pr-text":
    case "data-pr":
    case "data-session-end":
    case "data-driver":
    case "data-effort":
    case "data-files-outside":
    case "data-saved":
    case "data-limit":
    case "data-held":
    case "data-released":
    case "data-memory-proposed":
    case "data-pr-comment":
    case "data-ticket-files":
    case "data-attachments":
    case "data-attachment-skipped":
    case "data-app-process":
    case "data-no-browser":
    case "data-system":
    case "data-unsupported":
    case "data-problem":
      return { type: part.type, ...(part.id === undefined ? {} : { id: part.id }), data: part.data };
    case "custom":
    case "source-document":
    case "reasoning-file":
    case "steering-message":
      return null;
    // Milestone 9 (ticket 14): a member's message's files, from the fold. The thread draws them under
    // the message from the fold's part (ticket 16); assistant-ui's user content takes none.
    case "data-message-files":
      return null;
    default:
      return part satisfies never;
  }
};

export const toThreadMessageLike = (message: TaskUIMessage): ThreadMessageLike => {
  const content = message.parts.map(convertPart).filter((part): part is ThreadPart => part !== null);
  const meta = message.metadata;
  if (message.role === "user") {
    return { role: "user", id: message.id, content };
  }
  if (message.role === "system") {
    // assistant-ui takes a system message only with exactly one text part, and ostra's system rows
    // are data parts: they go in as completed assistant-role messages (spike 7), and the page
    // styles them from ostra's own role.
    return { role: "assistant", id: message.id, content, status: { type: "complete", reason: "stop" } };
  }
  const waiting = message.parts.some((part) => "state" in part && part.state === "approval-requested");
  const status: NonNullable<ThreadMessageLike["status"]> = waiting
    ? { type: "requires-action", reason: "tool-calls" }
    : meta?.turnState === "running"
      ? { type: "running" }
      : meta?.turnState === "failed"
        ? { type: "incomplete", reason: "error" }
        : meta?.stopReason === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" };
  return { role: "assistant", id: message.id, content, status };
};
