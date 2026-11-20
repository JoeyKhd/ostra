import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { epochMsSchema } from "@ostra/protocol";
import { z } from "zod";
import { dataPaths } from "./store.ts";

// One `ostra runner` per data folder on a machine (ADR 0034, "One process per runner", amended
// 2026-11-20). Four runners with one identity once ran on one machine, left behind by restarts,
// and took the connection from each other every few seconds: each takeover restarted the task's
// agent. A runner now takes `<dataDir>/runner.lock` before it signs in, and a second one refuses
// to start, naming the pid that holds it.
//
// The lock is a file made with O_EXCL that holds the holder's pid, its machine's name and a nonce.
// A crash leaves it behind, so a lock counts as held only while all of these hold:
//   - it was written on this machine (another host name: a container recreated, or a pod
//     rescheduled, whose old process can't be asked; the server's `replaced` covers that case)
//   - its pid isn't this process's own (a container restarted: the runner is pid 1 again)
//   - a process with that pid runs
//   - and that process is a Node program, as a runner is, unless that can't be told (a pid the
//     system reused after a reboot)
// A stale lock is moved aside and checked to be the one judged stale before it's replaced, so two
// runners starting at once on a crashed one's lock don't both take it.

const lockRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  hostname: z.string().min(1).max(255),
  startedAt: epochMsSchema,
  nonce: z.string().min(1).max(64),
});
export type LockRecord = z.infer<typeof lockRecordSchema>;

/** Why a lock left in the folder was taken over. */
export type StaleReason = "another-host" | "own-pid" | "not-running" | "not-a-runner" | "unreadable";

/** What the lock check asks of the machine; the system's by default, a test's own otherwise. */
export type LockProbe = {
  readonly pid: number;
  readonly hostname: () => string;
  /** Whether a process with this pid runs. */
  readonly running: (pid: number) => boolean;
  /** Whether that process is a Node program (a runner is one); `null` when it can't be told. */
  readonly nodeProgram: (pid: number) => Promise<boolean | null>;
};

export type HeldLock = {
  readonly file: string;
  /** Removes the lock file, if it's still this one's. */
  readonly release: () => Promise<void>;
};

export type TakeLock =
  | { readonly kind: "taken"; readonly lock: HeldLock; readonly tookOver: { readonly holder: LockRecord | null; readonly reason: StaleReason } | null }
  | { readonly kind: "held"; readonly holder: LockRecord; readonly file: string }
  | { readonly kind: "failed"; readonly message: string };

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return codeOf(error) === "EPERM";
  }
};

const execText = (file: string, args: readonly string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });

/** The program name of a running pid: `/proc` on Linux, `ps` on macOS, `tasklist` on Windows. */
const programName = async (pid: number): Promise<string | null> => {
  if (process.platform === "linux") {
    return readFile(`/proc/${String(pid)}/comm`, "utf8").then(
      (text) => text.trim(),
      () => null,
    );
  }
  if (process.platform === "win32") {
    // `"node.exe","1234","Console","1","45,000 K"`, or a line of words when nothing matches.
    const text = await execText("tasklist", ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"]);
    const match = text === null ? null : /^"([^"]+)","(\d+)"/m.exec(text.trim());
    return match?.[2] === String(pid) ? (match[1] ?? null) : null;
  }
  const text = await execText("ps", ["-p", String(pid), "-o", "comm="]);
  return text === null || text.trim() === "" ? null : path.basename(text.trim());
};

export const systemLockProbe: LockProbe = {
  pid: process.pid,
  hostname: () => os.hostname(),
  running,
  nodeProgram: async (pid) => {
    const name = await programName(pid);
    return name === null ? null : /node|ostra/i.test(name);
  },
};

type Found =
  | { readonly kind: "missing" }
  | { readonly kind: "found"; readonly text: string; readonly record: LockRecord | null };

const readLock = async (file: string): Promise<Found> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  try {
    const parsed = lockRecordSchema.safeParse(JSON.parse(text));
    return { kind: "found", text, record: parsed.success ? parsed.data : null };
  } catch {
    return { kind: "found", text, record: null };
  }
};

/** Why `record` no longer holds the folder, or `null` while its runner still runs. */
const staleReason = async (record: LockRecord, probe: LockProbe): Promise<StaleReason | null> => {
  if (record.hostname !== probe.hostname()) {
    return "another-host";
  }
  if (record.pid === probe.pid) {
    return "own-pid";
  }
  if (!probe.running(record.pid)) {
    return "not-running";
  }
  return (await probe.nodeProgram(record.pid)) === false ? "not-a-runner" : null;
};

/** How long a lock file being written by another runner is given to hold its record. */
const WRITE_GRACE_MS = 200;
const ATTEMPTS = 5;

/** Takes the data folder's lock for this process, or says which runner holds it. */
export const takeRunnerLock = async (dataDir: string, probe: LockProbe = systemLockProbe): Promise<TakeLock> => {
  const file = dataPaths(dataDir).lock;
  const mine: LockRecord = { pid: probe.pid, hostname: probe.hostname(), startedAt: Date.now(), nonce: randomUUID() };
  const release = async (): Promise<void> => {
    const current = await readLock(file).catch(() => null);
    if (current?.kind === "found" && current.record?.nonce === mine.nonce) {
      await rm(file, { force: true });
    }
  };
  let tookOver: { readonly holder: LockRecord | null; readonly reason: StaleReason } | null = null;
  try {
    await mkdir(dataDir, { recursive: true });
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        await writeFile(file, `${JSON.stringify(mine)}\n`, { flag: "wx" });
        return { kind: "taken", lock: { file, release }, tookOver };
      } catch (error) {
        if (codeOf(error) !== "EEXIST") {
          throw error;
        }
      }
      let found = await readLock(file);
      if (found.kind === "found" && found.record === null) {
        // Made by another runner a moment ago, and not written yet; or left half written by a crash.
        await new Promise((resolve) => setTimeout(resolve, WRITE_GRACE_MS));
        found = await readLock(file);
      }
      if (found.kind === "missing") {
        continue;
      }
      let reason: StaleReason = "unreadable";
      if (found.record !== null) {
        const stale = await staleReason(found.record, probe);
        if (stale === null) {
          return { kind: "held", holder: found.record, file };
        }
        reason = stale;
      }
      // Stale: moved aside, then checked to be the lock judged stale, not one another runner took
      // in the meantime. That one goes back.
      const aside = `${file}.${String(probe.pid)}.${mine.nonce}`;
      try {
        await rename(file, aside);
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT") {
          continue;
        }
        if (code === "EPERM" || code === "EBUSY") {
          // Windows: another process has it open for a moment.
          await new Promise((resolve) => setTimeout(resolve, WRITE_GRACE_MS));
          continue;
        }
        throw error;
      }
      const moved = await readFile(aside, "utf8").catch(() => null);
      if (moved !== found.text) {
        await rename(aside, file).catch(() => undefined);
        continue;
      }
      await rm(aside, { force: true });
      tookOver = { holder: found.record, reason };
    }
    return { kind: "failed", message: `another runner kept taking ${file} as this one tried; start it again` };
  } catch (error) {
    return { kind: "failed", message: `can't take ${file} (${codeOf(error) ?? "unknown error"})` };
  }
};

/** What a second runner on a held data folder says before it exits. */
export const lockHeldMessage = (dataDir: string, held: Extract<TakeLock, { kind: "held" }>): string => {
  const pid = String(held.holder.pid);
  return (
    `Another ostra runner (pid ${pid}) is running with this data folder, ${dataDir}, so this one won't start: two runners with one identity take its connection from each other. ` +
    `Stop that one first, or start this one with its own --data-dir. If pid ${pid} isn't an ostra runner, delete ${held.file}.`
  );
};
