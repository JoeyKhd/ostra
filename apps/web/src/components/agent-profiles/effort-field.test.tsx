import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { EffortLevel } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { EffortField, effortChoiceOf, effortFieldView, panelEffort } from "./effort-field";
import type { EffortChoice, EffortOptions } from "./effort-field";

/** The markup with apostrophes as typed, so a message reads as it is in `en.json`. */
const renderToStaticMarkup = (node: ReactElement): string => renderMarkup(node).replaceAll("&#x27;", "'");

// F-137: the profile's Effort (agent-profile-effort.md), each state of the target.

const gpt55: EffortChoice = { kind: "levels", modelName: "GPT-5.5", levels: ["default", "none", "low", "medium", "high", "xhigh"] };
const deepseek: EffortChoice = { kind: "levels", modelName: "DeepSeek V4 Pro", levels: ["default", "low", "high", "max"] };
const haiku: EffortChoice = { kind: "levels", modelName: "Claude Haiku 5", levels: ["default"] };

const render = (choice: EffortChoice, value: EffortLevel, readOnly = false): string =>
  renderToStaticMarkup(<EffortField choice={choice} value={value} readOnly={readOnly} onChange={() => undefined} />);

const levelRows = (html: string): string[] => [...html.matchAll(/data-level="(\w+)"/g)].map((match) => match[1] ?? "");

describe("the profile's effort", () => {
  it("F-137: offers exactly the model's levels, Default first, each with its hint, the saved one chosen", () => {
    const html = render(gpt55, "high");
    expect(levelRows(html)).toEqual(["default", "none", "low", "medium", "high", "xhigh"]);
    expect(html).toContain("How long GPT-5.5 thinks before it acts. Its own levels.");
    expect(html).toContain("Extra high");
    expect(html).toContain(t("effort.hints.xhigh"));
    expect(html).toContain(t("effort.hints.default"));
    expect(html).toMatch(/data-level="high" data-chosen="true"/);
    expect(html).toContain(t("agentProfiles.editor.effort.note"));
    expect(html).not.toContain("Minimal");
  });

  it("F-137: the list is rebuilt from another model's levels, and Extra high reads apart from Max", () => {
    const html = render(deepseek, "high");
    expect(levelRows(html)).toEqual(["default", "low", "high", "max"]);
    expect(render({ kind: "levels", modelName: "M", levels: ["default", "xhigh", "max"] }, "xhigh")).toContain(t("effort.hints.xhighBesideMax"));
  });

  it("F-137: a stored level the model lacks names the level new tasks run at, with none chosen", () => {
    const view = effortFieldView(deepseek, "xhigh");
    expect(view).toEqual({ kind: "list", levels: deepseek.levels, chosen: null, stored: { saved: "xhigh", runAt: "max" } });
    const html = render(deepseek, "xhigh");
    expect(html).toContain("Saved as Extra high. DeepSeek V4 Pro has no Extra high, so new tasks run at Max.");
    expect(html).not.toContain('data-chosen="true"');
    expect(render(deepseek, "medium")).toContain("so new tasks run at High.");
  });

  it("F-137: a model that doesn't reason offers no control, and the panel reads Default", () => {
    const html = render(haiku, "high");
    expect(levelRows(html)).toEqual([]);
    expect(html).toContain("Claude Haiku 5 doesn't take an effort level. Tasks run at the endpoint's default.");
    expect(panelEffort(haiku, "high")).toBe("default");
    expect(panelEffort(gpt55, "high")).toBe("high");
  });

  it("F-137: a custom model nobody set links an admin to Models, and a member reads the sentence alone", () => {
    const admin = render({ kind: "unset-custom", modelName: "acme/sql-coder-ft", modelsHref: "/organization/models?tab=models" }, "default");
    expect(admin).toContain("Nobody has said whether acme/sql-coder-ft reasons, so tasks run without an effort level.");
    expect(admin).toContain('href="/organization/models?tab=models"');
    expect(admin).toContain(t("agentProfiles.editor.effort.setInModels"));
    const member = render({ kind: "unset-custom", modelName: "acme/sql-coder-ft", modelsHref: null }, "default");
    expect(member).not.toContain(t("agentProfiles.editor.effort.setInModels"));
  });

  it("F-137: an agent that can't set an effort says so", () => {
    expect(render({ kind: "agent-none", agentName: "Claude Code" }, "default")).toContain("Claude Code doesn't take an effort level. Tasks run at the model's default.");
  });

  it("F-137: read-only shows the chosen level as text with its hint, no radios", () => {
    const html = render(gpt55, "high", true);
    expect(html).toContain('data-testid="profile-effort-read"');
    expect(html).toContain(t("effort.hints.high"));
    expect(html).not.toContain('role="radio"');
  });

  it("F-137: loading shows four skeleton rows", () => {
    const html = render({ kind: "loading" }, "default");
    expect(html).toContain("aria-busy");
    expect(html.match(/h-\[26px\]/g)).toHaveLength(4);
  });
});

describe("the choice from agentProfiles.effortLevels", () => {
  const options = (over: Partial<EffortOptions>): EffortOptions => ({
    levels: (["default", "low", "high", "max"] as const).map((level) => ({ level, labelKey: `effort.levels.${level}` })),
    runsAt: "default",
    adjusted: false,
    reasoningSource: "catalog",
    customModel: false,
    agentTakesEffort: true,
    ...over,
  });
  const names = { model: "DeepSeek V4 Pro", agent: "OpenCode" };

  it("F-137: the router's levels become the list; an agent with none, and a custom model nobody set, become their lines", () => {
    expect(effortChoiceOf(undefined, names, null)).toEqual({ kind: "loading" });
    expect(effortChoiceOf(options({}), names, null)).toEqual({ kind: "levels", modelName: "DeepSeek V4 Pro", levels: ["default", "low", "high", "max"] });
    expect(effortChoiceOf(options({ agentTakesEffort: false }), names, null)).toEqual({ kind: "agent-none", agentName: "OpenCode" });
    expect(effortChoiceOf(options({ customModel: true, reasoningSource: null, levels: [{ level: "default", labelKey: "effort.levels.default" }] }), names, "/organization/models?model=m")).toEqual({
      kind: "unset-custom",
      modelName: "DeepSeek V4 Pro",
      modelsHref: "/organization/models?model=m",
    });
    expect(effortChoiceOf(options({ customModel: true, reasoningSource: "admin" }), names, null).kind).toBe("levels");
  });
});
