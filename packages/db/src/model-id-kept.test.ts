import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Prisma } from "./generated/prisma/client.ts";

// F-135 (ADR 0065, Q270 to Q278): a profile names its model by name now, and `AgentProfile.modelId`
// is still written beside it so a rollback to the previous release reads the same profile. Its
// drop is a later release's, as AGENTS.md wants of every migration: add first, drop later. Read from
// the migrations an install runs, so a migration of this release that drops it fails here.

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");

describe("AgentProfile.modelId stays until a later release", () => {
  it("F-135: no migration drops agent_profile's modelId, and the profile still has the column", async () => {
    const folders = (await readdir(migrationsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(folders.length).toBeGreaterThan(0);
    const dropping: string[] = [];
    for (const folder of folders) {
      const sql = await readFile(path.join(migrationsDir, folder, "migration.sql"), "utf8");
      // Each statement of the migration, on one line, so a DROP split over lines is still seen.
      for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map((part) => part.replace(/\s+/g, " ").trim())) {
        if (/ALTER TABLE "?agent_profile"? .*DROP (COLUMN )?(IF EXISTS )?"?modelId"?/i.test(statement)) {
          dropping.push(folder);
        }
        if (/DROP TABLE "?agent_profile"?/i.test(statement)) {
          dropping.push(folder);
        }
      }
    }
    expect(dropping).toEqual([]);
    expect(Object.keys(Prisma.AgentProfileScalarFieldEnum)).toContain("modelId");
  });
});
