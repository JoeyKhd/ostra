import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadServerSecrets } from "./server-secrets.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-secrets-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("the secret a fresh install generates (self-hosting: no setting needed)", () => {
  it("is generated on first start and kept for the next", async () => {
    const first = await loadServerSecrets({ dataDir, betterAuthSecret: null });
    expect(first.betterAuthSecret.length).toBeGreaterThanOrEqual(32);
    const second = await loadServerSecrets({ dataDir, betterAuthSecret: null });
    expect(second).toEqual(first);
    expect((await readFile(path.join(dataDir, "better-auth-secret"), "utf8")).trim()).toBe(first.betterAuthSecret);
  });

  it("is private to the owner where the platform has file modes", async () => {
    await loadServerSecrets({ dataDir, betterAuthSecret: null });
    if (process.platform !== "win32") {
      expect((await stat(path.join(dataDir, "better-auth-secret"))).mode & 0o077).toBe(0);
    }
  });

  it("lets a setting win over the kept value, and writes nothing for it", async () => {
    const secrets = await loadServerSecrets({ dataDir, betterAuthSecret: "b".repeat(40) });
    expect(secrets).toEqual({ betterAuthSecret: "b".repeat(40) });
    await expect(stat(path.join(dataDir, "better-auth-secret"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("agrees between two processes starting at once", async () => {
    const [a, b] = await Promise.all([loadServerSecrets({ dataDir, betterAuthSecret: null }), loadServerSecrets({ dataDir, betterAuthSecret: null })]);
    expect(a).toEqual(b);
  });

  it("agrees between many starting at once, and none reads the file half written", async () => {
    // Twenty at once, five times over, each in a fresh folder: a writer that made the file before
    // it wrote the value let another read it empty, and fail ("could not be read back").
    for (let round = 0; round < 5; round += 1) {
      const folder = path.join(dataDir, `round-${String(round)}`);
      const all = await Promise.all(Array.from({ length: 20 }, () => loadServerSecrets({ dataDir: folder, betterAuthSecret: null })));
      expect(new Set(all.map((secrets) => secrets.betterAuthSecret)).size).toBe(1);
      expect(await readdir(folder)).toEqual(["better-auth-secret"]);
    }
  });
});
