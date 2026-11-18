// `pnpm dev` (ticket 29): the whole dev stack in one command. It starts the dev database unless
// DATABASE_URL is set, runs the migrations, then starts apps/core and apps/web in watch mode with
// their output prefixed, and prints where they are. Each server starts once its package has a
// `dev` script; until then `pnpm dev` says so and runs the rest.
//
// Ctrl-C (or SIGTERM) stops everything and leaves no process: the servers' process trees are ended,
// then the dev database stops Postgres cleanly. A process that started this one with an IPC
// channel can send `{ "type": "stop" }` for the same shutdown (the check in docs/development.md).

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  devApps,
  hasDevScript,
  isDatabaseUrlLine,
  isSetupTokenLine,
  pnpmEntry,
  prefixLine,
  usesExternalDatabase,
} from "./dev-stack.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";

type Piece = {
  readonly label: string;
  readonly child: ChildProcess;
  /** A piece that finishes on its own (the migrations): its exit is not a crash. */
  readonly oneShot: boolean;
  exited: boolean;
};
const pieces: Piece[] = [];
let stopping = false;

const say = (line: string): void => {
  process.stdout.write(`${prefixLine("dev", line)}\n`);
};

const banner = (lines: readonly string[]): void => {
  const width = Math.max(...lines.map((line) => line.length));
  const rule = "=".repeat(width + 4);
  process.stdout.write(`\n${rule}\n${lines.map((line) => `  ${line}`).join("\n")}\n${rule}\n\n`);
};

const pipeLines = (piece: Piece, onLine?: (line: string) => void): void => {
  for (const stream of [piece.child.stdout, piece.child.stderr]) {
    if (stream === null) {
      continue;
    }
    createInterface({ input: stream }).on("line", (line) => {
      if (onLine !== undefined) {
        onLine(line);
        return;
      }
      process.stdout.write(`${prefixLine(piece.label, line)}\n`);
      if (isSetupTokenLine(line)) {
        banner(["Create the first admin with the setup token:", line.trim()]);
      }
    });
  }
};

type StartOptions = SpawnOptions & { readonly oneShot?: boolean; readonly ipc?: boolean };

const start = (label: string, command: string, args: readonly string[], options: StartOptions): Piece => {
  const { oneShot = false, ipc = false, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // On POSIX each piece gets its own process group, so its whole tree can be signalled.
    detached: !windows,
  });
  const piece: Piece = { label, child, oneShot, exited: false };
  child.on("exit", (code, signal) => {
    piece.exited = true;
    if (!stopping && !oneShot) {
      say(`${label} exited (${signal ?? `code ${String(code)}`}); stopping the stack.`);
      void shutdown(1);
    }
  });
  child.on("error", (error) => {
    piece.exited = true;
    say(`${label} could not start: ${error.message}`);
    if (!stopping) {
      void shutdown(1);
    }
  });
  pieces.push(piece);
  return piece;
};

const runNode = (label: string, script: string, options: { readonly oneShot?: boolean; readonly ipc?: boolean } = {}): Piece =>
  start(label, process.execPath, [script], { cwd: repoRoot, env: process.env, ...options });

const runPnpmDev = (label: string, dir: string): Piece => {
  const entry = pnpmEntry(process.env);
  return entry === null
    ? // Fixed arguments only: nothing here comes from outside the repo.
      start(label, "pnpm", ["run", "dev"], { cwd: dir, env: process.env, shell: windows })
    : start(label, process.execPath, [entry, "run", "dev"], { cwd: dir, env: process.env });
};

const waitForExit = (piece: Piece, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (piece.exited) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    piece.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/** Ends a piece's whole process tree: `taskkill /T` on Windows, its process group elsewhere. */
const killTree = (piece: Piece, signal: NodeJS.Signals): Promise<void> =>
  new Promise((resolve) => {
    const pid = piece.child.pid;
    if (pid === undefined || piece.exited) {
      resolve();
      return;
    }
    if (!windows) {
      try {
        process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
      resolve();
      return;
    }
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {
      resolve();
    });
    killer.on("close", () => {
      resolve();
    });
  });

const shutdown = async (exitCode: number): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  say("stopping...");
  const database = pieces.find((piece) => piece.label === "db");
  const servers = pieces.filter((piece) => piece !== database && !piece.exited);
  // The servers first, so nothing is writing when the database stops.
  await Promise.all(servers.map((piece) => killTree(piece, "SIGTERM")));
  await Promise.all(
    servers.map(async (piece) => {
      if (!(await waitForExit(piece, 5_000))) {
        await killTree(piece, "SIGKILL");
      }
    }),
  );
  if (database !== undefined && !database.exited) {
    // The dev database stops Postgres cleanly on a `stop` message (or SIGINT, or a console Ctrl-C).
    // Only if it hasn't after the grace period is its tree ended, Postgres with it.
    database.child.send({ type: "stop" });
    if (!(await waitForExit(database, 15_000))) {
      await killTree(database, "SIGKILL");
      await waitForExit(database, 5_000);
    }
  }
  say("stopped.");
  process.exit(exitCode);
};

const startDatabase = async (): Promise<boolean> => {
  if (usesExternalDatabase(process.env)) {
    say("DATABASE_URL is set: using that server, no embedded Postgres.");
    return true;
  }
  say("starting the dev database (.ostra-dev/pg)...");
  const database = runNode("db", path.join(repoRoot, "packages", "db", "scripts", "dev-postgres.ts"), { ipc: true });
  return new Promise((resolve) => {
    let ready = false;
    pipeLines(database, (line) => {
      if (isDatabaseUrlLine(line)) {
        ready = true;
        say("the dev database is ready.");
        resolve(true);
        return;
      }
      if (line.startsWith("Press Ctrl-C")) {
        return;
      }
      process.stdout.write(`${prefixLine("db", line)}\n`);
    });
    database.child.once("exit", () => {
      if (!ready) {
        resolve(false);
      }
    });
  });
};

const migrate = async (): Promise<boolean> => {
  say("running the migrations...");
  const migration = runNode("migrate", path.join(repoRoot, "packages", "db", "scripts", "migrate.ts"), {
    oneShot: true,
  });
  pipeLines(migration);
  const code = await new Promise<number | null>((resolve) => {
    migration.child.once("exit", (exitCode) => {
      resolve(exitCode);
    });
  });
  return code === 0;
};

const main = async (): Promise<void> => {
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  process.on("message", (message: unknown) => {
    if (Reflect.get(Object(message), "type") === "stop") {
      void shutdown(0);
    }
  });

  if (!(await startDatabase())) {
    say("the dev database did not start. `pnpm dev:reset` says how to clear a crashed one.");
    await shutdown(1);
    return;
  }
  if (!(await migrate())) {
    say("the migrations failed.");
    await shutdown(1);
    return;
  }

  const addresses: string[] = [];
  for (const app of devApps(repoRoot)) {
    if (await hasDevScript(app.dir)) {
      const piece = runPnpmDev(app.label, app.dir);
      pipeLines(piece);
      addresses.push(`${app.label === "web" ? "The panel" : "Core     "}  ${app.address(process.env)}`);
    } else {
      say(`${path.relative(repoRoot, app.dir)} has no server yet (no \`dev\` script): not started.`);
    }
  }
  banner([
    "ostra's dev stack is running.",
    ...addresses,
    "Runner (from source): pnpm ostra runner --server http://localhost:8787",
    "Ctrl-C stops everything.",
  ]);
  process.send?.({ type: "ready", pids: pieces.map((piece) => piece.child.pid ?? null) });
};

await main();
