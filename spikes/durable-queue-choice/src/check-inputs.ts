// `pnpm check:inputs`: which inputs this spike can use are present. Never prints a value.

import { access, readdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";

type Row = {
  readonly input: string;
  readonly usedFor: string;
  readonly need: "required" | "optional" | "not used";
  readonly present: boolean;
  readonly note: string;
};

const has = (name: string): boolean => {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const embeddedBinaryPresent = async (): Promise<boolean> => {
  const os = platform() === "win32" ? "windows" : platform();
  const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
  let entries: string[];
  try {
    entries = await readdir(pnpmDir);
  } catch {
    return false;
  }
  const prefix = `@embedded-postgres+${os}-${arch()}@`;
  const exe = platform() === "win32" ? "postgres.exe" : "postgres";
  for (const entry of entries.filter((name) => name.startsWith(prefix))) {
    if (await exists(join(pnpmDir, entry, "node_modules", "@embedded-postgres", `${os}-${arch()}`, "native", "bin", exe))) {
      return true;
    }
  }
  return false;
};

/**
 * On Windows, postgres.exe cannot open a path of 260 characters or more. Returns the longest path
 * the embedded binaries and a data directory would need, or 0 where the limit does not apply.
 */
const longestPostgresPath = async (): Promise<number> => {
  if (platform() !== "win32") {
    return 0;
  }
  const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
  let entries: string[];
  try {
    entries = await readdir(pnpmDir);
  } catch {
    return 0;
  }
  const entry = entries.find((name) => name.startsWith(`@embedded-postgres+windows-${arch()}@`));
  if (entry === undefined) {
    return 0;
  }
  const native = join(pnpmDir, entry, "node_modules", "@embedded-postgres", `windows-${arch()}`, "native");
  const files = await readdir(native, { recursive: true });
  const longestInBinaries = Math.max(...files.map((file) => native.length + 1 + file.length));
  // A data directory (.data/pg-<timestamp>) and the deepest path Postgres makes inside it.
  const longestInData = join(process.cwd(), ".data", "pg-0000000000000", "pg_wal", "archive_status").length + 40;
  return Math.max(longestInBinaries, longestInData);
};

const names = (prefix: string): string[] => Object.keys(process.env).filter((name) => name.startsWith(prefix));

const main = async (): Promise<number> => {
  const embedded = await embeddedBinaryPresent();
  const databaseUrl = has("SPIKE_DATABASE_URL");
  const longest = await longestPostgresPath();
  const githubNames = names("GITHUB_");
  const linearNames = names("LINEAR_");

  const rows: Row[] = [
    {
      input: "embedded-postgres binary",
      usedFor: "a real Postgres on this machine for every scenario",
      need: databaseUrl ? "optional" : "required",
      present: embedded,
      note: embedded ? "found under node_modules" : "run `pnpm install` (the platform package ships the binaries)",
    },
    {
      input: "a checkout path short enough for Postgres (Windows only)",
      usedFor: "embedded-postgres: postgres.exe cannot open a path of 260 characters or more",
      need: platform() === "win32" && !databaseUrl ? "required" : "optional",
      present: longest < 255,
      note: platform() === "win32" ? `longest path needed: ${String(longest)} of 259 characters` : "not a limit on this platform",
    },
    {
      input: "SPIKE_DATABASE_URL",
      usedFor: "an existing Postgres server instead of embedded-postgres (needs CREATE and DROP DATABASE rights; the harness drops what it created)",
      need: "optional",
      present: databaseUrl,
      note: databaseUrl
        ? "the harness will use it (a generic DATABASE_URL is deliberately ignored)"
        : "absent: the harness starts embedded-postgres",
    },
    {
      input: "OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY, OSTRA_DEV_MODEL_ID",
      usedFor: "nothing: no agent or model runs in this spike",
      need: "not used",
      present: has("OSTRA_DEV_MODEL_BASE_URL") && has("OSTRA_DEV_MODEL_API_KEY") && has("OSTRA_DEV_MODEL_ID"),
      note: "not needed",
    },
    {
      input: "GITHUB_*",
      usedFor: "nothing: the pass bar's GitHub is a local fake that counts idempotency keys",
      need: "not used",
      present: githubNames.length > 0,
      note: "a real GitHub org belongs to spikes 2 to 4",
    },
    {
      input: "LINEAR_*",
      usedFor: "nothing: no tracker is called",
      need: "not used",
      present: linearNames.length > 0,
      note: "a real Linear workspace belongs to spikes 5 and 10",
    },
  ];

  process.stdout.write("durable-queue-choice: inputs (values are never printed)\n\n");
  for (const row of rows) {
    process.stdout.write(`${row.present ? "present" : "absent "}  ${row.need.padEnd(8)}  ${row.input}\n`);
    process.stdout.write(`                     ${row.usedFor}; ${row.note}\n`);
  }
  const missing = rows.filter((row) => row.need === "required" && !row.present);
  process.stdout.write(
    missing.length === 0
      ? "\nEvery required input is present: `pnpm spike` can run all seven criteria.\n"
      : `\nMissing required input: ${missing.map((row) => row.input).join(", ")}\n`,
  );
  return missing.length === 0 ? 0 : 1;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.exitCode = 2;
  });
