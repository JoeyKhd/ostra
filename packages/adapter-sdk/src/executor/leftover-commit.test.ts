import { repoIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { changeSummary, commitMessageFor, leftoverCommitMessage, nameStatusChanges, withoutLeftoverNote } from "./leftover-commit.ts";
import type { FileChange } from "./leftover-commit.ts";

const added = (path: string): FileChange => ({ kind: "add", path });
const updated = (path: string): FileChange => ({ kind: "update", path });

describe("ostra's leftover commit (F-078)", () => {
  it("F-078/c1: names what changed: one added file, several by name, more by count", () => {
    expect(changeSummary([added("ESSAY-lebanon.md")])).toBe("Add ESSAY-lebanon.md");
    expect(changeSummary([updated("src/history.ts"), updated("src/calculator.ts")])).toBe("Update calculator.ts and history.ts");
    expect(changeSummary([added("docs/notes.md"), updated("src/app.ts"), { kind: "delete", path: "old.txt" }])).toBe("Add notes.md, update app.ts, delete old.txt");
    expect(changeSummary([added("a.ts"), updated("b.ts"), updated("c.ts"), updated("d.ts")])).toBe("Add 1 file, update 3");
    expect(changeSummary(Array.from({ length: 12 }, (_, index) => updated(`src/file-${String(index)}.ts`)))).toBe("Update 12 files");
    expect(changeSummary([{ kind: "rename", from: "src/old-name.ts", path: "src/new-name.ts" }])).toBe("Rename old-name.ts to new-name.ts");
    // Two files of one name are told apart by their paths; names too long for a subject are counted.
    expect(changeSummary([updated("web/index.ts"), updated("api/index.ts")])).toBe("Update api/index.ts and web/index.ts");
    expect(changeSummary([updated(`${"a".repeat(40)}.ts`), updated(`${"b".repeat(40)}.ts`)])).toBe("Update 2 files");
    // A file name can't break the subject line.
    expect(changeSummary([added("evil\nname\u0007.md")])).toBe("Add evil name.md");
    // The same files in any order: the same summary.
    expect(changeSummary([updated("b.ts"), added("a.ts")])).toBe(changeSummary([added("a.ts"), updated("b.ts")]));
  });

  it("F-078/c1: keeps the ending's note, and takes the agent's PR title as the subject with the files in the body", () => {
    expect(leftoverCommitMessage({ changes: [added("ESSAY-lebanon.md")], title: null, note: null })).toBe("Add ESSAY-lebanon.md");
    expect(leftoverCommitMessage({ changes: [added("ESSAY-lebanon.md")], title: null, note: "stopped" })).toBe("Add ESSAY-lebanon.md (stopped: unfinished work)");
    expect(leftoverCommitMessage({ changes: [added("a.ts")], title: null, note: "crashed" })).toBe("Add a.ts (crashed: unfinished work)");
    expect(leftoverCommitMessage({ changes: [added("a.ts")], title: null, note: "spend-cap" })).toBe("Add a.ts (spend cap reached: unfinished work)");
    expect(leftoverCommitMessage({ changes: [added("ESSAY-lebanon.md")], title: "Add an essay about Lebanon", note: null })).toBe("Add an essay about Lebanon\n\nAdd ESSAY-lebanon.md");
    expect(leftoverCommitMessage({ changes: [updated("a.ts")], title: "Round half up", note: "stopped" })).toBe("Round half up (stopped: unfinished work)\n\nUpdate a.ts");
    // A title that says nothing once it's one line leaves the summary as the subject.
    expect(leftoverCommitMessage({ changes: [updated("a.ts")], title: "\u0007\n", note: null })).toBe("Update a.ts");
    expect(withoutLeftoverNote("Add a.ts (stopped: unfinished work)")).toBe("Add a.ts");
    expect(withoutLeftoverNote("Add a.ts (spend cap reached: unfinished work)")).toBe("Add a.ts");
    expect(withoutLeftoverNote("Add a.ts (in progress)")).toBe("Add a.ts (in progress)");
  });

  it("F-078/c1: reads git's staged changes, and makes each repo's message from its own", () => {
    const output = ["A", "ESSAY-lebanon.md", "M", "src/app.ts", "D", "old.txt", "R087", "src/a.ts", "src/b.ts", "C100", "x.ts", "y.ts", "T", "link", ""].join("\0");
    expect(nameStatusChanges(output)).toEqual([
      added("ESSAY-lebanon.md"),
      updated("src/app.ts"),
      { kind: "delete", path: "old.txt" },
      { kind: "rename", from: "src/a.ts", path: "src/b.ts" },
      added("y.ts"),
      updated("link"),
    ]);
    expect(nameStatusChanges("")).toEqual([]);
    const app = repoIdSchema.parse("repo-app");
    const api = repoIdSchema.parse("repo-api");
    const leftover = { kind: "leftover", titles: [{ repoId: app, title: "Add a history panel" }], note: null } as const;
    expect(commitMessageFor(leftover, app, [added("history.tsx")])).toBe("Add a history panel\n\nAdd history.tsx");
    expect(commitMessageFor(leftover, api, [updated("routes.ts")])).toBe("Update routes.ts");
    expect(commitMessageFor("A fixed message", app, [added("history.tsx")])).toBe("A fixed message");
  });
});
