import { nodeModulesBin, spikeRoot, toolEnv } from "../paths.ts";
import { runProcess } from "../proc.ts";

export type MigrateResult = {
  readonly ok: boolean;
  /** Names of the migrations Prisma reports as applied. */
  readonly applied: readonly string[];
  readonly detail: string;
};

/** Applies prisma/migrations with Prisma Migrate, the way an install's upgrade would. */
export const migrateDeploy = async (databaseUrl: string): Promise<MigrateResult> => {
  const result = await runProcess(process.execPath, [nodeModulesBin.prisma, "migrate", "deploy"], {
    cwd: spikeRoot,
    env: toolEnv({ DATABASE_URL: databaseUrl }),
    timeoutMs: 180_000,
  });
  // Prisma lists them as a tree: "└─ 20261118000000_init/".
  const applied = [...result.stdout.matchAll(/(\d{14}_[a-z0-9_]+)\//g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const ok = result.code === 0 && !result.timedOut;
  // Prisma's own output carries no connection string, so it is safe to keep.
  const detail = ok ? `applied ${String(applied.length)} migration(s)` : `${result.stdout}\n${result.stderr}`.trim().slice(-800);
  return { ok, applied, detail };
};

export const generateClient = async (): Promise<MigrateResult> => {
  const result = await runProcess(process.execPath, [nodeModulesBin.prisma, "generate"], {
    cwd: spikeRoot,
    env: toolEnv({}),
    timeoutMs: 180_000,
  });
  const ok = result.code === 0 && !result.timedOut;
  return { ok, applied: [], detail: ok ? "client generated" : `${result.stdout}\n${result.stderr}`.trim().slice(-800) };
};
