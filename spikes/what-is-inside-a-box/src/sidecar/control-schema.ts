// The sidecar's control API (the stand-in for the server connection): its
// request and response bodies. ostra owns this format, so every schema is
// strict and every field is required. The sidecar builds its answers with
// these types, and the harness parses them with these schemas: written once.

import { z } from "zod";
import { attackConfigSchema, checklistReportSchema } from "../attack/checklist.ts";

const count = z.number().int().nonnegative();

export const phaseSchema = z.enum(["waiting_handoff", "waiting_bridge", "starting_agent", "ready", "stopping", "stopped", "failed"]);
export type Phase = z.infer<typeof phaseSchema>;

export const turnStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("idle") }),
  z.strictObject({ state: z.literal("running"), turn: count, startedAt: z.number() }),
  z.strictObject({ state: z.literal("finished"), turn: count, startedAt: z.number(), endedAt: z.number(), stopReason: z.string() }),
  z.strictObject({ state: z.literal("failed"), turn: count, startedAt: z.number(), endedAt: z.number(), error: z.string() }),
]);
export type TurnState = z.infer<typeof turnStateSchema>;

export const approvalModeSchema = z.enum(["hold", "allow", "reject"]);

export const controlStatusSchema = z.strictObject({
  boxId: z.string(),
  taskId: z.string(),
  phase: phaseSchema,
  failure: z.string().nullable(),
  timings: z.record(z.string(), z.number()),
  handoff: z.strictObject({ refused: count }),
  bridge: z.strictObject({ connected: z.boolean(), listening: z.boolean(), refused: count, initPid: z.number().int().nullable(), agentUid: z.number().int().nullable() }),
  agent: z.strictObject({
    pid: z.number().int().nullable(),
    running: z.boolean(),
    sessionId: z.string().nullable(),
    wire: z.strictObject({ inbound: count, inboundNotifications: count, inboundSessionUpdates: count, inboundRequests: count, inboundBytes: count }).nullable(),
  }),
  turn: turnStateSchema,
  approvals: z.strictObject({
    mode: approvalModeSchema,
    seen: count,
    pending: z.array(z.strictObject({ id: z.number().int().positive(), toolCallId: z.string(), title: z.string(), since: z.number() })),
  }),
  events: z.strictObject({ count, lastSeq: count, kinds: z.record(z.string(), count) }),
  keyProxy: z.strictObject({ calls: count, swapped: count, rejected: count, tokens: count }),
  gitProxy: z.strictObject({ forwarded: count, refused: count }),
  gitUpstream: z.strictObject({ withToken: count, withoutToken: count }).nullable(),
  memory: z.strictObject({ rssBytes: count, heapUsedBytes: count }),
});
export type ControlStatus = z.infer<typeof controlStatusSchema>;

/** POST /stop: what the init reported still alive after it killed the agent's processes. */
export const stopResultSchema = z.strictObject({
  leftover: z.array(z.strictObject({ pid: z.number().int(), name: z.string() })),
});
export type StopResult = z.infer<typeof stopResultSchema>;

/** POST /attack: run the checklist in the agent's container, as the agent, with the agent's environment. */
export const attackRequestSchema = z.strictObject({
  config: attackConfigSchema,
  /**
   * The negative control: one variable added to the checklist's environment
   * (e.g. OSTRA_MODEL_KEY=<the model marker>), so the env check is shown able
   * to fail. Its value is a marker the harness made, never a real key.
   */
  plantEnv: z.strictObject({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), value: z.string().min(6).max(256) }).optional(),
});
export type AttackRequest = z.input<typeof attackRequestSchema>;

export const attackResponseSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  report: checklistReportSchema,
});
export type AttackResponse = z.infer<typeof attackResponseSchema>;

export const errorBodySchema = z.strictObject({ error: z.string() });
