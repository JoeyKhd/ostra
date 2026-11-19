import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { listProcesses, listWindowsPowerShell } from "./process-tree.ts";
import { decodeProcessEntries, loadWindowsProcessLister, ntdllPrototypes, STATUS_INFO_LENGTH_MISMATCH, SYSTEM_PROCESS_INFORMATION } from "./windows-processes.ts";

// Windows' process list through ntdll (`windows-processes.ts`). The layout and the loading are
// checked everywhere; the list itself on Windows, against WMI's, which it replaces.

/** A `FILETIME` (100-ns intervals since 1601) for a Unix time in ms, plus `extra` intervals. */
const filetime = (unixMs: number, extra = 0n): bigint => (BigInt(unixMs) + 11_644_473_600_000n) * 10_000n + extra;

describe("ntdll's process list: layout and prototype", () => {
  it("F-014: reads SYSTEM_PROCESS_INFORMATION as 64-bit Windows lays it out: the PID, the parent's, the image name and the creation time", () => {
    const buffer = Buffer.alloc(0x300);
    const address = 0x7ff6_1234_0000n;
    // The idle process: no name, no creation time.
    buffer.writeUInt32LE(0x180, 0x00);
    // A node.exe started at 2026-11-19T10:00:00.123Z and 456.7 µs, under PID 4.
    const entry = 0x180;
    buffer.writeUInt32LE(0, entry + 0x00);
    buffer.writeBigInt64LE(filetime(Date.UTC(2026, 10, 19, 10, 0, 0, 123), 4_567n), entry + 0x20);
    const name = Buffer.from("node.exe", "utf16le");
    name.copy(buffer, 0x2a0);
    buffer.writeUInt16LE(name.length, entry + 0x38);
    buffer.writeUInt16LE(name.length + 2, entry + 0x3a);
    buffer.writeBigUInt64LE(address + 0x2a0n, entry + 0x40);
    buffer.writeBigUInt64LE(8848n, entry + 0x50);
    buffer.writeBigUInt64LE(4n, entry + 0x58);

    expect(decodeProcessEntries(buffer, address)).toEqual([
      { pid: 0, ppid: 0, name: "", startedAt: 0 },
      { pid: 8848, ppid: 4, name: "node.exe", startedAt: Date.UTC(2026, 10, 19, 10, 0, 0, 123) },
    ]);
    // A name that points outside the buffer is read as none, not from stray memory.
    buffer.writeBigUInt64LE(address + 0x10_000n, entry + 0x40);
    expect(decodeProcessEntries(buffer, address)[1]?.name).toBe("");
  });

  it("F-014: declares NtQuerySystemInformation with a fixed prototype", () => {
    expect(ntdllPrototypes).toEqual({ NtQuerySystemInformation: { result: "int32_t", args: ["int32_t", "void *", "uint32_t", "void *"] } });
    expect(SYSTEM_PROCESS_INFORMATION).toBe(5);
    expect(STATUS_INFO_LENGTH_MISMATCH >>> 0).toBe(0xc0_00_00_04);
  });
});

describe("ntdll's process list: loading koffi", () => {
  it("F-014: koffi isn't imported on Linux, macOS or 32-bit Windows", async () => {
    let imported = 0;
    const importKoffi = (): Promise<unknown> => {
      imported += 1;
      return Promise.reject(new Error("imported"));
    };
    expect(await loadWindowsProcessLister({ platform: "linux", importKoffi })).toMatchObject({ ok: false });
    expect(await loadWindowsProcessLister({ platform: "darwin", importKoffi })).toMatchObject({ ok: false });
    expect(await loadWindowsProcessLister({ platform: "win32", arch: "ia32", importKoffi })).toMatchObject({ ok: false });
    expect(imported).toBe(0);
  });

  it("F-014: a koffi that can't load is a reason, not a throw", async () => {
    const load = await loadWindowsProcessLister({ platform: "win32", arch: "x64", importKoffi: () => Promise.reject(new Error("blocked by policy")) });
    expect(load).toEqual({ ok: false, reason: "koffi didn't load (Error: blocked by policy)" });
  });
});

const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
});

// WMI, through PowerShell, is what the list replaces, so on Windows the two must agree. Elsewhere
// there's no ntdll to call: Linux and macOS keep /proc and `ps`.
describe.runIf(process.platform === "win32")("ntdll's process list on Windows", () => {
  it("F-014: lists the same PIDs, parents, names and start times as WMI for a tree it starts", async () => {
    const parent = spawn(
      process.execPath,
      ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    started.push(parent);
    const childPid = await new Promise<number>((resolve) => {
      parent.stdout.once("data", (chunk: Buffer) => {
        resolve(Number(chunk.toString("utf8").trim()));
      });
    });
    try {
      const load = await loadWindowsProcessLister();
      if (!load.ok) {
        throw new Error(load.reason);
      }
      const [native, wmi] = await Promise.all([load.value(), listWindowsPowerShell()]);
      for (const pid of [parent.pid, childPid, process.pid]) {
        const fromWmi = wmi.find((p) => p.pid === pid);
        expect(fromWmi?.startedAt, `WMI's start time of ${String(pid)}`).toBeGreaterThan(0);
        expect(native.find((p) => p.pid === pid)).toEqual(fromWmi);
      }
      // The system's own processes, which `OpenProcess` refuses a member, have their start times too.
      expect(native.filter((p) => p.pid > 4 && p.startedAt === 0)).toEqual([]);
    } finally {
      // Its parent is still alive here, so the PID is still the child's.
      process.kill(childPid, "SIGKILL");
    }
  }, 60_000);

  it("F-014: the machine's listing is ntdll's, not a PowerShell", async () => {
    // WMI names PID 0 "System Idle Process"; the kernel's own list leaves it unnamed.
    expect((await listProcesses()).find((p) => p.pid === 0)?.name).toBe("");
  }, 60_000);
});
