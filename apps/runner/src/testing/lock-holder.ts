import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Another process on this machine that takes a data folder's runner lock with the real code
// (`identity/runner-lock.ts`), as a running `ostra runner` does, and holds it until it ends.

const lockModule = new URL("../identity/runner-lock.ts", import.meta.url).href;

const script = [
  "const { takeRunnerLock } = await import(process.argv[1]);",
  "const taken = await takeRunnerLock(process.argv[2]);",
  "console.log(taken.kind);",
  "setInterval(() => undefined, 60_000);",
].join("\n");

export type LockHolder = {
  readonly pid: number;
  /** What its `takeRunnerLock` answered: `taken`, `held` or `failed`. */
  readonly taken: string;
  /** Ends it at once, as a crash does: its lock file stays behind. */
  readonly crash: () => Promise<void>;
};

export const startLockHolder = (dataDir: string): Promise<LockHolder> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockModule, dataDir], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    const exited = new Promise<void>((done) => {
      child.once("exit", () => {
        done();
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the lock holder said nothing in 20 s"));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    createInterface({ input: child.stdout }).once("line", (line) => {
      clearTimeout(timer);
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("the lock holder has no pid"));
        return;
      }
      resolve({
        pid,
        taken: line.trim(),
        crash: async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          await exited;
        },
      });
    });
  });
