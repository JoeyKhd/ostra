import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { doingText } from "./task-words";

describe("doingText", () => {
  it("says nothing when the agent is doing nothing", () => {
    expect(doingText(null)).toBe("");
  });

  it("words every kind of the list's latest event", () => {
    expect(doingText({ kind: "tool.called", detail: "Read file" })).toBe(t("doing.tool", { title: "Read file" }));
    expect(doingText({ kind: "tool.called", detail: null })).toBe(t("doing.tool", { title: "" }));
    expect(doingText({ kind: "agent.message", detail: null })).toBe(t("doing.writing"));
    expect(doingText({ kind: "agent.thought", detail: null })).toBe(t("doing.thinking"));
    expect(doingText({ kind: "environment.setup_started", detail: null })).toBe(t("doing.settingUp"));
    expect(doingText({ kind: "environment.setup_output", detail: null })).toBe(t("doing.settingUp"));
    expect(doingText({ kind: "approval.requested", detail: null })).toBe(t("doing.waitingApproval"));
    expect(doingText({ kind: "question.asked", detail: null })).toBe(t("doing.waitingAnswer"));
    expect(doingText({ kind: "git.pushed", detail: null })).toBe(t("doing.pushing"));
  });
});
