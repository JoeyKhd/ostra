import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { holdsSecret, pemLines, scanFolder, textHoldsSecret } from "./scan.ts";

const TOKEN = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";
const KEY_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";

describe("pemLines", () => {
  it("keeps the base64 lines, not the armor or a short last line", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\r\n${KEY_LINE}\r\nshort==\r\n-----END PRIVATE KEY-----\r\n`;
    expect(pemLines(pem)).toEqual([KEY_LINE]);
  });
});

describe("holdsSecret", () => {
  it("finds a needle in bytes, and a GitHub token by its pattern", () => {
    expect(holdsSecret(Buffer.from(`a ${TOKEN} b`), [TOKEN])).toBe(true);
    expect(holdsSecret(Buffer.from("nothing here"), [TOKEN])).toBe(false);
    expect(textHoldsSecret(`token ghs_${"A".repeat(36)}`, [])).toBe(true);
    expect(textHoldsSecret("ghs_short", [])).toBe(false);
  });
});

describe("scanFolder", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ostra-e2e-scan-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a secret in a nested file and a key line in a binary file, and names them by path only", async () => {
    await mkdir(path.join(root, "agent", "xdg", "data"), { recursive: true });
    await writeFile(path.join(root, "agent", "xdg", "data", "opencode.db"), Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(KEY_LINE), Buffer.from([0, 9])]));
    await writeFile(path.join(root, "agent", "clean.txt"), "nothing");
    await writeFile(path.join(root, "notes.txt"), `the model token is ${TOKEN}`);
    const scan = await scanFolder(root, [TOKEN, KEY_LINE]);
    expect(scan.exists).toBe(true);
    expect(scan.files).toBe(3);
    expect([...scan.holding].sort()).toEqual(["agent/xdg/data/opencode.db", "notes.txt"]);
    expect(scan.unreadable).toBe(0);
  });

  it("finds a GitHub token by its pattern", async () => {
    await writeFile(path.join(root, "log.txt"), `remote https://x-access-token:ghs_${"B".repeat(36)}@github.com/o/r`);
    expect((await scanFolder(root, [])).holding).toEqual(["log.txt"]);
  });

  it("does not search git's compressed objects", async () => {
    await mkdir(path.join(root, "workspace", "repo", ".git", "objects"), { recursive: true });
    await writeFile(path.join(root, "workspace", "repo", ".git", "objects", "ab"), TOKEN);
    await writeFile(path.join(root, "workspace", "repo", ".git", "config"), "[remote]");
    const scan = await scanFolder(root, [TOKEN]);
    expect(scan.holding).toEqual([]);
    expect(scan.files).toBe(1);
  });

  it("does search git's config, where a remote's credential would be", async () => {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), `url = https://${TOKEN}@github.com/o/r`);
    expect((await scanFolder(root, [TOKEN])).holding).toEqual([".git/config"]);
  });

  it("reports a folder that isn't there", async () => {
    expect((await scanFolder(path.join(root, "missing"), [TOKEN])).exists).toBe(false);
  });
});
