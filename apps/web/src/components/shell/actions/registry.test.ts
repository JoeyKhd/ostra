import { describe, expect, it } from "vitest";

import { approvalIdSchema, projectIdSchema, questionIdSchema, taskIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { paletteRows } from "./palette-actions";
import { actionWords, registry, sheetLines } from "./registry";
import type { PaletteAction } from "./registry";
import { scopeOf } from "./use-scope";
import type { TaskScope } from "./use-scope";

// F-081 (ticket 13): the panel's one registry, its words, the sheet drawn from it, and the palette's
// groups per page and role. The browser runs of each action are in `e2e/17-keys.spec.ts`.

const taskId = taskIdSchema.parse("01970000-0000-7000-8000-000000000001");
const task = (over: Partial<TaskScope> = {}): TaskScope => ({
  taskId,
  projectId: projectIdSchema.parse("01970000-0000-7000-8000-000000000002"),
  key: "CALC-174",
  title: "Fix the history view",
  canTakeOver: false,
  canStop: true,
  canReopen: false,
  canSend: true,
  item: null,
  focusComposer: () => undefined,
  ...over,
});
const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);

describe("the registry's words", () => {
  it("F-081/c1: every action's sheet words are the domain's message key, and every key is in en.json", () => {
    for (const entry of registry) {
      const words = actionWords[entry.id];
      expect(words.sheet).toBe(entry.messageKey);
      for (const key of [words.sheet, words.palette, words.keywords]) expect(t(key)).not.toBe(key);
    }
  });
});

describe("the ? sheet", () => {
  it("F-081/c1: has a line for every shortcut of the registry, by scope in its order, and no line without one", () => {
    const lines = sheetLines().flatMap((section) => section.lines.map((line) => ({ scope: section.scope, id: line.id, keys: line.shortcut.join(" ") })));
    const shortcuts = registry.flatMap((entry) => (entry.shortcut === null ? [] : [{ scope: entry.scope, id: entry.id, keys: entry.shortcut.join(" ") }]));
    expect(lines).toEqual([...shortcuts].sort((a, b) => ["global", "needs-you-item", "task"].indexOf(a.scope) - ["global", "needs-you-item", "task"].indexOf(b.scope)));
    expect(lines.map((line) => line.keys)).toEqual(["g n", "g h", "g t", "g p", "g o", "[", "/", "?", "c", "a", "d", "r", "t", "o", "s"]);
  });

  it("F-081/c1: an action added to the registry gets its line with no list of the sheet's own", () => {
    const added: PaletteAction = { id: "steer", messageKey: "palette.actions.steer", shortcut: ["m"], scope: "task", role: "member", effect: { kind: "call", procedure: "tasks.send" }, confirm: false };
    const lines = sheetLines([...registry.filter((entry) => entry.id !== "steer"), added]);
    expect(lines.find((section) => section.scope === "task")?.lines.map((line) => line.id)).toContain("steer");
  });
});

describe("the palette's groups", () => {
  it("F-081/c1: on a list page, the actions that pick their item come first, with what waits, hidden at none", () => {
    const groups = paletteRows({ role: "member", scope: scopeOf(null, null), shownTheme: "dark", waiting: { approvals: 3, questions: 0 }, query: "" });
    expect(ids(groups.page)).toEqual(["approve", "deny", "reopen"]);
    expect(groups.page[0]).toMatchObject({ label: "Approve…", hint: "3 waiting", shortcut: ["a"], step: true });
    expect(ids(groups.actions)).toEqual(["new-task", "toggle-theme"]);
    expect(ids(groups.goTo)).toEqual(["go-needs-you", "go-home", "go-tasks", "go-projects", "go-organization"]);
  });

  it("F-081/c1: an action the member's role can't take isn't listed: New project is an admin's", () => {
    const member = paletteRows({ role: "member", scope: scopeOf(null, null), shownTheme: "dark", waiting: null, query: "" });
    const admin = paletteRows({ role: "admin", scope: scopeOf(null, null), shownTheme: "dark", waiting: null, query: "" });
    expect(ids(member.actions)).not.toContain("new-project");
    expect(ids(admin.actions)).toContain("new-project");
  });

  it("F-081/c1: on a running task the driver gets Message the agent and Stop; another member Take over; a stopped one Reopen…", () => {
    expect(ids(paletteRows({ role: "member", scope: scopeOf(task(), null), shownTheme: "dark", waiting: null, query: "" }).page)).toEqual(["stop", "steer"]);
    expect(ids(paletteRows({ role: "member", scope: scopeOf(task({ canSend: false, canStop: false, canTakeOver: true }), null), shownTheme: "dark", waiting: null, query: "" }).page)).toEqual(["take-over"]);
    const stopped = paletteRows({ role: "member", scope: scopeOf(task({ canSend: false, canStop: false, canReopen: true }), null), shownTheme: "dark", waiting: null, query: "" });
    expect(stopped.page).toMatchObject([{ id: "reopen", label: "Reopen…", step: true }]);
  });

  it("F-081/c1: a task's open approval is approved and denied on the task, with no second step", () => {
    const item = { kind: "approval" as const, approvalId: approvalIdSchema.parse("a-1"), taskId, key: "CALC-174", deny: () => undefined };
    const groups = paletteRows({ role: "member", scope: scopeOf(task({ item }), null), shownTheme: "dark", waiting: null, query: "" });
    expect(groups.page.slice(0, 2)).toMatchObject([{ id: "approve", label: "Approve", step: false }, { id: "deny", label: "Deny", step: false }]);
    const question = { kind: "question" as const, questionId: questionIdSchema.parse("q-1"), taskId, key: "CALC-174", reply: () => undefined };
    expect(ids(paletteRows({ role: "member", scope: scopeOf(task({ item: question }), null), shownTheme: "dark", waiting: null, query: "" }).page)).toEqual(["answer", "stop", "steer"]);
  });

  it("F-081/c1: typing filters by the label and the action's other words, and the theme row names the other theme", () => {
    const groups = paletteRows({ role: "member", scope: scopeOf(null, null), shownTheme: "light", waiting: null, query: "allow" });
    expect(ids([...groups.page, ...groups.actions, ...groups.goTo])).toEqual(["approve"]);
    expect(paletteRows({ role: "member", scope: scopeOf(null, null), shownTheme: "light", waiting: null, query: "theme" }).actions).toMatchObject([{ label: "Switch to the dark theme" }]);
  });
});
