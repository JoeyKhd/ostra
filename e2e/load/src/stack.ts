import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { embeddedInitdbFlags, migrateDeploy, repoRoot } from "@ostra/db/dev";
import EmbeddedPostgres from "embedded-postgres";

// The load test's stack (ticket 34): one Postgres (embedded, in the step's own folder, unless
// DATABASE_URL names one), migrated; core replicas as `node apps/core/src/main.ts`, each on the next
// port, the first started alone so it installs the job queue's schema; and, when browsers watch,
// one panel (`next start`, or `next dev` when there's no production build). Every child is ended
// when the stack stops. Logs go to the step's folder; they carry IDs and fields, never content.

export type StackInput = {
  readonly dir: string;
  readonly replicas: number;
  readonly corePort: number;
  readonly webPort: number | null;
  readonly pgPort: number;
  /** DATABASE_URL of a Postgres the harness doesn't own; unset, an embedded one. */
  readonly databaseUrl: string | undefined;
  readonly admin: { readonly email: string; readonly password: string };
  readonly say: (line: string) => void;
};

export type CoreProcess = { readonly url: string; readonly port: number; readonly pid: number; readonly child: ChildProcess };

export type Stack = {
  readonly databaseUrl: string;
  /** The postmaster's PID when the harness owns Postgres on this machine; `null` otherwise. */
  readonly pgPid: number | null;
  readonly cores: readonly CoreProcess[];
  readonly webUrl: string | null;
  /** The environment the servers share: the settings `packages/api` in the harness reads too. */
  readonly serverEnv: Readonly<Record<string, string>>;
  readonly secretsKey: string;
  /** Called with every JSON log line a core writes. */
  readonly onCoreLine: (listener: (line: Readonly<Record<string, unknown>>) => void) => void;
  /** Whether a child exited while the stack ran: the reason, or `null`. */
  readonly failure: () => string | null;
  readonly stop: () => Promise<void>;
};

const node = process.execPath;

const killTree = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    if (process.platform === "win32") {
      // `next` starts its server as a child of its own: end the whole tree.
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    } else {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }
  });

const baseEnv = (): Record<string, string> => {
  const keep = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA"];
  const env: Record<string, string> = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

const waitForLine = (child: ChildProcess, match: (line: string) => boolean, timeoutMs: number, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.stdout === null) {
      reject(new Error(`${what} has no output`));
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      reject(new Error(`${what} didn't start in ${String(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const exited = (): void => {
      clearTimeout(timer);
      reject(new Error(`${what} exited before it started`));
    };
    child.once("exit", exited);
    lines.on("line", (line) => {
      if (!match(line)) return;
      clearTimeout(timer);
      child.off("exit", exited);
      resolve();
    });
  });

const waitForHttp = async (url: string, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${what} didn't answer in ${String(timeoutMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
};

const hasProductionBuild = async (webDir: string): Promise<boolean> =>
  readFile(path.join(webDir, ".next", "BUILD_ID"), "utf8").then(
    () => true,
    () => false,
  );

export const startStack = async (input: StackInput): Promise<Stack> => {
  await mkdir(input.dir, { recursive: true });
  const children: ChildProcess[] = [];
  const listeners: ((line: Readonly<Record<string, unknown>>) => void)[] = [];
  let failure: string | null = null;
  let stopping = false;
  let pg: EmbeddedPostgres | null = null;
  let pgPid: number | null = null;
  const pgDir = path.join(input.dir, "pg");

  const stop = async (): Promise<void> => {
    stopping = true;
    await Promise.all(children.map(killTree));
    if (pg !== null) await pg.stop().catch(() => undefined);
    await rm(pgDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    let databaseUrl = input.databaseUrl;
    if (databaseUrl === undefined) {
      const password = randomBytes(18).toString("base64url");
      pg = new EmbeddedPostgres({
        databaseDir: pgDir,
        port: input.pgPort,
        user: "ostra",
        password,
        initdbFlags: [...embeddedInitdbFlags],
        // Three replicas' pools, the job queue's and the harness's: more than the default 100.
        postgresFlags: ["-c", "max_connections=600", "-c", "shared_buffers=256MB"],
        persistent: false,
        onLog: () => undefined,
        onError: () => undefined,
      });
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("ostra");
      databaseUrl = `postgresql://ostra:${password}@127.0.0.1:${String(input.pgPort)}/ostra`;
      const pidLine = (await readFile(path.join(pgDir, "postmaster.pid"), "utf8")).split(/\r?\n/)[0] ?? "";
      pgPid = Number.parseInt(pidLine, 10) || null;
    }
    input.say("migrating the database");
    const migrated = await migrateDeploy(databaseUrl);
    if (!migrated.ok) throw new Error("the migrations failed");

    const secretsKey = randomBytes(32).toString("base64url");
    const webUrl = input.webPort === null ? null : `http://localhost:${String(input.webPort)}`;
    const serverEnv: Record<string, string> = {
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      OSTRA_DATA_DIR: path.join(input.dir, "server"),
      OSTRA_PUBLIC_URL: webUrl ?? "http://localhost:3000",
      OSTRA_CORE_PUBLIC_URL: `http://127.0.0.1:${String(input.corePort)}`,
      OSTRA_CORE_INTERNAL_URL: `http://127.0.0.1:${String(input.corePort)}`,
      OSTRA_CATALOG_FETCH: "false",
      OSTRA_SECRETS_KEY: secretsKey,
      OSTRA_RUNNER_TOKEN_KEY: randomBytes(32).toString("hex"),
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      OSTRA_ADMIN_EMAIL: input.admin.email,
      OSTRA_ADMIN_PASSWORD: input.admin.password,
    };

    const cores: CoreProcess[] = [];
    for (let index = 0; index < input.replicas; index += 1) {
      const port = input.corePort + index;
      const log = createWriteStream(path.join(input.dir, `core-${String(index + 1)}.log`));
      const child = spawn(node, [path.join(repoRoot, "apps", "core", "src", "main.ts")], {
        cwd: repoRoot,
        env: { ...baseEnv(), ...serverEnv, OSTRA_CORE_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      child.stderr.pipe(log);
      child.once("exit", (code) => {
        if (!stopping) failure ??= `core ${String(index + 1)} exited (${String(code)})`;
      });
      const started = waitForLine(child, (line) => line.startsWith("core is listening"), 180_000, `core ${String(index + 1)}`);
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        log.write(`${line}\n`);
        if (!line.startsWith("{")) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(parsed));
        for (const listener of listeners) listener(record);
      });
      // The first replica alone: it installs the job queue's schema and seeds the first admin.
      await started;
      input.say(`core ${String(index + 1)} is listening on ${String(port)}`);
      if (child.pid === undefined) throw new Error("a core replica has no PID");
      cores.push({ url: `http://127.0.0.1:${String(port)}`, port, pid: child.pid, child });
    }

    if (input.webPort !== null && webUrl !== null) {
      const webDir = path.join(repoRoot, "apps", "web");
      const built = await hasProductionBuild(webDir);
      input.say(built ? "starting the panel (next start)" : "starting the panel (next dev: no production build)");
      const log = createWriteStream(path.join(input.dir, "web.log"));
      const child = spawn(node, [path.join(webDir, "node_modules", "next", "dist", "bin", "next"), built ? "start" : "dev", "--port", String(input.webPort)], {
        cwd: webDir,
        env: { ...baseEnv(), ...serverEnv, NODE_ENV: built ? "production" : "development" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.once("exit", (code) => {
        if (!stopping) failure ??= `the panel exited (${String(code)})`;
      });
      await waitForHttp(`${webUrl}/sign-in`, 300_000, "the panel");
    }

    return {
      databaseUrl,
      pgPid,
      cores,
      webUrl,
      serverEnv,
      secretsKey,
      onCoreLine: (listener) => {
        listeners.push(listener);
      },
      failure: () => failure,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
