import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";
import {
  decodeProcessIdList,
  encodeExtendedLimitInformation,
  EXTENDED_LIMIT_INFORMATION_BYTES,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  kernel32Prototypes,
  LIMIT_FLAGS_OFFSET,
  loadJobObjects,
  processIdListBuffer,
} from "./job-object.ts";

// The Windows job object (ticket 42). The layouts and prototypes are checked everywhere; the job
// itself on Windows, where it exists.

const here = path.dirname(fileURLToPath(import.meta.url));

const waitUntil = async (check: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

describe("the job object's layouts and prototypes", () => {
  it("F-014: lays out JOBOBJECT_EXTENDED_LIMIT_INFORMATION as 64-bit Windows does, with only LimitFlags set", () => {
    const info = encodeExtendedLimitInformation(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    expect(EXTENDED_LIMIT_INFORMATION_BYTES).toBe(144);
    expect(LIMIT_FLAGS_OFFSET).toBe(16);
    expect(info.length).toBe(144);
    expect(info.readUInt32LE(16)).toBe(0x2000);
    expect([...info].filter((byte, index) => byte !== 0 && (index < 16 || index >= 20))).toEqual([]);
  });

  it("F-014: reads JOBOBJECT_BASIC_PROCESS_ID_LIST: two counts, then 8-byte PIDs", () => {
    const buffer = processIdListBuffer(4);
    expect(buffer.length).toBe(8 + 32);
    buffer.writeUInt32LE(3, 0);
    buffer.writeUInt32LE(2, 4);
    buffer.writeBigUInt64LE(4242n, 8);
    buffer.writeBigUInt64LE(77n, 16);
    expect(decodeProcessIdList(buffer)).toEqual({ assigned: 3, pids: [4242, 77] });
    // A count larger than the buffer reads only what fits.
    buffer.writeUInt32LE(9, 4);
    expect(decodeProcessIdList(buffer).pids).toHaveLength(4);
  });

  it("F-014: declares the seven kernel32 functions with fixed prototypes", () => {
    expect(kernel32Prototypes).toEqual({
      CreateJobObjectW: { result: "HANDLE", args: ["void *", "str16"] },
      SetInformationJobObject: { result: "bool", args: ["HANDLE", "int", "void *", "uint32_t"] },
      QueryInformationJobObject: { result: "bool", args: ["HANDLE", "int", "void *", "uint32_t", "void *"] },
      OpenProcess: { result: "HANDLE", args: ["uint32_t", "bool", "uint32_t"] },
      AssignProcessToJobObject: { result: "bool", args: ["HANDLE", "HANDLE"] },
      TerminateJobObject: { result: "bool", args: ["HANDLE", "uint32_t"] },
      CloseHandle: { result: "bool", args: ["HANDLE"] },
    });
  });
});

describe("koffi's loading", () => {
  it("F-014: koffi isn't imported on Linux or macOS", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      let imported = false;
      const load = await loadJobObjects({
        platform,
        importKoffi: () => {
          imported = true;
          return Promise.reject(new Error("must not load"));
        },
      });
      expect(load.ok, platform).toBe(false);
      expect(imported, platform).toBe(false);
    }
    // And no module of the executor imports it statically: only job-object.ts, by `import()`.
    const sources = (await readdir(here)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of sources) {
      const text = await readFile(path.join(here, name), "utf8");
      expect(/^import[^;]*["']koffi["']/m.test(text), name).toBe(false);
      expect(text.includes('import("koffi")'), name).toBe(name === "job-object.ts");
    }
  });

  it("F-014: a koffi that can't load is a reason, not a throw", async () => {
    const load = await loadJobObjects({ platform: "win32", importKoffi: () => Promise.reject(new Error("blocked by policy")) });
    expect(load.ok).toBe(false);
    expect(load.ok ? "" : load.reason).toContain("koffi didn't load");
    expect(load.ok ? "" : load.reason).toContain("blocked by policy");
  });
});

describe.runIf(process.platform === "win32")("a job object on Windows", () => {
  it("F-014: holds a process, lists it, and ends it with TerminateJobObject", async () => {
    const load = await loadJobObjects();
    expect(load.ok).toBe(true);
    if (!load.ok) {
      return;
    }
    const job = load.value.create();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid ?? 0;
    expect(job.assign(pid)).toBe(true);
    expect(job.pids()).toContain(pid);
    expect(job.terminate()).toBe(true);
    expect(await waitUntil(() => !isAlive(pid), 5_000)).toBe(true);
    expect(await waitUntil(() => job.pids().length === 0, 5_000)).toBe(true);
    job.close();
    expect(job.assign(pid)).toBe(false);
  });

  it("F-014: ends what it holds when its last handle closes (kill-on-close)", async () => {
    const load = await loadJobObjects();
    if (!load.ok) {
      throw new Error(load.reason);
    }
    const job = load.value.create();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid ?? 0;
    expect(job.assign(pid)).toBe(true);
    job.close();
    expect(await waitUntil(() => !isAlive(pid), 5_000)).toBe(true);
  });
});
