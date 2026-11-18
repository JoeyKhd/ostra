import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { redactTokens } from "@ostra/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { announceSetupToken, generateSetupToken, loadServerSecrets } from "./server-secrets.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-secrets-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("the secrets a fresh install generates (self-hosting: no setting needed)", () => {
  it("generates both on first start and keeps them for the next", async () => {
    const first = await loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null });
    expect(first.betterAuthSecret.length).toBeGreaterThanOrEqual(32);
    expect(first.setupToken).toMatch(/^ostra-setup-[0-9a-f]{48}$/);
    const second = await loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null });
    expect(second).toEqual(first);
    expect((await readFile(path.join(dataDir, "setup-token"), "utf8")).trim()).toBe(first.setupToken);
  });

  it("keeps them private to the owner where the platform has file modes", async () => {
    await loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null });
    if (process.platform !== "win32") {
      expect((await stat(path.join(dataDir, "setup-token"))).mode & 0o077).toBe(0);
    }
  });

  it("lets a setting win over the kept value, and writes nothing for it", async () => {
    const secrets = await loadServerSecrets({
      dataDir,
      betterAuthSecret: "b".repeat(40),
      setupToken: "my-own-setup-token-123",
    });
    expect(secrets).toEqual({ betterAuthSecret: "b".repeat(40), setupToken: "my-own-setup-token-123" });
    await expect(stat(path.join(dataDir, "setup-token"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads a value an operator put in the folder", async () => {
    await writeFile(path.join(dataDir, "setup-token"), "ostra-setup-chosen-by-the-operator\n");
    const secrets = await loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null });
    expect(secrets.setupToken).toBe("ostra-setup-chosen-by-the-operator");
  });

  it("agrees between two processes starting at once", async () => {
    const [a, b] = await Promise.all([
      loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null }),
      loadServerSecrets({ dataDir, betterAuthSecret: null, setupToken: null }),
    ]);
    expect(a).toEqual(b);
  });
});

describe("the setup line", () => {
  it("prints the token once with the panel's address, through its own writer", () => {
    const written: string[] = [];
    const token = generateSetupToken();
    announceSetupToken((text) => written.push(text), { panelUrl: "http://localhost:3000", setupToken: token });
    expect(written.join("")).toContain(token);
    expect(written.join("")).toContain("http://localhost:3000");
  });

  it("is the only way the token gets out: the structured logger redacts it", () => {
    const token = generateSetupToken();
    expect(redactTokens(`setup token ${token}`)).not.toContain(token);
  });
});
