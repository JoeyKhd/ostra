import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs the Prisma CLI of this package as a child process, with an argument array (never a shell)
// and with telemetry and update checks off (ADR 0021). Ported from
// spikes/auth-foundation/src/db/migrate.ts and src/proc.ts.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prismaEntry = path.join(packageRoot, "node_modules", "prisma", "build", "index.js");

export type PrismaRun = {
  readonly ok: boolean;
  readonly code: number | null;
  /** Prisma's own output. It holds no connection string, so it is safe to show. */
  readonly output: string;
};

/** The environment Prisma's CLI runs with. */
const prismaEnv = (databaseUrl: string | undefined): NodeJS.ProcessEnv => ({
  ...process.env,
  CHECKPOINT_DISABLE: "1",
  PRISMA_HIDE_UPDATE_MESSAGE: "1",
  NO_COLOR: "1",
  ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
});

export const runPrisma = (
  args: readonly string[],
  options: { readonly databaseUrl?: string; readonly inherit?: boolean } = {},
): Promise<PrismaRun> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [prismaEntry, ...args], {
      cwd: packageRoot,
      env: prismaEnv(options.databaseUrl),
      stdio: options.inherit === true ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ ok: false, code: null, output: `${output}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, output });
    });
  });

/** Applies `prisma/migrations` to a database, the way an install's upgrade does. */
export const migrateDeploy = (databaseUrl: string): Promise<PrismaRun> =>
  runPrisma(["migrate", "deploy"], { databaseUrl });
