import { z } from "zod";

// One branded type per ID (AGENTS.md): never a bare string across a boundary.
const idString = () => z.string().min(1).max(200);

export const TaskId = idString().brand("TaskId");
export type TaskId = z.infer<typeof TaskId>;

export const MemberId = idString().brand("MemberId");
export type MemberId = z.infer<typeof MemberId>;

export const TurnId = idString().brand("TurnId");
export type TurnId = z.infer<typeof TurnId>;

export const SegmentId = idString().brand("SegmentId");
export type SegmentId = z.infer<typeof SegmentId>;

export const ToolCallId = idString().brand("ToolCallId");
export type ToolCallId = z.infer<typeof ToolCallId>;

export const ApprovalId = idString().brand("ApprovalId");
export type ApprovalId = z.infer<typeof ApprovalId>;

export const QuestionId = idString().brand("QuestionId");
export type QuestionId = z.infer<typeof QuestionId>;

export const ClientMessageId = idString().brand("ClientMessageId");
export type ClientMessageId = z.infer<typeof ClientMessageId>;

export const OptionId = idString().brand("OptionId");
export type OptionId = z.infer<typeof OptionId>;

export const RunnerId = idString().brand("RunnerId");
export type RunnerId = z.infer<typeof RunnerId>;
