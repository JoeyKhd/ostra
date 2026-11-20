// Writes a feature's proof file, `context/proof/F-nnn.md`, from its "done when" in
// `context/features.md` (`context/proof/README.md`).
//
// - A new file gets one row per condition, each with its key (`c1`, `c2` ...) and `missing`.
// - An existing file keeps its rows and their keys, in the order of the "done when", and gains a
//   `missing` row for each condition it lacks, under a key no row had. A row whose condition is no
//   longer a sentence of the "done when" stays at the end, for you to move its proof to the new
//   wording (give the new row the old key, if it is the same condition reworded) and delete it.
//
// Then it writes the Tests and Status cells from the tests, as `pnpm proof:sync` does.
//
// Run with `pnpm proof:new F-024 [F-025 ...]`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseFeatures,
  parseProofFile,
  renderProofFile,
  syncProofs,
  updateProofFile,
} from "./check-proof.ts";
import type { Feature } from "./check-proof.ts";

export type ProofFileChange =
  | { kind: "created"; file: string; conditions: number }
  | { kind: "updated"; file: string; added: number; stale: number }
  | { kind: "unchanged"; file: string };

/** Writes or updates the proof file of one feature, and says what it did. */
export const writeProofFile = async (
  root: string,
  feature: Feature,
  proofDir = "context/proof",
): Promise<ProofFileChange> => {
  const file = path.posix.join(proofDir, `${feature.id}.md`);
  const absolute = path.resolve(root, file);
  const existing = await readFile(absolute, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, renderProofFile(feature));
    return { kind: "created", file, conditions: feature.conditions.length };
  }
  const parsed = parseProofFile(existing);
  if (!parsed.ok) throw new Error(`${file} can't be read: ${parsed.reason}`);
  const next = updateProofFile(existing, feature);
  if (next === existing) return { kind: "unchanged", file };
  const conditions = new Set(parsed.rows.map((row) => row.condition));
  await writeFile(absolute, next);
  return {
    kind: "updated",
    file,
    added: feature.conditions.filter((condition) => !conditions.has(condition)).length,
    stale: parsed.rows.filter((row) => !feature.conditions.includes(row.condition)).length,
  };
};

const describeChange = (change: ProofFileChange): string => {
  switch (change.kind) {
    case "created":
      return `proof:new: wrote ${change.file}, ${String(change.conditions)} conditions, all missing`;
    case "updated":
      return `proof:new: updated ${change.file}: ${String(change.added)} new condition(s) added as missing, ${String(change.stale)} stale row(s) left at the end to resolve`;
    case "unchanged":
      return `proof:new: ${change.file} already matches the "done when"`;
    default:
      return change satisfies never;
  }
};

const main = async (): Promise<void> => {
  const root = path.resolve(import.meta.dirname, "..");
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("usage: pnpm proof:new F-024 [F-025 ...]");
    process.exitCode = 1;
    return;
  }
  const features = parseFeatures(await readFile(path.join(root, "context", "features.md"), "utf8"));
  const found: string[] = [];
  for (const id of ids) {
    const feature = features.find((candidate) => candidate.id === id);
    if (feature === undefined) {
      console.error(`proof:new: ${id} is not a feature row of context/features.md`);
      process.exitCode = 1;
      continue;
    }
    console.log(describeChange(await writeProofFile(root, feature)));
    found.push(id);
  }
  for (const file of await syncProofs({ root, ids: found })) {
    console.log(`proof:new: wrote the tests and statuses of ${file}`);
  }
};

if (import.meta.main) {
  await main();
}
