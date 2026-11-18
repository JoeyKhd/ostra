import { createServer } from "node:http";
import { z } from "zod";

// The baseline: the same strict flags and the same non-SDK dependencies (Node's types, Zod), with no @linear/sdk.
// `pnpm measure:tsc` times this project against ../with-sdk to get what the SDK adds.

const configSchema = z.object({ port: z.number().int().positive(), publicUrl: z.url() });
export type Config = z.infer<typeof configSchema>;

export const start = (raw: unknown): Config => {
  const config = configSchema.parse(raw);
  createServer((_req, res) => {
    res.end("ok");
  }).listen(config.port);
  return config;
};
