import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPgCtl } from "./windows-cluster.ts";

// The test Postgres's watchdog on Windows (`windows-cluster.ts`):
//   node cluster-watchdog.ts [--detach] <owner pid> <pg_ctl> <cluster folder>
// With --detach it starts itself again without it and ends, so the watchdog's parent is gone and a
// tree kill of the owner (an agent's `taskkill /T /F` of a vitest run) doesn't reach it. Then,
// once a second: the cluster stopped (no postmaster.pid) ends it; the owner gone stops the cluster
// (an immediate shutdown, which starts nothing) and removes its folder.

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
};

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const watch = async (owner: number, pgCtl: string, dir: string): Promise<void> => {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!(await exists(path.join(dir, "postmaster.pid")))) {
      return;
    }
    if (!isAlive(owner)) {
      await runPgCtl(pgCtl, ["stop", "-D", dir, "-m", "immediate", "-w", "-t", "60"]);
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(
        () => undefined,
      );
      return;
    }
  }
};

const [first = "", ...rest] = process.argv.slice(2);
if (first === "--detach") {
  spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: tmpdir(),
  }).unref();
} else {
  const [pgCtl = "", dir = ""] = rest;
  const owner = Number.parseInt(first, 10);
  if (Number.isInteger(owner) && owner > 0 && pgCtl !== "" && dir !== "") {
    await watch(owner, pgCtl, dir);
  }
}
