import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Milestone 4, ticket 10 (F-073, ADR 0054): the audit log is append-only, and every write goes
// through the one port. This reads every TypeScript file of the repo, tests included, and fails on
// any Prisma call that changes or removes an `AuditEntry`, or any SQL that does, anywhere outside
// `packages/db/prisma/migrations/`; and on an `AuditEntry` created anywhere but `recordAudit` and
// the tests that seed one.

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const skipped = new Set(["node_modules", ".git", "generated", "dist", ".next", ".turbo", ".ostra-dev", "coverage", "spikes"]);
const migrations = path.join(repoRoot, "packages", "db", "prisma", "migrations");
const thisFile = path.resolve(import.meta.filename);

const sourceFiles = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name) && full !== migrations) {
        found.push(...(await sourceFiles(full)));
      }
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && full !== thisFile) {
      found.push(full);
    }
  }
  return found;
};

// Built from parts, so the patterns don't match the line that defines them.
const model = ["audit", "Entry"].join("");
const table = ["audit", "_entry"].join("");
const changes = new RegExp(String.raw`\b${model}\s*\.\s*(update|updateMany|updateManyAndReturn|delete|deleteMany|upsert)\b`);
const changesInSql = new RegExp(String.raw`\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+("?public"?\.)?"?${table}"?`, "i");
const creates = new RegExp(String.raw`\b${model}\s*\.\s*(create|createMany|createManyAndReturn)\b`);

const hitsOf = async (pattern: RegExp, keep: (file: string) => boolean): Promise<string[]> => {
  const hits: string[] = [];
  for (const file of await sourceFiles(repoRoot)) {
    if (!keep(file)) {
      continue;
    }
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${path.relative(repoRoot, file)}:${String(index + 1)}`);
      }
    });
  }
  return hits;
};

describe("the audit log is append-only (F-073)", () => {
  it("F-073: no code, tests included, updates, upserts or deletes an audit entry, outside the migrations", async () => {
    expect(await hitsOf(changes, () => true)).toEqual([]);
    expect(await hitsOf(changesInSql, () => true)).toEqual([]);
  });

  it("F-073: every audit write goes through recordAudit: no other source file creates an entry", async () => {
    const port = path.join(repoRoot, "packages", "domain", "src", "audit", "record-audit.ts");
    const hits = await hitsOf(creates, (file) => file !== port && !/\.test\.tsx?$/.test(file));
    expect(hits).toEqual([]);
    // The port itself is found, so the scan reads the files it should.
    expect(await hitsOf(creates, (file) => file === port)).toHaveLength(1);
  });
});
