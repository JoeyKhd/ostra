import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

// Files only their owner may read: the runner's private key (ADR 0034). On POSIX, mode 0600 in a
// 0700 folder. On Windows, an ACL with inheritance removed and one entry, for the current user,
// set through `icacls` with an argument array (never a shell line).

const run = promisify(execFile);

/** The current user as `icacls` names them: `DOMAIN\user` when Windows says the domain. */
const windowsAccount = (env: NodeJS.ProcessEnv = process.env): string => {
  const user = os.userInfo().username;
  const domain = env["USERDOMAIN"];
  return domain === undefined || domain === "" ? user : [domain, user].join("\\");
};

const restrictWindows = async (target: string, isDirectory: boolean): Promise<void> => {
  const grant = isDirectory ? `${windowsAccount()}:(OI)(CI)F` : `${windowsAccount()}:F`;
  await run("icacls", [target, "/inheritance:r", "/grant:r", grant], { windowsHide: true });
};

/** Makes a folder that only its owner can open, and every file made in it after. */
export const makeOwnerOnlyDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await restrictWindows(dir, true);
  } else {
    await chmod(dir, 0o700);
  }
};

/** Writes a file that only its owner can read. Its folder should be owner-only already. */
export const writeOwnerOnlyFile = async (file: string, content: string): Promise<void> => {
  await writeFile(file, content, { mode: 0o600, flag: "w" });
  if (process.platform === "win32") {
    await restrictWindows(file, false);
  } else {
    await chmod(file, 0o600);
  }
};

export type OwnerOnlyCheck = { readonly ownerOnly: true } | { readonly ownerOnly: false; readonly reason: string };

const parseIcaclsEntries = (output: string, target: string): readonly string[] => {
  // `icacls <file>` prints the file with its first entry on one line, one entry per line after,
  // then a blank line and a summary.
  const entries: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.startsWith(target) ? raw.slice(target.length) : raw;
    const entry = line.trim();
    if (entry === "") {
      break;
    }
    entries.push(entry);
  }
  return entries;
};

/** Whether only the current user can read `file`. Used by the tests and by `ostra runner status`. */
export const checkOwnerOnly = async (file: string): Promise<OwnerOnlyCheck> => {
  if (process.platform === "win32") {
    const { stdout } = await run("icacls", [file], { windowsHide: true });
    const entries = parseIcaclsEntries(stdout, file);
    const user = os.userInfo().username.toLowerCase();
    if (entries.length !== 1) {
      return { ownerOnly: false, reason: `the ACL has ${String(entries.length)} entries` };
    }
    const [entry] = entries;
    if (entry === undefined || !entry.toLowerCase().includes(`${user}:`) || entry.includes("(I)")) {
      return { ownerOnly: false, reason: "the ACL's one entry is not the current user's own" };
    }
    return { ownerOnly: true };
  }
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0) {
    return { ownerOnly: false, reason: `mode ${(info.mode & 0o777).toString(8)} lets others read it` };
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    return { ownerOnly: false, reason: "another user owns it" };
  }
  return { ownerOnly: true };
};
