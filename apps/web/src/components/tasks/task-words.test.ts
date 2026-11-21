import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { doingText, headerActivity, taskStateLine } from "./task-words";

describe("doingText", () => {
  it("says nothing when the agent is doing nothing", () => {
    expect(doingText(null)).toBe("");
  });

  it("words every kind of the list's latest event", () => {
    expect(doingText({ kind: "tool.called", detail: "Read file", toolKind: null })).toBe(t("doing.tool", { title: "Read file" }));
    expect(doingText({ kind: "tool.called", detail: null, toolKind: null })).toBe(t("doing.tool", { title: "" }));
    expect(doingText({ kind: "agent.message", detail: null, toolKind: null })).toBe(t("doing.writing"));
    expect(doingText({ kind: "agent.thought", detail: null, toolKind: null })).toBe(t("doing.thinking"));
    expect(doingText({ kind: "environment.setup_started", detail: null, toolKind: null })).toBe(t("doing.settingUp"));
    expect(doingText({ kind: "environment.setup_output", detail: null, toolKind: null })).toBe(t("doing.settingUp"));
    expect(doingText({ kind: "approval.requested", detail: null, toolKind: null })).toBe(t("doing.waitingApproval"));
    expect(doingText({ kind: "question.asked", detail: null, toolKind: null })).toBe(t("doing.waitingAnswer"));
    expect(doingText({ kind: "git.pushed", detail: null, toolKind: null })).toBe(t("doing.pushing"));
  });
});

describe("taskStateLine", () => {
  it("names what waits on a person when it's an approval or a question", () => {
    expect(taskStateLine("needs_you", "approval")).toBe("Needs you · approval");
    expect(taskStateLine("needs_you", "question")).toBe("Needs you · question");
    expect(taskStateLine("needs_you", "no_changes")).toBe("Needs you");
    expect(taskStateLine("awaiting_approval", null)).toBe("Awaiting approval");
    expect(taskStateLine("running", null)).toBe("Running");
  });
});

describe("headerActivity", () => {
  it("drops activity that only repeats the state", () => {
    expect(headerActivity({ kind: "waiting-approval" })).toBe("");
    expect(headerActivity({ kind: "waiting-answer" })).toBe("");
    expect(headerActivity({ kind: "thinking" })).toBe(t("doing.thinking"));
  });
});
