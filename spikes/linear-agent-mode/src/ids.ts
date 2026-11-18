import { z } from "zod";

// One branded type per ID (AGENTS.md): a bare string never stands for an ID.
const idBase = z.string().min(1).max(200);

export const AgentSessionId = idBase.brand<"AgentSessionId">();
export type AgentSessionId = z.infer<typeof AgentSessionId>;

export const OrganizationId = idBase.brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof OrganizationId>;

/** The workspace user that is the installed app itself (`viewer.id` after an `actor=app` install). */
export const AppUserId = idBase.brand<"AppUserId">();
export type AppUserId = z.infer<typeof AppUserId>;

export const LinearUserId = idBase.brand<"LinearUserId">();
export type LinearUserId = z.infer<typeof LinearUserId>;

export const IssueId = idBase.brand<"IssueId">();
export type IssueId = z.infer<typeof IssueId>;

/** The `Linear-Delivery` header: one UUID per webhook payload. */
export const DeliveryId = idBase.brand<"DeliveryId">();
export type DeliveryId = z.infer<typeof DeliveryId>;

/** A ticket's key as people write it, such as OST-12. An ID, so safe to print; not Linear's own UUID. */
export const TicketKey = z.string().min(1).max(64).brand<"TicketKey">();
export type TicketKey = z.infer<typeof TicketKey>;

/** An agent activity's ID: the UUID v4 ostra makes for each activity, the same on every retry of it. */
export const ActivityId = z.uuid().brand<"ActivityId">();
export type ActivityId = z.infer<typeof ActivityId>;
