import { tmpdir } from "node:os";
import path from "node:path";

import { ok } from "@ostra/adapter-sdk";
import type { AdapterResult } from "@ostra/adapter-sdk";
import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { describe, expect, it } from "vitest";

import { importedSessionId, summarizeArchive } from "./archive.ts";
import { ARCHIVE_VERIFIED_VERSIONS, OPENCODE_VERSION } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { allowedEnvNames, KEY_ENV } from "./config.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

// The session archive commands (ticket 10, F-033, ADR 0039): what the adapter names for the runner
// to run beside the agent. Whether they work is the agent suite's and the pinned binary's cases.

const binary = (version: string): OpenCodeBinary => ({
  path: path.join(tmpdir(), "opencode-not-run"),
  packageName: "@opencode/cli-test",
  packageVersion: version,
  sha256: "0".repeat(64),
});

const adapterWith = (version = OPENCODE_VERSION): OpenCodeAdapter =>
  new OpenCodeAdapter({ resolveBinary: () => Promise.resolve(ok(binary(version))) }, memoryAdapterContext());

const box = path.join(tmpdir(), "box-a");
const fresh = path.join(tmpdir(), "box-b");
const exportInput = {
  agentSessionId: "ses_e0e1c5832ffeEtCZJ2wnc4I9YS",
  agentDir: path.join(box, "agent"),
  workspaceDir: path.join(box, "workspace"),
  archivePath: path.join(box, "session.json"),
};
const importInput = {
  agentSessionId: exportInput.agentSessionId,
  agentDir: path.join(fresh, "agent"),
  workspaceDir: path.join(fresh, "workspace"),
  archivePath: path.join(fresh, "session.json"),
};

describe("the session archive commands", () => {
  it("F-033: declares sessionArchive for the pinned version, which spike 2 ran", () => {
    expect(ARCHIVE_VERIFIED_VERSIONS).toEqual(expect.arrayContaining(["2.3.0", "2.3.1", "2.3.2"]));
    expect(ARCHIVE_VERIFIED_VERSIONS).toContain(OPENCODE_VERSION);
    expect(adapterWith().capabilities.sessionArchive).toBe(true);
  });

  it("exports with `session export <id> --standalone` in the box's workspace, its output to the archive file, and no key", async () => {
    const command = await adapterWith().exportSession(exportInput);
    expect(command).toMatchObject({
      ok: true,
      value: {
        command: binary(OPENCODE_VERSION).path,
        args: ["session", "export", exportInput.agentSessionId, "--standalone"],
        cwd: exportInput.workspaceDir,
        stdoutTo: exportInput.archivePath,
      },
    });
    if (!command.ok) return;
    // The task's own folders, an allowlist, and no credential: the fake key isn't even there.
    expect(Object.keys(command.value.env).filter((name) => !allowedEnvNames.includes(name))).toEqual([]);
    expect(Object.keys(command.value.env)).not.toContain(KEY_ENV);
    expect(command.value.env["HOME"]).toBe(path.join(exportInput.agentDir, "home"));
    expect(command.value.env["XDG_DATA_HOME"]).toBe(path.join(exportInput.agentDir, "xdg", "data"));
  });

  it("imports with `--directory` set to the fresh box's workspace, always, and the same environment", async () => {
    const command = await adapterWith().importSession(importInput);
    expect(command).toMatchObject({
      ok: true,
      value: {
        command: binary(OPENCODE_VERSION).path,
        args: ["session", "import", importInput.archivePath, "--standalone", "--directory", importInput.workspaceDir],
        cwd: importInput.workspaceDir,
      },
    });
    if (!command.ok) return;
    expect(command.value).not.toHaveProperty("stdoutTo");
    expect(Object.keys(command.value.env)).not.toContain(KEY_ENV);
    expect(command.value.env["HOME"]).toBe(path.join(importInput.agentDir, "home"));
  });

  it("builds argument arrays only: a hostile path or ID is one argument, never a shell line", async () => {
    const hostile = path.join(tmpdir(), "a b; rm -rf ~ $(whoami) `id` & \"quoted\"");
    const command = await adapterWith().importSession({ ...importInput, archivePath: hostile, workspaceDir: hostile });
    expect(command).toMatchObject({ ok: true });
    if (!command.ok) return;
    expect(command.value.args).toEqual(["session", "import", hostile, "--standalone", "--directory", hostile]);
  });

  it.each(["-rf", "--standalone", "", "a b", "a;b", "$(id)", "../x", "x".repeat(200), "a\nb"])("refuses the session ID %j, which a flag or a shell could misread", async (id) => {
    expect(await adapterWith().exportSession({ ...exportInput, agentSessionId: id })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapterWith().importSession({ ...importInput, agentSessionId: id })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it.each(["relative/path", "./x", "", "-flag"])("refuses a folder or archive that isn't an absolute path (%j)", async (bad) => {
    expect(await adapterWith().exportSession({ ...exportInput, archivePath: bad })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapterWith().importSession({ ...importInput, workspaceDir: bad })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapterWith().importSession({ ...importInput, agentDir: bad })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("answers unsupported for a version whose archive ostra hasn't run, and passes a refused binary through", async () => {
    expect(await adapterWith("2.9.0").exportSession(exportInput)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await adapterWith("2.9.0").importSession(importInput)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const refusing = new OpenCodeAdapter({
      resolveBinary: (): Promise<AdapterResult<OpenCodeBinary>> =>
        Promise.resolve({ ok: false, error: { code: "conflict", message: "the binary does not match" } }),
    });
    expect(await refusing.exportSession(exportInput)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await refusing.importSession(importInput)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("OpenCode's archive format", () => {
  const archive = JSON.stringify({
    info: { id: "ses_abc", projectID: "global", location: { directory: "C:\\old\\box\\workspace" }, somethingNew: true },
    messages: [
      { id: "m1", type: "user", text: "hello" },
      { id: "m2", type: "assistant" },
      { id: "m3", type: "idle", extra: [1] },
    ],
  });

  it("reads the session ID and the counts, tolerating fields it doesn't know", () => {
    expect(summarizeArchive(archive)).toEqual({
      agentSessionId: "ses_abc",
      bytes: Buffer.byteLength(archive, "utf8"),
      messages: 3,
      types: { user: 1, assistant: 1, idle: 1 },
    });
  });

  it("refuses text that isn't an archive", () => {
    expect(() => summarizeArchive("{}")).toThrow();
    expect(() => summarizeArchive("not json")).toThrow();
  });

  it("reads the ID an import printed, and nothing from the 'already exists' answer", () => {
    expect(importedSessionId("Imported session: ses_abc\r\n")).toBe("ses_abc");
    expect(importedSessionId("")).toBeUndefined();
    expect(importedSessionId("Session already exists\r\n")).toBeUndefined();
  });
});
