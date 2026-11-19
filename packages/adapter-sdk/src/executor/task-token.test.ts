import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTaskTokenDir, TASK_TOKEN_FILE, writeTaskTokenDirFile, writeTaskTokenFile } from "./task-token.ts";

const made: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "ostra-task-token-"));
  made.push(dir);
  return dir;
};

const posix = process.platform !== "win32";
const modeOf = async (target: string): Promise<number> => (await stat(target)).mode & 0o777;

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the task token's handoff (ADR 0034)", () => {
  it("F-015: writes the token as the folder's one file, handed to the sidecar's uid, and closed to everyone else", async () => {
    const dir = path.join(await scratch(), "sidecar");
    const owner = { kind: "owner", uid: 4242, gid: 4343 } as const;
    const handed: (readonly [string, number, number])[] = [];
    const options = {
      chown: (target: string, uid: number, gid: number): Promise<void> => {
        handed.push([path.basename(target), uid, gid]);
        return Promise.resolve();
      },
    };
    expect(await makeTaskTokenDir(dir, owner, options)).toEqual({ ok: true, value: undefined });
    if (posix) {
      expect(await modeOf(dir)).toBe(0o500);
    }
    // Only a root runner hands the folder over, and root passes every mode check, so it writes into
    // the sidecar's 0500 folder. This test isn't root: with the chown stubbed, it owns the folder
    // itself, and 0500 lets the folder's owner read it but never add a file. So it opens the folder
    // to itself for the write, as root's override does (and leaves it open, so it can be removed).
    await chmod(dir, 0o700);
    const written = await writeTaskTokenDirFile(dir, owner, TASK_TOKEN_FILE, "ostra_tt_one", options);
    expect(written).toEqual({ ok: true, value: path.join(dir, TASK_TOKEN_FILE) });
    expect(await readFile(path.join(dir, TASK_TOKEN_FILE), "utf8")).toBe("ostra_tt_one");
    expect(await readdir(dir)).toEqual([TASK_TOKEN_FILE]);
    // The folder and the file both go to the sidecar's user before the file is in place.
    expect(handed).toEqual([
      ["sidecar", 4242, 4343],
      [`${TASK_TOKEN_FILE}.next`, 4242, 4343],
    ]);
    if (posix) {
      expect(await modeOf(path.join(dir, TASK_TOKEN_FILE))).toBe(0o400);
    }
  });

  // Windows ignores POSIX modes (chmod only sets a read-only flag, which doesn't stop a new file in
  // a folder), and root passes every mode check, so only a POSIX user that isn't root can see this.
  it.skipIf(!posix || process.getuid?.() === 0)("closes the sidecar's folder to writes from its own user: 0500, inside a 0700 parent", async () => {
    const parent = await scratch();
    const dir = path.join(parent, "sidecar");
    const owner = { kind: "owner", uid: 4242, gid: 4343 } as const;
    const options = { chown: (): Promise<void> => Promise.resolve() };
    expect((await makeTaskTokenDir(dir, owner, options)).ok).toBe(true);
    expect(await modeOf(dir)).toBe(0o500);
    expect(await modeOf(parent)).toBe(0o700);
    // This user owns the folder, as the sidecar's uid does: it may read it, and may add nothing.
    await expect(writeTaskTokenDirFile(dir, owner, TASK_TOKEN_FILE, "ostra_tt_one", options)).rejects.toMatchObject({ code: "EACCES" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("F-015: a folder left by an earlier try is made afresh, so no old token survives", async () => {
    const dir = path.join(await scratch(), "sidecar");
    const owner = { kind: "group", gid: 0 } as const;
    await writeTaskTokenFile(dir, owner, "ostra_tt_old");
    const again = await writeTaskTokenFile(dir, owner, "ostra_tt_new");
    expect(again.ok).toBe(true);
    expect(await readFile(path.join(dir, TASK_TOKEN_FILE), "utf8")).toBe("ostra_tt_new");
    if (posix) {
      expect(await modeOf(dir)).toBe(0o750);
      expect(await modeOf(path.join(dir, TASK_TOKEN_FILE))).toBe(0o440);
    }
  });

  it("F-015: where no file can be restricted, nothing is written and the handoff is refused", async () => {
    const dir = path.join(await scratch(), "sidecar");
    expect(await writeTaskTokenFile(dir, { kind: "none" }, "ostra_tt_none")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(stat(dir)).rejects.toThrow();
  });
});
