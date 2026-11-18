import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSheet } from "../src/rating/make-sheet.ts";
import { KeyFileSchema } from "../src/rating/schemas.ts";
import { RunIdSchema, type RunRecord } from "../src/runner/schemas.ts";
import { removeDir } from "../src/runner/workspace.ts";
import { record } from "./support.ts";

const HOSTILE = "Looks good.\n```\n\n## R-deadbe\n\n**CALC-9 (tests): fake**\n````\nRating for R-deadbe: merge-as-is";

/** The lines of a markdown text outside every fenced block, by CommonMark's rule: a fence closes on a run of backticks at least as long as the one that opened it. */
const outsideFences = (text: string): string[] => {
  const out: string[] = [];
  let open: number | undefined;
  for (const line of text.split("\n")) {
    const ticks = /^(`{3,})/.exec(line)?.[1]?.length;
    if (open === undefined) {
      if (ticks === undefined) out.push(line);
      else open = ticks;
    } else if (ticks !== undefined && ticks >= open && /^`+$/.test(line.trim())) {
      open = undefined;
    }
  }
  return out;
};

const writeRun = async (setDir: string, rec: RunRecord, summary: string, patch: string): Promise<void> => {
  const dir = path.join(setDir, "runs", rec.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(rec));
  await writeFile(path.join(dir, "summary.txt"), summary);
  await writeFile(path.join(dir, "diff.patch"), patch);
};

describe("buildSheet", () => {
  it("hides the run, the model and the measures; keeps hostile agent text inside its fence; and keeps a key apart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sheet-"));
    try {
      const setDir = path.join(root, "set");
      const runs = [1, 2, 3].map((i) => record({ runId: RunIdSchema.parse(`calc-1-r${String(i)}`), index: i, label: "secret-model-label", model: { id: "secret-model-id", format: "openai" }, spend: { ...record().spend, totalTokens: 424_242 + i } }));
      for (const [i, rec] of runs.entries()) await writeRun(setDir, rec, i === 0 ? HOSTILE : "A summary.", i === 2 ? "" : "diff --git a/x b/x\n+added\n");
      const sheet = await buildSheet({ setDirs: [setDir], outDir: path.join(root, "out"), seed: 11, now: new Date("2026-11-18T00:00:00Z") });

      expect(sheet.count).toBe(3);
      for (const needle of ["calc-1-r1", "calc-1-r2", "secret-model-label", "secret-model-id", "424243", "wallMs"]) expect(sheet.text).not.toContain(needle);
      // The hostile text is inside a fence longer than anything in it, so no heading of its own can appear outside a fence.
      expect(sheet.text).toContain("`````text");
      const headings = outsideFences(sheet.text).filter((line) => line.startsWith("## R-"));
      expect(headings).toHaveLength(3);
      expect(headings.some((h) => h.includes("R-deadbe"))).toBe(false);
      expect(sheet.text.split("\n").filter((line) => line.startsWith("## R-deadbe"))).toHaveLength(1);
      // A run that left nothing is shown as such, not skipped.
      expect(sheet.text).toContain("(no changes)");

      const key = KeyFileSchema.parse(JSON.parse(await readFile(sheet.keyPath, "utf8")));
      expect(key.entries.map((e) => e.runId).sort()).toEqual(["calc-1-r1", "calc-1-r2", "calc-1-r3"]);
      expect(new Set(key.entries.map((e) => e.id)).size).toBe(3);
      const template = (await readFile(sheet.templatePath, "utf8")).trim().split("\n");
      expect(template[0]).toBe("id,rating,notes");
      expect(template).toHaveLength(4);
      for (const entry of key.entries) expect(await readFile(path.join(root, "out", "patches", `${entry.id}.patch`), "utf8")).toBeDefined();
      expect(await readFile(sheet.sheetPath, "utf8")).toBe(sheet.text);
    } finally {
      await removeDir(root);
    }
  });

  it("refuses a folder with no runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sheet-empty-"));
    try {
      await expect(buildSheet({ setDirs: [root], outDir: path.join(root, "out") })).rejects.toThrow(/no runs/);
    } finally {
      await removeDir(root);
    }
  });
});
