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

const skipDirs = new Set(["node_modules", "generated", "dist", ".next", ".next-pseudo", ".turbo", "coverage", "test-results", ".git", "spikes", "context"]);

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
const HELPERS = /\b(createNeedsYouItemInTx|resolveNeedsYouItemsInTx|setNeedsYouSummaryInTx|handDriverItemsToProjectInTx|closeItemsOfEndedTaskInTx|answerNextTurnItemsInTx|closeStaleNeedsYouItems)\b/;

/** Reading every source file of the repo takes longer than 5 s on a slow disk (Windows, a loaded machine). */
const SCAN_TIMEOUT_MS = 60_000;

const rel = (file: string): string => path.relative(root, file).split(path.sep).join("/");

describe("every write of a needs-you item enqueues its fan-out", () => {
  it("F-036/c1: no code writes the needs-you table except the helpers that enqueue the fan-out", async () => {
    const files = [...(await sourceFiles(path.join(root, "apps"))), ...(await sourceFiles(path.join(root, "packages"))), ...(await sourceFiles(path.join(root, "e2e")))];
    const writers: string[] = [];
    for (const file of files) {
      if (WRITE.test(await readFile(file, "utf8"))) {
        writers.push(rel(file));
      }
    }
    // The helpers' own file, the browser suite's seeds, which make a task in a state and need no
    // notification (milestone 4's keys world, ticket 53, seeds a no-key item the same way; milestone
    // 7's keyboard specs, ticket 13, and its route sweep, ticket 19, seed the items they show; milestone
    // 6's refine draft, ticket 34, seeds its draft_ready item, and its review screens, ticket 35, their
    // reviewer's and round cap's items, and its agent mode and approval screens, ticket 33, an outside
    // task's awaiting_approval item; milestone 3's Needs you, ticket 44, its approvals with the
    // member's notification, as fan-out writes them; milestone 3's task page answers, ticket 43, the
    // approval and plan it answers; milestone 8's app world, the kept process's proposal), and the isolation
    // suite's fixture rows (milestone 4, ticket 09), which notify no one.
    expect(writers.sort()).toEqual([
      "apps/web/e2e/seed-answers.ts",
      "apps/web/e2e/seed-app-world.ts",
      "apps/web/e2e/seed-keys-world.ts",
      "apps/web/e2e/seed-keys.ts",
      "apps/web/e2e/seed-m6.ts",
      "apps/web/e2e/seed-needs-you-world.ts",
      "apps/web/e2e/seed-refine-world.ts",
      "apps/web/e2e/seed-review-world.ts",
      "apps/web/e2e/seed-routes-world.ts",
      "apps/web/e2e/seed-task.ts",
      // Milestone 10's ticket 09 (F-151): the compact thread's scenes seed the question each one shows.
      "apps/web/e2e/seed-thread-world.ts",
      "packages/db/src/testing/isolation-models.ts",
      "packages/domain/src/use-cases/needs-you-items.ts",
    ]);
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
      // Milestone 4's ticket 23: a removed member's driven tasks hand their driver's items to the project (F-002).
      "packages/domain/src/use-cases/members.ts",
      // An item never outlives its reason: a move that ends the task, a stop, a message that starts
      // the next turn, and core's clean-up of items older releases left open on ended tasks.
      "packages/domain/src/use-cases/moves.ts",
      "packages/domain/src/use-cases/stop-task.ts",
      "packages/domain/src/use-cases/member-message.ts",
      "packages/domain/src/providers/turn-start.ts",
      "apps/core/src/cleanup/cleanup.ts",
      "apps/core/src/core.ts",
      // Milestone 6's ticket 14 (F-040): an outside task's approval item, and its answer.
      "apps/core/src/starts/outside.ts",
      "packages/domain/src/use-cases/outside-tasks.ts",
      // Ticket 13 (F-012): a stop from Linear closes the stopped task's items, as the panel's stop does.
      "apps/core/src/linear/agent-mode/events.ts",
      // Milestone 6's ticket 18 (F-101): a round's cap, and the spend cap it stops at, for the driver.
      "packages/domain/src/review-loop/start-round.ts",
      // Milestone 6's ticket 11: a start that waits for approval (a rule's "wait for approval", F-040's path).
      "packages/domain/src/starts/start-task-body.ts",
      // Ticket 15 (F-099): a refine draft's item, and its answer.
      "packages/domain/src/use-cases/refine-drafts.ts",
      // Milestone 6's ticket 19 (F-102): a reviewer's review answers the item once every matched reviewer reviewed.
      "packages/domain/src/review-loop/reviewers.ts",
      // Milestone 6's ticket 21 (F-113): an environment proposal's item for the project's admins, and its answer.
      "packages/domain/src/onboarding/onboarding.ts",
      // Milestone 8's ticket 15 (F-140): "Keep it"'s environment proposal, the same item for the project's admins.
      "packages/domain/src/previews/environment-app.ts",
      // F-099/F-100 (f541b67f, b8beac70): a review or refine task whose session ended owing its hand-in stalls, with its item.
      "packages/domain/src/use-cases/hand-in-rests.ts",
    ];
    const unknown = callers.filter((caller) => !known.includes(caller));
    expect(unknown).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("F-036: a reason notifies the moment of its name, a ready draft PR is pr_ready, and the reasons with no moment of their own notify nobody", () => {
    expect(notificationKindOfReason("draft_ready")).toBe("pr_ready");
    // Milestone 6: a refine task's draft and an outside task's approval are moments of their own.
    expect(notificationKindOfReason("draft_ready", "refine")).toBe("draft_ready");
    expect(notificationKindOfReason("awaiting_approval")).toBe("task_approval");
    expect(notificationKindOfReason("approval")).toBe("approval");
    expect(notificationKindOfReason("spend_cap")).toBe("spend_cap");
    // Milestone 6 (F-102): a task waiting for a reviewer is its reviewers' moment.
    expect(notificationKindOfReason("waiting_for_reviewer")).toBe("review_requested");
    for (const silent of ["round_cap", "environment_proposal", "restore_conflict", "unstorable_event", "files_outside_repos"] as const) {
      expect(notificationKindOfReason(silent)).toBeNull();
    }
  });
});
