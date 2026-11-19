import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TASK_TOKEN_FILE, writeTaskTokenFile } from "./task-token.ts";

const made: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "ostra-task-token-"));
  made.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the task token's handoff (ADR 0034)", () => {
  it("F-015: writes the token as the folder's one file, handed to the sidecar's uid, and closed to everyone else", async () => {
    const dir = path.join(await scratch(), "sidecar");
    const handed: (readonly [string, number, number])[] = [];
    const written = await writeTaskTokenFile(dir, { kind: "owner", uid: 4242, gid: 4343 }, "ostra_tt_one", {
      chown: (target, uid, gid) => {
        handed.push([path.basename(target), uid, gid]);
        return Promise.resolve();
      },
    });
    expect(written).toEqual({ ok: true, value: path.join(dir, TASK_TOKEN_FILE) });
    expect(await readFile(path.join(dir, TASK_TOKEN_FILE), "utf8")).toBe("ostra_tt_one");
    // The folder and the file both go to the sidecar's user before the file is in place.
    expect(handed).toEqual([
      ["sidecar", 4242, 4343],
      [`${TASK_TOKEN_FILE}.next`, 4242, 4343],
    ]);
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o500);
      expect((await stat(path.join(dir, TASK_TOKEN_FILE))).mode & 0o777).toBe(0o400);
    }
  });

  it("F-015: a folder left by an earlier try is made afresh, so no old token survives", async () => {
    const dir = path.join(await scratch(), "sidecar");
    const owner = { kind: "group", gid: 0 } as const;
    await writeTaskTokenFile(dir, owner, "ostra_tt_old");
    const again = await writeTaskTokenFile(dir, owner, "ostra_tt_new");
    expect(again.ok).toBe(true);
    expect(await readFile(path.join(dir, TASK_TOKEN_FILE), "utf8")).toBe("ostra_tt_new");
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, TASK_TOKEN_FILE))).mode & 0o777).toBe(0o440);
    }
  });

  it("F-015: where no file can be restricted, nothing is written and the handoff is refused", async () => {
    const dir = path.join(await scratch(), "sidecar");
    expect(await writeTaskTokenFile(dir, { kind: "none" }, "ostra_tt_none")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(stat(dir)).rejects.toThrow();
  });
});
