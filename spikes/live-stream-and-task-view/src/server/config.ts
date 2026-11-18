import { z } from "zod";

// Settings come from the environment and are validated once. A fresh run needs DATABASE_URL and a
// runner token (the harness supplies both: embedded-postgres, and a token it generates per run).
// There is no default secret: a server with a public constant for its runner token would accept forged
// runner events from anyone who can reach it.
const loopback = new Set(["127.0.0.1", "localhost", "::1"]);

const settings = z
  .strictObject({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().min(0).max(65535).default(0),
    HOST: z.string().default("127.0.0.1"),
    OSTRA_SPIKE_RUNNER_TOKEN: z.string().min(24),
    // The dev stand-in for sign-in (a session for any member, no secret). Off unless asked for, and only
    // while the server listens on a loopback address.
    OSTRA_SPIKE_DEV_LOGIN: z.enum(["0", "1"]).default("0"),
    OSTRA_SPIKE_QUIET: z.enum(["0", "1"]).default("0"),
    // The harness holds the process's stdin open; with this on, a closed stdin (a harness that died) ends the process.
    OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE: z.enum(["0", "1"]).default("0"),
    OSTRA_SPIKE_WEB_DIR: z.string().default("dist/web"),
    OSTRA_SPIKE_POLL_MS: z.coerce.number().int().min(10).default(250),
    OSTRA_SPIKE_FLUSH_MS: z.coerce.number().int().min(1).default(10),
    OSTRA_SPIKE_PG_POOL: z.coerce.number().int().min(2).default(10),
    OSTRA_SPIKE_PG_IDLE_MS: z.coerce.number().int().min(0).default(10_000),
    OSTRA_SPIKE_REPLICA_ID: z.string().min(1).default("replica"),
  })
  .refine((value) => value.OSTRA_SPIKE_DEV_LOGIN === "0" || loopback.has(value.HOST), {
    message: "OSTRA_SPIKE_DEV_LOGIN=1 is only allowed while HOST is a loopback address",
    path: ["HOST"],
  });
export type ServerSettings = z.infer<typeof settings>;

const SERVER_KEYS = [
  "DATABASE_URL",
  "PORT",
  "HOST",
  "OSTRA_SPIKE_RUNNER_TOKEN",
  "OSTRA_SPIKE_DEV_LOGIN",
  "OSTRA_SPIKE_QUIET",
  "OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE",
  "OSTRA_SPIKE_WEB_DIR",
  "OSTRA_SPIKE_POLL_MS",
  "OSTRA_SPIKE_FLUSH_MS",
  "OSTRA_SPIKE_PG_POOL",
  "OSTRA_SPIKE_PG_IDLE_MS",
  "OSTRA_SPIKE_REPLICA_ID",
] as const;

export const loadSettings = (env: NodeJS.ProcessEnv): ServerSettings => {
  const picked: Record<string, string | undefined> = {};
  for (const key of SERVER_KEYS) picked[key] = env[key];
  return settings.parse(picked);
};
