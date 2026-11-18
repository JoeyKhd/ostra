import * as z from "zod";

// Branded IDs (AGENTS.md: never bare strings). Each schema is the only way to
// make one, so a value of type `OrganizationId` has been parsed.
export const UserId = z.string().min(1).brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const OrganizationId = z.string().min(1).brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof OrganizationId>;

export const ProjectId = z.string().min(1).brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

export const TaskId = z.string().min(1).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

/** better-auth's invitation ID. It is the secret in an invite link, so it is never logged. */
export const InvitationId = z.string().min(1).brand<"InvitationId">();
export type InvitationId = z.infer<typeof InvitationId>;
