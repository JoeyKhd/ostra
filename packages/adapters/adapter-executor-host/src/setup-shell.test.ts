import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostExecutor } from "./host-executor.ts";
import { MISSING_SHELL_REASON_WINDOWS, resolveSetupShell } from "./setup-shell.ts";
import type { ShellProbe } from "./setup-shell.ts";

// Q136, item 9: on Windows the bare name `bash` is Git for Windows' own bash, found from the `git`
// on PATH, and never the WSL launcher. A faked Windows machine: its files, its PATH and its
// `git --exec-path`, so the tests run the same on every CI host.

const windows = (files: readonly string[], env: Record<string, string>, execPath: string | undefined): ShellProbe => {
  const present = new Set(files.map((file) => path.win32.normalize(file).toLowerCase()));
  return {
    platform: "win32",
    env,
    gitExecPath: () => Promise.resolve(execPath),
    isFile: (file) => Promise.resolve(present.has(path.win32.normalize(file).toLowerCase())),
  };
};

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const GIT_EXEC_PATH = "C:/Program Files/Git/mingw64/libexec/git-core";
const WSL_BASH = "C:\\Windows\\System32\\bash.exe";

describe("the setup shell on Windows", () => {
  it("F-050: the bare name bash resolves to Git for Windows' bin\\bash.exe from git --exec-path", async () => {
    // The WSL launcher comes first on PATH, and Git's own bin isn't on it at all: only git's cmd.
    const probe = windows(
      [GIT_BASH, WSL_BASH, "C:\\Program Files\\Git\\cmd\\git.exe"],
      { Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", SystemRoot: "C:\\Windows" },
      GIT_EXEC_PATH,
    );
    expect(await resolveSetupShell("bash", probe)).toEqual({ kind: "found", command: GIT_BASH });
    expect(await resolveSetupShell("bash.exe", probe)).toEqual({ kind: "found", command: GIT_BASH });
  });

  it("F-050: with only System32\\bash.exe to find and no Git bash, the health check is down with the fix", async () => {
    const probe = windows([WSL_BASH], { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" }, undefined);
    expect(await resolveSetupShell("bash", probe)).toEqual({ kind: "missing", reason: MISSING_SHELL_REASON_WINDOWS });

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ostra-shell-"));
    try {
      const health = await new HostExecutor({ dataDir, shellProbe: probe }).health();
      const reason = health.status === "down" ? health.reason : "";
      expect(health.status).toBe("down");
      expect(reason).toContain("Git for Windows");
      expect(reason).toContain("System32\\bash.exe");
      expect(reason).toContain("set OSTRA_RUNNER_SHELL to a shell's full path");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("F-050: a Git install with no bash falls back to a bash on PATH that isn't the WSL launcher", async () => {
    const msysBash = "C:\\msys64\\usr\\bin\\bash.exe";
    const probe = windows(
      [WSL_BASH, msysBash],
      { PATH: "C:\\Windows\\System32;C:\\msys64\\usr\\bin", SystemRoot: "C:\\Windows" },
      "D:/NoBashGit/mingw64/libexec/git-core",
    );
    expect(await resolveSetupShell("bash", probe)).toEqual({ kind: "found", command: msysBash });
  });

  it("F-050: a full path is used as given, the WSL launcher's included, and so is another name", async () => {
    const probe = windows([GIT_BASH], { PATH: "" }, GIT_EXEC_PATH);
    expect(await resolveSetupShell(WSL_BASH, probe)).toEqual({ kind: "found", command: WSL_BASH });
    expect(await resolveSetupShell("D:\\tools\\sh.exe", probe)).toEqual({ kind: "found", command: "D:\\tools\\sh.exe" });
    expect(await resolveSetupShell("zsh", probe)).toEqual({ kind: "found", command: "zsh" });
  });
});

describe("the setup shell on Linux and macOS", () => {
  it("F-050: bash comes from PATH as before, without asking git", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      let asked = false;
      const probe: ShellProbe = {
        platform,
        env: { PATH: "/usr/bin" },
        gitExecPath: () => {
          asked = true;
          return Promise.resolve("/usr/lib/git-core");
        },
        isFile: () => Promise.resolve(true),
      };
      expect(await resolveSetupShell("bash", probe)).toEqual({ kind: "found", command: "bash" });
      expect(asked).toBe(false);
    }
  });
});
