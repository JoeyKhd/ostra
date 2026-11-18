import * as z from "zod";

// Every input this spike can read. Nothing here is required: with none set,
// the harness runs on an embedded Postgres and a random per-run secret, so a
// fresh checkout can run `pnpm spike` with no account anywhere.
//
// There is no base URL setting: the harness serves better-auth on a loopback
// port it picks itself, and every scenario talks to that address.
export const spikeEnvSchema = z.object({
  /** A throwaway Postgres to run in. Absent: the harness starts embedded-postgres. */
  DATABASE_URL: z.url().optional(),
  /** better-auth's signing secret, 32+ characters. Absent: a random one per run. */
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
});
export type SpikeEnv = z.infer<typeof spikeEnvSchema>;

export type InputStatus = {
  readonly name: string;
  readonly present: boolean;
  /** What a missing value means for this spike. */
  readonly whenMissing: string;
};

const describedInputs = [
  {
    name: "DATABASE_URL",
    whenMissing: "embedded-postgres starts a throwaway cluster on this machine",
  },
  {
    name: "BETTER_AUTH_SECRET",
    whenMissing: "a random 32-byte secret is generated for each run",
  },
] as const;

/** Reports which inputs are set. Never reads a value into the result. */
export const describeInputs = (env: NodeJS.ProcessEnv): InputStatus[] =>
  describedInputs.map(({ name, whenMissing }) => ({
    name,
    present: (env[name] ?? "") !== "",
    whenMissing,
  }));

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

export const readSpikeEnv = (env: NodeJS.ProcessEnv): SpikeEnv =>
  spikeEnvSchema.parse({
    DATABASE_URL: emptyToUndefined(env["DATABASE_URL"]),
    BETTER_AUTH_SECRET: emptyToUndefined(env["BETTER_AUTH_SECRET"]),
  });
