import { randomUUID } from "node:crypto";

import { organizationIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { auditActions } from "./audit/actions.ts";
import {
  actionForShortcut,
  isPaletteActionOffered,
  offeredPaletteActions,
  paletteActions,
  paletteProcedures,
  paletteScopes,
  registryProblems,
  shortcutClashes,
  shortcutText,
} from "./palette/actions.ts";
import type { PaletteAction, PaletteContext } from "./palette/actions.ts";
import { parseServerSettings } from "./settings.ts";
import { setupStepMarks, setupTimeline, setupTimelineSteps } from "./setup/timeline.ts";
import type { SetupAuditEntry } from "./setup/timeline.ts";
import { DEFAULT_THEME, dataThemeFor, parseSetThemeInput, themeFromCookie, themePreferences } from "./use-cases/theme.ts";

// Milestone 7's domain contracts (spec sections 4, 5.4 and 12, items 11 and 13; ticket 36).

const byId = (id: PaletteAction["id"]): PaletteAction => {
  const found = paletteActions.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no action ${id}`);
  }
  return found;
};

describe("the palette's actions and shortcuts (F-081)", () => {
  it("F-081/c1: holds every action of spec section 12, item 11, each with a scope, a role, a message key and what it calls", () => {
    expect(paletteActions.map((entry) => entry.id).sort()).toEqual(
      [
        "go-needs-you",
        "approve",
        "deny",
        "answer",
        "take-over",
        "reopen",
        "stop",
        "steer",
        "new-task",
        "new-project",
        "toggle-theme",
        "go-home",
        "go-tasks",
        "go-projects",
        "go-organization",
        "toggle-sidebar",
        "search",
        "shortcut-sheet",
        "toggle-side-pane",
        "expand-preview",
      ].sort(),
    );
    for (const entry of paletteActions) {
      expect(paletteScopes, entry.id).toContain(entry.scope);
      expect(["member", "admin"], entry.id).toContain(entry.role);
      expect(entry.messageKey, entry.id).toBe(`palette.actions.${entry.id}`);
      if (entry.effect.kind === "call") {
        expect(paletteProcedures, entry.id).toContain(entry.effect.procedure);
      }
    }
    expect(registryProblems(paletteActions)).toEqual([]);
  });

  it("F-081/c1: gives the spec's shortcuts, no two shared in one scope, and none with a modifier", () => {
    const shortcuts = Object.fromEntries(paletteActions.map((entry) => [entry.id, entry.shortcut === null ? null : shortcutText(entry.shortcut)]));
    expect(shortcuts).toEqual({
      "go-needs-you": "g n",
      "go-home": "g h",
      "go-tasks": "g t",
      "go-projects": "g p",
      "go-organization": "g o",
      "toggle-sidebar": "[",
      search: "/",
      "shortcut-sheet": "?",
      "new-task": "c",
      "new-project": null,
      "toggle-theme": null,
      approve: "a",
      deny: "d",
      answer: "r",
      "take-over": "t",
      reopen: "o",
      stop: "s",
      steer: null,
      "toggle-side-pane": "p",
      "expand-preview": "f",
    });
    expect(shortcutClashes(paletteActions)).toEqual([]);
    // Stop asks first; nothing else does.
    expect(paletteActions.filter((entry) => entry.confirm).map((entry) => entry.id)).toEqual(["stop"]);
  });

  it("F-081/c1: a duplicate shortcut fails the registry, in its scope and against a global one", () => {
    const sameScope: PaletteAction = { ...byId("reopen"), id: "steer", shortcut: ["t"] };
    expect(shortcutClashes([...paletteActions.filter((entry) => entry.id !== "steer"), sameScope])).toEqual([
      { scope: "task", actions: ["take-over", "steer"], keys: "t" },
    ]);
    // A global `c` is live on a task page too: a task action can't take it.
    const againstGlobal: PaletteAction = { ...byId("steer"), shortcut: ["c"] };
    expect(registryProblems([...paletteActions.filter((entry) => entry.id !== "steer"), againstGlobal])).toEqual([
      "new-task and steer share \"c\" in task",
    ]);
    // A single `g` would make every `g …` sequence untypeable.
    const prefix: PaletteAction = { ...byId("toggle-theme"), shortcut: ["g"] };
    expect(shortcutClashes([...paletteActions.filter((entry) => entry.id !== "toggle-theme"), prefix]).map((clash) => clash.keys)).toEqual(
      paletteScopes.flatMap(() => ["g", "g", "g", "g", "g"]),
    );
    // In another scope the same key is fine: `t` is take over on a task, and nothing on a needs-you item.
    const otherScope: PaletteAction = { ...byId("approve"), id: "steer", shortcut: ["t"] };
    expect(shortcutClashes([...paletteActions.filter((entry) => entry.id !== "steer"), otherScope])).toEqual([]);
  });

  it("F-081/c1: refuses a key with a modifier, a blank key and an action without its words", () => {
    const modifier: PaletteAction = { ...byId("steer"), shortcut: ["Ctrl+m"] };
    const blank: PaletteAction = { ...byId("toggle-theme"), shortcut: [" "] };
    const wordless: PaletteAction = { ...byId("new-project"), messageKey: "palette.actions." };
    expect(registryProblems([modifier, blank, wordless])).toEqual([
      "steer: the key \"Ctrl+m\" isn't one plain character",
      "toggle-theme: the key \" \" isn't one plain character",
      "new-project: no message key",
    ]);
    expect(registryProblems([byId("stop"), byId("stop")])).toContain("stop: listed twice");
  });

  it("F-081/c1: offers each action only where its scope is present and to the role it names, and a shortcut fires only what is offered", () => {
    const member: PaletteContext = { role: "member", scopes: ["global"] };
    const onTask: PaletteContext = { role: "member", scopes: ["global", "task"] };
    const onItem: PaletteContext = { role: "member", scopes: ["global", "needs-you-item"] };
    const admin: PaletteContext = { role: "admin", scopes: ["global"] };
    expect(isPaletteActionOffered(byId("new-project"), member)).toBe(false);
    expect(isPaletteActionOffered(byId("new-project"), admin)).toBe(true);
    expect(offeredPaletteActions(member).some((entry) => entry.scope !== "global")).toBe(false);
    expect(offeredPaletteActions(onTask).map((entry) => entry.id)).toEqual(expect.arrayContaining(["take-over", "reopen", "stop", "steer"]));
    expect(offeredPaletteActions(onTask).map((entry) => entry.id)).not.toContain("approve");
    expect(actionForShortcut(["t"], onTask)?.id).toBe("take-over");
    expect(actionForShortcut(["t"], member)).toBeNull();
    expect(actionForShortcut(["a"], onItem)?.id).toBe("approve");
    expect(actionForShortcut(["a"], onTask)).toBeNull();
    expect(actionForShortcut(["g", "t"], onTask)?.id).toBe("go-tasks");
    expect(actionForShortcut(["g"], onTask)).toBeNull();
  });
});

describe("setup's timeline (F-076)", () => {
  const organizationId = organizationIdSchema.parse(randomUUID());
  const otherOrganization = organizationIdSchema.parse(randomUUID());
  const start = Date.UTC(2026, 10, 20, 9, 0, 0);
  const minute = 60_000;
  const entry = (action: string, minutes: number, at = organizationId): SetupAuditEntry => ({ organizationId: at, action, createdAt: start + minutes * minute });
  // Written out of order, with a repeat and another organization's entries mixed in.
  const entries: readonly SetupAuditEntry[] = [
    entry("project.created", 9),
    entry("password.changed", 1),
    entry("runner.registered", 12),
    entry("provider.added", 3),
    entry("provider.added", 15),
    entry("github.connected", 6),
    entry("task.created", 14),
    entry("project.created", 2, otherOrganization),
    entry("member.verified", 4),
  ];

  it("F-076: orders the steps as the checklist does and measures each from the given start, the earliest entry counting", () => {
    const timeline = setupTimeline(organizationId, { start, entries, firstPullRequestOpenedAt: start + 22 * minute });
    expect(timeline.steps.map((row) => row.step)).toEqual([...setupTimelineSteps]);
    expect(timeline.steps.map((row) => (row.state === "done" ? row.sinceStartMs / minute : row.state))).toEqual([1, 3, 6, "missing", 9, 12, 14, 22]);
    expect(timeline.steps.find((row) => row.step === "project")).toMatchObject({ state: "done", at: start + 9 * minute });
    // Linear is optional: missing, but setup is complete without it.
    expect(timeline.steps.find((row) => row.step === "linear")).toEqual({ step: "linear", state: "missing", optional: true });
    expect(timeline.missing).toEqual([]);
    expect(timeline.totalMs).toBe(22 * minute);
    // Connected, it's measured like any other step.
    const withLinear = setupTimeline(organizationId, { start, entries: [...entries, entry("linear.connected", 7)], firstPullRequestOpenedAt: start + 22 * minute });
    expect(withLinear.steps.find((row) => row.step === "linear")).toMatchObject({ state: "done", sinceStartMs: 7 * minute });
  });

  it("F-076: a missing step is reported missing, not zero, and leaves no total", () => {
    const withoutRunner = entries.filter((row) => row.action !== "runner.registered");
    const timeline = setupTimeline(organizationId, { start, entries: withoutRunner, firstPullRequestOpenedAt: start + 22 * minute });
    expect(timeline.steps.find((row) => row.step === "runner")).toEqual({ step: "runner", state: "missing", optional: false });
    expect(timeline.missing).toEqual(["runner"]);
    expect(timeline.totalMs).toBeNull();
    // No PR yet: the last step is missing too.
    const noPr = setupTimeline(organizationId, { start, entries, firstPullRequestOpenedAt: null });
    expect(noPr.missing).toEqual(["first-pr"]);
    expect(noPr.totalMs).toBeNull();
    // Another organization's entries count for nothing here.
    const elsewhere = setupTimeline(otherOrganization, { start, entries, firstPullRequestOpenedAt: null });
    expect(elsewhere.steps.filter((row) => row.state === "done").map((row) => row.step)).toEqual(["project"]);
  });

  it("marks each step with actions of the closed audit list", () => {
    for (const [step, actions] of Object.entries(setupStepMarks)) {
      for (const action of actions) {
        expect(Object.hasOwn(auditActions, action), `${step}: ${action}`).toBe(true);
      }
    }
  });
});

describe("the theme (F-082)", () => {
  it("F-082/c2: a theme other than the three is refused", () => {
    expect(themePreferences).toEqual(["dark", "light", "system"]);
    for (const theme of themePreferences) {
      expect(parseSetThemeInput({ theme })).toEqual({ ok: true, value: { theme } });
    }
    for (const input of [{ theme: "sepia" }, { theme: "DARK" }, { theme: "" }, { theme: null }, {}, { theme: "dark", userId: "someone-else" }, "dark"]) {
      expect(parseSetThemeInput(input), JSON.stringify(input)).toMatchObject({ ok: false, error: "invalid-input" });
    }
  });

  it("F-082/c1: a new member's theme is dark, and so is a cookie ostra didn't write", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(themeFromCookie(undefined)).toBe("dark");
    expect(themeFromCookie("sepia")).toBe("dark");
    expect(themeFromCookie("light")).toBe("light");
    expect(themeFromCookie("system")).toBe("system");
    // `system` sets no data-theme, so the media query decides before first paint.
    expect(themePreferences.map(dataThemeFor)).toEqual(["dark", "light", null]);
  });

  it("names its audit action in the closed list", () => {
    expect(auditActions["account.theme_changed"]).toBe("user");
  });
});

describe("milestone 7's settings", () => {
  it("F-058: OSTRA_DOCS_URL defaults to the published docs site, ends in one slash, and refuses what isn't http(s)", () => {
    const fresh = parseServerSettings({});
    expect(fresh.ok && fresh.settings.docsUrl).toBe("https://joeykhd.github.io/ostra/");
    const own = parseServerSettings({ OSTRA_DOCS_URL: "https://docs.example.com/ostra//" });
    expect(own.ok && own.settings.docsUrl).toBe("https://docs.example.com/ostra/");
    const bare = parseServerSettings({ OSTRA_DOCS_URL: "http://intranet.example" });
    expect(bare.ok && bare.settings.docsUrl).toBe("http://intranet.example/");
    expect(parseServerSettings({ OSTRA_DOCS_URL: "javascript:alert(1)" }).ok).toBe(false);
  });
});
