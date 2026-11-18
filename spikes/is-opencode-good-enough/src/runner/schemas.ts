// The records the runner writes and everything downstream reads back: one
// run.json per run, one set.json per set of runs. They are ostra's own format,
// so every object is strict: a field that isn't here is an error, not a
// silent extra.

import { z } from "zod";
import { TicketIdSchema, TicketKindSchema, VariantSchema } from "../tickets/schema.ts";

export const RunIdSchema = z.string().regex(/^calc-\d{1,3}-r\d{1,2}$/).brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;
export const runId = (value: string): RunId => RunIdSchema.parse(value);

export const ApiFormatSchema = z.enum(["openai", "anthropic"]);

export const TestCountsSchema = z.strictObject({ total: z.number().int().nonnegative(), pass: z.number().int().nonnegative(), fail: z.number().int().nonnegative() });
export type TestCounts = z.infer<typeof TestCountsSchema>;

export const CiResultSchema = z.strictObject({
  tests: z.strictObject({ ...TestCountsSchema.shape, ran: z.boolean() }),
  typecheck: z.strictObject({ ok: z.boolean(), errors: z.number().int().nonnegative() }),
  /** Tests ran, none failed, and the typecheck is clean. */
  green: z.boolean(),
});
export type CiResult = z.infer<typeof CiResultSchema>;

export const MutationResultSchema = z.strictObject({
  /** The agent's tests pass on the pristine module. */
  greenOnPristine: z.boolean(),
  killed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  survivors: z.array(z.string()),
  /** Killed at least two thirds of the seeded faults. */
  needed: z.number().int().positive(),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

export const AcceptanceResultSchema = z.strictObject({
  kind: z.enum(["behavior", "mutation"]),
  passed: z.boolean(),
  tests: TestCountsSchema.optional(),
  mutation: MutationResultSchema.optional(),
  /** The tail of a failing run, for a human looking into it. Never logged. */
  detail: z.string(),
});
export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

export const OutcomeSchema = z.enum(["completed", "timeout", "token-cap", "spend-cap", "agent-crashed", "error"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

const count = z.number().int().nonnegative();

export const RunRecordSchema = z.strictObject({
  schema: z.literal(1),
  runId: RunIdSchema,
  ticketId: TicketIdSchema,
  kind: TicketKindSchema,
  /** 1 to 3: which of the ticket's runs this is. */
  index: z.number().int().positive(),
  /** The name of the set of runs (the model's label). */
  label: z.string(),
  /** `dry` ran against a scripted stub model: it proves the pipeline and says nothing about any model. */
  mode: z.enum(["dry", "real"]),
  /** Dry runs only: how the script went. */
  variant: VariantSchema.optional(),
  model: z.strictObject({ id: z.string(), format: ApiFormatSchema }),
  agent: z.strictObject({ name: z.literal("opencode"), version: z.string(), sha256: z.string() }),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: OutcomeSchema,
  stopReason: z.string().nullable(),
  /** The failure's message, for outcome `error` or `agent-crashed`. */
  error: z.string().nullable(),
  time: z.strictObject({
    /** The prompt sent to the turn's end: what the member waits for. */
    wallMs: count,
    /** The agent's spawn to a ready session. */
    startupMs: count,
  }),
  turns: z.strictObject({
    /** Prompts the runner sent. One: nobody steers in this spike. */
    prompts: count,
    /** The agent's model round trips: the proxy's calls that offered tools. */
    modelCalls: count,
    /** Model calls without tools, such as titles. */
    auxiliaryCalls: count,
    toolCalls: count,
    /** Questions the agent asked. Nobody is there: each gets the same neutral reply (unattended.ts). */
    questions: count,
  }),
  approvals: z.strictObject({
    policy: z.string(),
    requested: count,
    allowed: count,
    rejected: count,
    byKind: z.record(z.string(), count),
  }),
  events: z.strictObject({
    /** Events the driver logged: updates, permission and question requests, and the end of the turn. */
    total: count,
    perMinute: z.number().nonnegative(),
    byUpdate: z.record(z.string(), count),
    wireMessages: count,
    wireBytes: count,
  }),
  spend: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    /** Every call through the proxy, the turn's own and the title calls. */
    totalTokens: count,
    /** Only the calls that offered tools: the turn's own, comparable with what OpenCode reports for the turn. */
    turnTokens: count,
    /** Null when no price is known. */
    usd: z.number().nonnegative().nullable(),
    pricing: z.enum(["stub", "configured", "none"]),
    /** Model calls answered 200 that reported no usage: a hole in the count. */
    callsWithoutUsage: count,
    /** What OpenCode reported for the turn, as a cross-check of the proxy's count. */
    agentReportedTokens: count.nullable(),
  }),
  modelErrors: z.strictObject({ rateLimited: count, serverErrors: count, clientErrors: count }),
  diff: z.strictObject({
    files: z.array(z.strictObject({ path: z.string(), insertions: count, deletions: count })),
    insertions: count,
    deletions: count,
  }),
  checks: z.strictObject({
    ci: CiResultSchema,
    acceptance: AcceptanceResultSchema,
    /** The agent changed src/ on a ticket that only adds tests. */
    touchedSource: z.boolean(),
  }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The set manifest: what a folder of runs is. Never a key or an address. */
export const SetManifestSchema = z.strictObject({
  schema: z.literal(1),
  label: z.string(),
  mode: z.enum(["dry", "real"]),
  createdAt: z.string(),
  tickets: z.array(TicketIdSchema),
  runsPerTicket: z.number().int().positive(),
  /** Runs deleted by `--retry-failed` (an error, a crash or a model error) and run again: the reader of the result should know. */
  retriedRuns: z.number().int().nonnegative().optional(),
  /** The dry-run alternates both API formats between its runs: `both`. */
  model: z.strictObject({ id: z.string(), format: z.union([ApiFormatSchema, z.literal("both")]) }),
  pricing: z.enum(["stub", "configured", "none"]),
  policy: z.string(),
  limits: z.strictObject({ timeoutMs: z.number().int().positive(), maxTokens: z.number().int().positive(), maxUsd: z.number().positive().nullable() }),
  agent: z.strictObject({ name: z.literal("opencode"), version: z.string(), sha256: z.string() }),
  node: z.string(),
  platform: z.string(),
});
export type SetManifest = z.infer<typeof SetManifestSchema>;
