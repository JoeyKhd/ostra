import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attackConfigSchema, configFromEnv, runChecklist } from "../src/attack/checklist.ts";

const MARKER = "OSTRA-MODEL-SECRET-test0123abcd";

describe("attack checklist config", () => {
  it("rejects unknown fields (ostra owns the format)", () => {
    expect(() => attackConfigSchema.parse({ roots: [], extra: 1 })).toThrow();
  });
  it("has no default roots: no home, cwd or /etc scan", () => {
    expect(attackConfigSchema.parse({}).roots).toEqual([]);
  });
  it("never takes markers from the environment", () => {
    const config = configFromEnv({ OSTRA_ATTACK_MODEL_MARKER: MARKER, OSTRA_ATTACK_ROOTS: "/task" });
    expect(config.modelMarker).toBeUndefined();
    expect(config.roots).toEqual(["/task"]);
  });
});

describe("attack checklist: files and env", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ostra-attack-test-"));
    await mkdir(path.join(root, "clean"), { recursive: true });
    await mkdir(path.join(root, "leaky", "deep"), { recursive: true });
    await writeFile(path.join(root, "clean", "a.txt"), "nothing here\n");
    await writeFile(path.join(root, "leaky", "deep", "key.txt"), `key=${MARKER}\n`);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = { modelMarker: MARKER, gitMarker: "OSTRA-GIT-SECRET-test0123abcd", skipEgress: true };

  it("skips the file scan when given no roots", async () => {
    const report = await runChecklist(attackConfigSchema.parse(base));
    expect(report.results.find((r) => r.id === "files")?.outcome).toBe("SKIPPED");
  });
  it("finds a marker in a file under its roots (EXPOSED), and clears a clean root", async () => {
    const leaky = await runChecklist(attackConfigSchema.parse({ ...base, roots: [path.join(root, "leaky")] }));
    expect(leaky.results.find((r) => r.id === "files")?.outcome).toBe("EXPOSED");
    const clean = await runChecklist(attackConfigSchema.parse({ ...base, roots: [path.join(root, "clean")] }));
    expect(clean.results.find((r) => r.id === "files")?.outcome).toBe("BLOCKED");
  });
  it("finds a marker planted in its own environment (the negative control's mechanism)", async () => {
    process.env["OSTRA_MODEL_KEY"] = MARKER;
    try {
      const report = await runChecklist(attackConfigSchema.parse(base));
      expect(report.results.find((r) => r.id === "env")?.outcome).toBe("EXPOSED");
    } finally {
      Reflect.deleteProperty(process.env, "OSTRA_MODEL_KEY");
    }
    const clean = await runChecklist(attackConfigSchema.parse(base));
    expect(clean.results.find((r) => r.id === "env")?.outcome).toBe("BLOCKED");
  });
  it("SKIPPEDs the destination checks without an egress policy, and the db without an address", async () => {
    const report = await runChecklist(attackConfigSchema.parse(base));
    for (const id of ["metadata", "private", "other-box", "other-box-git"]) expect(report.results.find((r) => r.id === id)?.outcome).toBe("SKIPPED");
    expect(report.services.find((s) => s.id === "db")?.outcome).toBe("SKIPPED");
  });
});
