import type { UIMessage } from "ai";
import { z } from "zod";
import { approvalDecision, approvalOption, type planEntry, type QuestionField, type StopReason, type TaskEvent } from "./events.ts";
import { ApprovalId, MemberId, OptionId, type QuestionId, type TurnId } from "./ids.ts";
import type { ToolInput, ToolOutput, TypedToolKind } from "./tools.ts";

// The AI SDK's UIMessage, with ostra's generics, derived from the Zod schemas and never typed
// again by hand (ADR 0036). `ai` is an `import type` dependency only, so it is erased.

export type TaskUITools = {
  [K in TypedToolKind]: { input: ToolInput<K>; output: ToolOutput<K> };
};

// An approval's life is a discriminated union: a state carries exactly the fields that state has, so
// "auto" with a member, or "answered" with no decision, cannot be written down.
// Carried in `approval.descriptor` of the AI SDK's tool part: the options, and once the approval
// settles, the receipt ("Approved once by Alex").
export const approvalReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("answered"), decision: approvalDecision, optionId: OptionId, by: MemberId }),
  z.strictObject({ state: z.literal("auto"), ruleId: z.string() }),
  z.strictObject({ state: z.literal("closed"), reason: z.enum(["cancelled", "expired"]) }),
]);
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;

export type ApprovalStatus = { readonly state: "pending" } | ApprovalReceipt;

export const approvalDescriptorSchema = z.strictObject({
  options: z.array(approvalOption),
  receipt: approvalReceiptSchema.optional(),
});
export type ApprovalDescriptor = z.infer<typeof approvalDescriptorSchema>;

export const approvalMetadataSchema = z.strictObject({
  approval: z.strictObject({ id: ApprovalId, descriptor: approvalDescriptorSchema }),
});

export type SystemEvent = Extract<
  TaskEvent,
  {
    kind:
      | "driver.changed"
      | "runner.connected"
      | "runner.lost"
      | "session.restored"
      | "session.crashed"
      | "pr.opened"
      | "session.config_changed"
      | "turn.cancel_requested";
  }
>;

export type QuestionStatus =
  | { readonly state: "open" }
  | { readonly state: "answered"; readonly answers: Readonly<Record<string, string>>; readonly answeredBy: MemberId }
  | { readonly state: "closed"; readonly closedReason: "cancelled" | "expired" | "declined" };

export type QuestionData = {
  readonly questionId: QuestionId;
  readonly message: string;
  readonly fields: readonly QuestionField[];
  readonly status: QuestionStatus;
};

export type TaskDataParts = {
  plan: { entries: z.infer<typeof planEntry>[] };
  question: QuestionData;
  compaction: { status: "running" | "done"; summary?: string };
  system: { seq: number; event: SystemEvent };
  unsupported: { seq: number; rawKind: string };
  problem: { seq: number; text: string };
};

export type TaskMessageMeta = {
  firstSeq: number;
  lastSeq: number;
  turnId?: TurnId;
  turnState?: "running" | "ended" | "failed";
  stopReason?: StopReason;
  error?: string;
  author?: { memberId: MemberId; delivery: "immediate" | "queued" | "after-interrupt" };
  optimistic?: boolean;
};

export type TaskUIMessage = UIMessage<TaskMessageMeta, TaskDataParts, TaskUITools>;
export type TaskUIPart = TaskUIMessage["parts"][number];
