import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { notificationKindOfReason } from "./use-cases/needs-you-items.ts";

// Ticket 20 (F-036, ADR 0011): every creation, answer and dismissal of a needs-you item enqueues
// `notify.fanout` in the same transaction. The one way to make that true of every code path,
// milestone 1's, 2's, 3's and the ones later tickets add, is that no code writes the table except
// the helpers that enqueue. This test reads every source file of the repo and lists the places that
// write a `NeedsYouItem`: it fails for a write anywhere else, and for a helper called from a file
// this list doesn't know, so a new writer is a decision, not an accident.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const skipDirs = new Set(["node_modules", "generated", "dist", ".next", ".turbo", "coverage", "test-results", ".git", "spikes", "context"]);

const sourceFiles = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        found.push(...(await sourceFiles(path.join(dir, entry.name))));
      }
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
};

/** A write through Prisma, or in SQL, on the needs-you table. */
const WRITE = /needsYouItem\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?needs_you_item"?/i;

/** The helpers that write and enqueue. */
const HELPERS = /\b(createNeedsYouItemInTx|resolveNeedsYouItemsInTx|setNeedsYouSummaryInTx)\b/;

/** Reading every source file of the repo takes longer than 5 s on a slow disk (Windows, a loaded machine). */
const SCAN_TIMEOUT_MS = 60_000;

const rel = (file: string): string => path.relative(root, file).split(path.sep).join("/");

describe("every write of a needs-you item enqueues its fan-out", () => {
  it("F-036: no code writes the needs-you table except the helpers that enqueue the fan-out", async () => {
    const files = [...(await sourceFiles(path.join(root, "apps"))), ...(await sourceFiles(path.join(root, "packages"))), ...(await sourceFiles(path.join(root, "e2e")))];
    const writers: string[] = [];
    for (const file of files) {
      if (WRITE.test(await readFile(file, "utf8"))) {
        writers.push(rel(file));
      }
    }
    // The helpers' own file, and the browser suite's seed, which makes a task in a state and needs no notification.
    expect(writers.sort()).toEqual(["apps/web/e2e/seed-task.ts", "packages/domain/src/use-cases/needs-you-items.ts"]);
  }, SCAN_TIMEOUT_MS);

  it("F-036: the helpers are called from the places that create, answer and dismiss items, and from nowhere new unnoticed", async () => {
    const files = [...(await sourceFiles(path.join(root, "apps"))), ...(await sourceFiles(path.join(root, "packages")))];
    const callers: string[] = [];
    for (const file of files) {
      if (rel(file) !== "packages/domain/src/use-cases/needs-you-items.ts" && HELPERS.test(await readFile(file, "utf8"))) {
        callers.push(rel(file));
      }
    }
    // Milestone 1's, 2's and 3's writers. A later ticket that raises or closes an item adds its file here.
    const known = [
      "apps/core/src/ingest/ingest.ts",
      "packages/api/src/routers/tasks.ts",
      "packages/domain/src/use-cases/approvals.ts",
      // Ticket 24: a ticket closed while its task runs, and "Keep working".
      "packages/domain/src/use-cases/after-merge.ts",
      "packages/domain/src/use-cases/ingest-events.ts",
      "packages/domain/src/use-cases/plans-questions.ts",
      "packages/domain/src/use-cases/record-session-end.ts",
      "packages/domain/src/use-cases/reopen.ts",
      "packages/domain/src/use-cases/sessions-m2.ts",
      // Milestone 4's ticket 48: no provider on the project's list serves the model (F-135).
      "packages/domain/src/providers/session-model.ts",
    ];
    const unknown = callers.filter((caller) => !known.includes(caller));
    expect(unknown).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("F-036: a reason notifies the moment of its name, a ready draft PR is pr_ready, and the reasons with no moment of their own notify nobody", () => {
    expect(notificationKindOfReason("draft_ready")).toBe("pr_ready");
    expect(notificationKindOfReason("approval")).toBe("approval");
    expect(notificationKindOfReason("spend_cap")).toBe("spend_cap");
    for (const silent of ["round_cap", "waiting_for_reviewer", "environment_proposal", "restore_conflict", "unstorable_event", "files_outside_repos"] as const) {
      expect(notificationKindOfReason(silent)).toBeNull();
    }
  });
});
