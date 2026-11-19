// A Windows job object per task (ADR 0029, Q126, milestone 2's ticket 42), made by the runner
// itself through `koffi` (ADR 0007). A job holds processes: every child of a process in it is in it
// too, from its first instruction, and the job doesn't allow breakaway, so a helper the agent
// detaches and whose parent exits stays in it. `TerminateJobObject` ends all of them, and
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the kernel end them when the runner's handle closes,
// a runner that was killed included. `context/research/host-process-containment.md` has the probe
// this ports, run on Windows 11 x64.
//
// Everything Windows-specific is in this file: the kernel32 prototypes, the struct layouts and the
// one dynamic import of `koffi`, made on `win32` only, so no other system loads it.

/** `JOBOBJECTINFOCLASS` values and flags, from the Windows SDK's `winnt.h`. */
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** `OpenProcess` access rights `AssignProcessToJobObject` needs. */
export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_SET_QUOTA = 0x0100;

/**
 * The kernel32 functions the unit calls, as koffi prototypes (`__stdcall`, which x64 and arm64
 * ignore). A wrong one crashes the runner's process, so each is fixed here and checked by a test.
 */
export const kernel32Prototypes = {
  CreateJobObjectW: { result: "HANDLE", args: ["void *", "str16"] },
  SetInformationJobObject: { result: "bool", args: ["HANDLE", "int", "void *", "uint32_t"] },
  QueryInformationJobObject: { result: "bool", args: ["HANDLE", "int", "void *", "uint32_t", "void *"] },
  OpenProcess: { result: "HANDLE", args: ["uint32_t", "bool", "uint32_t"] },
  AssignProcessToJobObject: { result: "bool", args: ["HANDLE", "HANDLE"] },
  TerminateJobObject: { result: "bool", args: ["HANDLE", "uint32_t"] },
  CloseHandle: { result: "bool", args: ["HANDLE"] },
} as const;

export type Kernel32Name = keyof typeof kernel32Prototypes;

/**
 * `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on 64-bit Windows (x64 and arm64, the runner's two): a
 * `JOBOBJECT_BASIC_LIMIT_INFORMATION` (64 bytes, `LimitFlags` at 16), an `IO_COUNTERS` (48) and four
 * `SIZE_T`s (32). The unit sets `LimitFlags` and leaves the rest zero.
 */
export const EXTENDED_LIMIT_INFORMATION_BYTES = 144;
export const LIMIT_FLAGS_OFFSET = 16;

export const encodeExtendedLimitInformation = (limitFlags: number): Buffer => {
  const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_BYTES);
  info.writeUInt32LE(limitFlags, LIMIT_FLAGS_OFFSET);
  return info;
};

/**
 * `JOBOBJECT_BASIC_PROCESS_ID_LIST`: two `DWORD`s (assigned, listed) and then the listed PIDs as
 * `ULONG_PTR`s, 8 bytes each on 64-bit Windows.
 */
export const PROCESS_ID_LIST_HEADER_BYTES = 8;
export const processIdListBuffer = (capacity: number): Buffer => Buffer.alloc(PROCESS_ID_LIST_HEADER_BYTES + 8 * capacity);

export const decodeProcessIdList = (buffer: Buffer): { readonly assigned: number; readonly pids: readonly number[] } => {
  const assigned = buffer.readUInt32LE(0);
  const listed = Math.min(buffer.readUInt32LE(4), Math.floor((buffer.length - PROCESS_ID_LIST_HEADER_BYTES) / 8));
  const pids: number[] = [];
  for (let index = 0; index < listed; index += 1) {
    pids.push(Number(buffer.readBigUInt64LE(PROCESS_ID_LIST_HEADER_BYTES + 8 * index)));
  }
  return { assigned, pids };
};

/** One job: the handle the runner holds. */
export type JobHandle = {
  /** Puts a process in the job. `false` when it's gone, or Windows refused it. */
  readonly assign: (pid: number) => boolean;
  /** The PIDs in the job now. */
  readonly pids: () => readonly number[];
  /** Ends every process in the job. */
  readonly terminate: () => boolean;
  /** Closes the handle: with kill-on-close, the kernel ends what's left. */
  readonly close: () => void;
};

export type JobObjects = {
  /** A new job with kill-on-close. Throws when Windows refuses one. */
  readonly create: () => JobHandle;
};

export type JobObjectsLoad = { readonly ok: true; readonly value: JobObjects } | { readonly ok: false; readonly reason: string };

/** What the loader needs of koffi: a library handle whose functions it declares. */
type KoffiLike = {
  readonly load: (path: string) => { readonly func: (convention: string, name: string, result: unknown, args: unknown[]) => (...args: unknown[]) => unknown };
  readonly pointer: (ref: unknown) => unknown;
  readonly opaque: () => unknown;
};

export type JobObjectsLoaderOptions = {
  readonly platform?: NodeJS.Platform;
  /** How koffi is imported. Default: `import("koffi")`. A test fakes a failure here. */
  readonly importKoffi?: () => Promise<unknown>;
};

/** The largest number of processes one listing reads; a task with more is listed again, larger. */
const LIST_CAPACITY = 1024;

const isKoffiLike = (value: unknown): value is KoffiLike =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "load") === "function" &&
  typeof Reflect.get(value, "pointer") === "function" &&
  typeof Reflect.get(value, "opaque") === "function";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown";

/**
 * Loads koffi and kernel32's job functions: on `win32` only, and never throwing. On another system
 * it doesn't import koffi at all. A failure says why, for the runner's log: koffi's binary refused
 * (an allowlist, an antivirus), a missing function.
 */
export const loadJobObjects = async (options: JobObjectsLoaderOptions = {}): Promise<JobObjectsLoad> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: false, reason: `job objects are a Windows feature, and this is ${platform}` };
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
    const kernel32 = koffi.load("kernel32.dll");
    // An unnamed pointer type: koffi's type names are global to the process, and a name declared
    // twice is refused.
    const handle = koffi.pointer(koffi.opaque());
    const declare = (name: Kernel32Name): ((...args: unknown[]) => unknown) => {
      const prototype = kernel32Prototypes[name];
      return kernel32.func(
        "__stdcall",
        name,
        prototype.result === "HANDLE" ? handle : prototype.result,
        prototype.args.map((arg) => (arg === "HANDLE" ? handle : arg)),
      );
    };
    const createJobObject = declare("CreateJobObjectW");
    const setInformation = declare("SetInformationJobObject");
    const queryInformation = declare("QueryInformationJobObject");
    const openProcess = declare("OpenProcess");
    const assignProcess = declare("AssignProcessToJobObject");
    const terminateJob = declare("TerminateJobObject");
    const closeHandle = declare("CloseHandle");

    const create = (): JobHandle => {
      const job = createJobObject(null, null);
      if (job === null || job === undefined) {
        throw new Error("CreateJobObjectW refused a job");
      }
      const info = encodeExtendedLimitInformation(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
      if (setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length) !== true) {
        closeHandle(job);
        throw new Error("SetInformationJobObject refused kill-on-close");
      }
      let open = true;
      return {
        assign: (pid) => {
          if (!open) {
            return false;
          }
          const processHandle = openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
          if (processHandle === null || processHandle === undefined) {
            return false;
          }
          try {
            return assignProcess(job, processHandle) === true;
          } finally {
            closeHandle(processHandle);
          }
        },
        pids: () => {
          if (!open) {
            return [];
          }
          for (let capacity = LIST_CAPACITY; ; capacity *= 4) {
            const buffer = processIdListBuffer(capacity);
            // A list longer than the buffer fails with ERROR_MORE_DATA, and says how many it holds.
            const listed = queryInformation(job, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buffer, buffer.length, null) === true;
            const decoded = decodeProcessIdList(buffer);
            if (listed || decoded.assigned <= capacity || capacity >= 64 * LIST_CAPACITY) {
              return decoded.pids;
            }
          }
        },
        terminate: () => open && terminateJob(job, 1) === true,
        close: () => {
          if (open) {
            open = false;
            closeHandle(job);
          }
        },
      };
    };
    // One job made and closed at once: the functions answer, so the executor can rely on them.
    create().close();
    return { ok: true, value: { create } };
  } catch (error) {
    return { ok: false, reason: `kernel32's job functions didn't answer (${reasonOf(error)})` };
  }
};
