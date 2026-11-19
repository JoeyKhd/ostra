import type { ProcessInfo } from "./process-tree.ts";

// Every process on a Windows machine from one call to ntdll's `NtQuerySystemInformation`, made
// through `koffi` (ADR 0007), the way the host executor makes its job object (`job-object.ts` in
// @ostra/adapter-executor-host). It replaces a PowerShell per listing (about 100 MB and two seconds
// each), which piled up under parallel tests until WMI refused every query
// (`research/host-process-containment.md`, section 6).
//
// Not `CreateToolhelp32Snapshot`: its entries carry no start time, and the `OpenProcess` that
// `GetProcessTimes` needs is refused for most of the system's own processes (csrss, wininit,
// services, many svchost) to a member's account, where WMI gives every start time. A start time of
// 0 switches off `descendantsOf`'s birth check, so an agent that got the PID of a dead smss would
// adopt wininit's whole tree. `SYSTEM_PROCESS_INFORMATION` has the PID, the parent's PID, the image
// name and the creation time of every process, and opens no handle.
//
// Everything Windows-specific is in this file: the ntdll prototype, the struct layout and the one
// dynamic import of `koffi`, made on `win32` only, so no other system loads it.

/** `SystemProcessInformation`, from `winternl.h`'s `SYSTEM_INFORMATION_CLASS`. */
export const SYSTEM_PROCESS_INFORMATION = 5;
/** `STATUS_INFO_LENGTH_MISMATCH` (0xC0000004) as the signed `NTSTATUS` koffi returns. */
export const STATUS_INFO_LENGTH_MISMATCH = -1_073_741_820;

/** The ntdll function the lister calls, as a koffi prototype (`__stdcall`, which x64 and arm64 ignore). */
export const ntdllPrototypes = {
  NtQuerySystemInformation: { result: "int32_t", args: ["int32_t", "void *", "uint32_t", "void *"] },
} as const;

/**
 * Where `SYSTEM_PROCESS_INFORMATION`'s fields are on 64-bit Windows (x64 and arm64, the runner's
 * two). `winternl.h` names the image name and the PID; the creation time is in its `Reserved1` and
 * the parent's PID is its `Reserved2`. `ImageName` is a `UNICODE_STRING`: a length in bytes, then
 * a pointer into the same buffer.
 */
export const processEntryLayout = {
  nextEntryOffset: 0x00,
  createTime: 0x20,
  imageNameLength: 0x38,
  imageNameBuffer: 0x40,
  uniqueProcessId: 0x50,
  inheritedFromUniqueProcessId: 0x58,
  /** The bytes an entry needs for the fields above. */
  bytesRead: 0x60,
} as const;

/** 100-ns intervals from 1601-01-01, a `FILETIME`'s epoch, to 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/**
 * Reads the process entries `NtQuerySystemInformation` wrote into `buffer`, which starts at
 * `address` in memory (the image names point into it). The creation time is truncated to the
 * millisecond, as WMI's `CreationDate` was.
 */
export const decodeProcessEntries = (buffer: Buffer, address: bigint): ProcessInfo[] => {
  const out: ProcessInfo[] = [];
  const layout = processEntryLayout;
  for (let offset = 0; offset + layout.bytesRead <= buffer.length; ) {
    const nameBytes = buffer.readUInt16LE(offset + layout.imageNameLength);
    const namePointer = buffer.readBigUInt64LE(offset + layout.imageNameBuffer);
    const nameAt = namePointer - address;
    const name =
      namePointer !== 0n && nameAt >= 0n && nameAt + BigInt(nameBytes) <= BigInt(buffer.length)
        ? buffer.toString("utf16le", Number(nameAt), Number(nameAt) + nameBytes)
        : "";
    const created = buffer.readBigInt64LE(offset + layout.createTime);
    out.push({
      pid: Number(buffer.readBigUInt64LE(offset + layout.uniqueProcessId)),
      ppid: Number(buffer.readBigUInt64LE(offset + layout.inheritedFromUniqueProcessId)),
      name,
      startedAt: created > FILETIME_UNIX_EPOCH ? Number((created - FILETIME_UNIX_EPOCH) / 10_000n) : 0,
    });
    const next = buffer.readUInt32LE(offset + layout.nextEntryOffset);
    if (next === 0) {
      break;
    }
    offset += next;
  }
  return out;
};

/** Lists every process on the machine. Rejects when the call fails. */
export type WindowsProcessLister = () => Promise<ProcessInfo[]>;

export type WindowsProcessListerLoad = { readonly ok: true; readonly value: WindowsProcessLister } | { readonly ok: false; readonly reason: string };

export type WindowsProcessListerOptions = {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  /** How koffi is imported. Default: `import("koffi")`. A test fakes a failure here. */
  readonly importKoffi?: () => Promise<unknown>;
};

/** A koffi function's asynchronous form: it runs on one of koffi's threads, and calls back. */
type AsyncNative = { readonly async: (...args: unknown[]) => void };

/** What the lister needs of koffi. */
type KoffiLike = {
  readonly load: (path: string) => { readonly func: (convention: string, name: string, result: string, args: string[]) => unknown };
  readonly address: (value: unknown) => unknown;
};

const isKoffiLike = (value: unknown): value is KoffiLike =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "load") === "function" && typeof Reflect.get(value, "address") === "function";

const isAsyncNative = (value: unknown): value is AsyncNative => typeof value === "function" && typeof Reflect.get(value, "async") === "function";

const reasonOf = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown");

/** The first buffer's size. A machine with more processes needs more; the lister remembers how much. */
const FIRST_BUFFER_BYTES = 1024 * 1024;
/** Room for the processes started between the call that gave the size and the next one. */
const GROWTH_BYTES = 256 * 1024;
/** How often a listing asks again after the table outgrew its buffer. */
const ATTEMPTS = 8;

/**
 * Loads koffi and ntdll's `NtQuerySystemInformation`: on 64-bit Windows only, and never throwing.
 * On another system it doesn't import koffi at all. A failure says why. The call runs on koffi's
 * own threads, so a listing on a loaded machine (tens of ms) doesn't hold up the event loop.
 */
export const loadWindowsProcessLister = async (options: WindowsProcessListerOptions = {}): Promise<WindowsProcessListerLoad> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: false, reason: `the native process list is a Windows feature, and this is ${platform}` };
  }
  const arch = options.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    return { ok: false, reason: `the process list's layout is 64-bit Windows', and this is ${arch}` };
  }
  let loaded: unknown;
  try {
    loaded = await (options.importKoffi ?? (() => import("koffi")))();
  } catch (error) {
    return { ok: false, reason: `koffi didn't load (${reasonOf(error)})` };
  }
  const koffi: unknown = isKoffiLike(loaded) ? loaded : typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (!isKoffiLike(koffi)) {
    return { ok: false, reason: "koffi loaded without its functions" };
  }
  try {
    const prototype = ntdllPrototypes.NtQuerySystemInformation;
    const query = koffi.load("ntdll.dll").func("__stdcall", "NtQuerySystemInformation", prototype.result, [...prototype.args]);
    if (!isAsyncNative(query)) {
      throw new Error("koffi declared NtQuerySystemInformation without its async form");
    }
    const call = (buffer: Buffer, needed: Buffer): Promise<unknown> =>
      new Promise((resolve, reject) => {
        query.async(SYSTEM_PROCESS_INFORMATION, buffer, buffer.length, needed, (error: unknown, status: unknown) => {
          if (error !== null && error !== undefined) {
            reject(error instanceof Error ? error : new Error("NtQuerySystemInformation's call failed"));
            return;
          }
          resolve(status);
        });
      });
    let size = FIRST_BUFFER_BYTES;
    const list: WindowsProcessLister = async () => {
      // A buffer per listing: two listings at once never share one.
      const needed = Buffer.alloc(4);
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const buffer = Buffer.alloc(size);
        const status = await call(buffer, needed);
        if (status === 0) {
          const address = koffi.address(buffer);
          if (typeof address !== "bigint") {
            throw new TypeError("koffi gave no address for the buffer");
          }
          return decodeProcessEntries(buffer, address);
        }
        if (status !== STATUS_INFO_LENGTH_MISMATCH) {
          throw new Error(`NtQuerySystemInformation returned 0x${(Number(status) >>> 0).toString(16)}`);
        }
        // The table outgrew the buffer: what it needed then, and room for what started since.
        size = Math.max(size, needed.readUInt32LE(0)) + GROWTH_BYTES;
      }
      throw new Error("the process table kept outgrowing its buffer");
    };
    // One listing at once: the call answers, and the layout reads this very process as it is.
    const self = (await list()).find((p) => p.pid === process.pid);
    if (self?.ppid !== process.ppid || self.name === "" || self.startedAt === 0) {
      throw new Error("the listing didn't show this process as it is");
    }
    return { ok: true, value: list };
  } catch (error) {
    return { ok: false, reason: `ntdll's process list didn't answer (${reasonOf(error)})` };
  }
};
