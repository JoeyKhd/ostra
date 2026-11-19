import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killTree, silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenForInit } from "../bridge/bridge-server.ts";
import { PREPARE_FAILURE_PREFIX, parsePrepareJob, PrepareJobError, runPrepareJob } from "./prepare.ts";

// The prepare step takes its job from outside the init's process, so it checks the job like any
// other boundary: strictly, and before the first write.

const MAIN = fileURLToPath(new URL("./prepare-main.ts", import.meta.url));
const INIT = fileURLToPath(new URL("./main.ts", import.meta.url));
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-prepare-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const runMain = (input: string): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN], { stdio: ["pipe", "ignore", "pipe"], env: { PATH: process.env["PATH"] ?? "" }, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      resolve({ code, stderr });
    });
    child.stdin.end(input);
  });

describe("parsePrepareJob", () => {
  it("accepts folders and files", () => {
    const job = parsePrepareJob(JSON.stringify({ dirs: [join(root, "a")], files: [{ path: join(root, "a", "f"), content: b64("x"), mode: 0o600 }] }));
    expect(job.dirs).toHaveLength(1);
    expect(job.files[0]?.mode).toBe(0o600);
  });

  it.each([
    ["text that is not JSON", "{nope"],
    ["a job that is not an object", "[]"],
    ["an unknown field", JSON.stringify({ dirs: [], files: [], extra: 1 })],
    ["dirs that is not a list", JSON.stringify({ dirs: "/x", files: [] })],
    ["a relative dir", JSON.stringify({ dirs: ["relative/dir"], files: [] })],
    ["a file without a mode", JSON.stringify({ dirs: [], files: [{ path: "/x", content: "" }] })],
    ["a mode over 0o777", JSON.stringify({ dirs: [], files: [{ path: "/x", content: "", mode: 0o7777 }] })],
    ["an unknown file field", JSON.stringify({ dirs: [], files: [{ path: "/x", content: "", mode: 0o600, owner: "root" }] })],
    ["a non-string content", JSON.stringify({ dirs: [], files: [{ path: "/x", content: 5, mode: 0o600 }] })],
  ])("rejects %s", (_name, text) => {
    expect(() => parsePrepareJob(text)).toThrow(PrepareJobError);
  });

  it("names the bad field and never its value", () => {
    const secret = "sekret-file-content";
    try {
      parsePrepareJob(JSON.stringify({ dirs: [], files: [{ path: "/x", content: secret, mode: "wide" }] }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrepareJobError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("files.0.mode");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("wide");
    }
  });
});

describe("runPrepareJob", () => {
  it("makes the folders and writes the files with their mode", async () => {
    const file = join(root, "a", "b", "token");
    await runPrepareJob(JSON.stringify({ dirs: [join(root, "a", "b")], files: [{ path: file, content: b64("hello"), mode: 0o600 }] }));
    expect(await readFile(file, "utf8")).toBe("hello");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("writes nothing when one entry of the job is invalid", async () => {
    const good = join(root, "made");
    await expect(
      runPrepareJob(JSON.stringify({ dirs: [good], files: [{ path: join(good, "f"), content: b64("x"), mode: 99_999 }] })),
    ).rejects.toThrow(PrepareJobError);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("prepare-main", () => {
  it("exits 0 and writes the files", async () => {
    const file = join(root, "out");
    const result = await runMain(JSON.stringify({ dirs: [], files: [{ path: file, content: b64("done"), mode: 0o600 }] }));
    expect(result.code).toBe(0);
    expect(await readFile(file, "utf8")).toBe("done");
  });

  it("exits 1 with one prefixed line that carries no content, and writes nothing", async () => {
    const secret = "sekret-file-content";
    const result = await runMain(JSON.stringify({ dirs: [join(root, "made")], files: [{ path: join(root, "made", "f"), content: secret, mode: "wide" }] }));
    expect(result.code).toBe(1);
    const line = result.stderr.split("\n").findLast((item) => item.startsWith(PREPARE_FAILURE_PREFIX));
    expect(line).toContain("files.0.mode");
    expect(result.stderr).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a file system failure by its code", async () => {
    const result = await runMain(JSON.stringify({ dirs: [], files: [{ path: join(root, "missing-dir", "f"), content: b64("x"), mode: 0o600 }] }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${PREPARE_FAILURE_PREFIX}ENOENT`);
    expect(result.stderr).not.toContain("missing-dir");
  });
});

describe("the init's prepare frame", () => {
  it("runs prepare-main as its child, and relays only its prefixed reason", async () => {
    const boxId = boxIdSchema.parse("prepare-box");
    const nonce = randomBytes(32).toString("base64url");
    const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
    const init = spawn(process.execPath, [INIT], {
      env: { ...process.env, OSTRA_BOX_ID: boxId, OSTRA_BRIDGE_NONCE: nonce, OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}` },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const bridge = await listener.connected;
    try {
      const file = join(root, "a", "token");
      await bridge.prepare([join(root, "a")], [{ path: file, content: Buffer.from("hello"), mode: 0o600 }]);
      expect(await readFile(file, "utf8")).toBe("hello");

      const missing = join(root, "missing-dir", "f");
      const failed = await bridge.prepare([], [{ path: missing, content: Buffer.from("x"), mode: 0o600 }]).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      const message = failed instanceof Error ? failed.message : "";
      expect(message).toContain(`${PREPARE_FAILURE_PREFIX}ENOENT`);
      expect(message).not.toContain("missing-dir");
    } finally {
      bridge.close();
      // Only while it runs: an exited init's PID may be another process's by now.
      if (init.pid !== undefined && init.exitCode === null && init.signalCode === null) {
        await killTree(init.pid);
      }
    }
  }, 30_000);
});
