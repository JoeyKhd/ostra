import { z } from "zod";

// What the harness and its generator processes say to each other (ticket 34): one JSON object a
// line, on the child's stdin and stdout. Both sides are ostra's own, so the schemas are strict.

export const generatorArgsSchema = z.strictObject({
  /** The addresses the runners connect to, one per core replica; runner `i` takes `i % length`. */
  serverUrls: z.array(z.url()).min(1),
  joinToken: z.string().min(1),
  /** Runner names are `<prefix>-<i>`. */
  prefix: z.string().regex(/^[a-z0-9-]+$/),
  runners: z.number().int().positive(),
  slots: z.number().int().positive(),
  dataDir: z.string().min(1),
  transport: z.enum(["websocket", "http", "auto"]),
  /** Registrations at once, so a large step doesn't open them all in one instant. */
  registerConcurrency: z.number().int().positive(),
});
export type GeneratorArgs = z.infer<typeof generatorArgsSchema>;

export const generatorCommandSchema = z.discriminatedUnion("cmd", [
  z.strictObject({ cmd: z.literal("connect") }),
  z.strictObject({ cmd: z.literal("report") }),
  /** Answers with the ack latencies since the last `acks`, and starts a new sample. */
  z.strictObject({ cmd: z.literal("acks") }),
  z.strictObject({ cmd: z.literal("mark"), taskId: z.string(), marker: z.string().regex(/^[a-z0-9-]+$/) }),
  z.strictObject({ cmd: z.literal("drain") }),
  z.strictObject({ cmd: z.literal("exit") }),
]);
export type GeneratorCommand = z.infer<typeof generatorCommandSchema>;

export const generatorLineSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("registered"), runners: z.array(z.strictObject({ runnerId: z.string(), name: z.string() })) }),
  z.strictObject({ t: z.literal("dispatched"), taskId: z.string(), sessionId: z.string(), partialText: z.boolean() }),
  z.strictObject({ t: z.literal("steer"), id: z.string(), at: z.number() }),
  z.strictObject({ t: z.literal("marked"), marker: z.string(), at: z.number().nullable() }),
  z.strictObject({ t: z.literal("report"), runners: z.number().int(), connected: z.number().int(), tasks: z.number().int(), rssBytes: z.number() }),
  /** A sample of the ack latencies since the last `acks`, in ms. */
  z.strictObject({ t: z.literal("acks"), ackMs: z.array(z.number()) }),
  z.strictObject({ t: z.literal("drained"), sessions: z.array(z.strictObject({ taskId: z.string(), sessionId: z.string(), offered: z.number().int() })) }),
  z.strictObject({ t: z.literal("error"), message: z.string() }),
]);
export type GeneratorLine = z.infer<typeof generatorLineSchema>;
