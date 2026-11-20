import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { SetupSteps, settledCount } from "./setup-steps";
import type { SetupStep, SetupStepState } from "./setup-steps";

// F-076, F-005: the first-run checklist with the Linear step live (home-first-run.md).

const steps = (linear: SetupStepState): readonly SetupStep[] => [
  { id: "admin", state: "done" },
  { id: "model-provider", state: "done" },
  { id: "github", state: "done" },
  { id: "linear", state: linear },
  { id: "project", state: "open" },
  { id: "runner", state: "open" },
  { id: "first-task", state: "open" },
];

const skip = { run: () => undefined, pending: false };

const linearRow = (html: string): string => {
  const start = html.indexOf('data-step="linear"');
  return html.slice(start, html.indexOf("</li>", start));
};

const render = (linear: SetupStepState, next: SetupStep["id"] | null, admin = true, pending = false) =>
  renderToStaticMarkup(<SetupSteps steps={steps(linear)} next={next} admin={admin} skip={{ ...skip, pending }} />);

describe("the checklist's Linear step", () => {
  it("F-005: next: Skip for now and the page's one primary Connect Linear", () => {
    const row = linearRow(render("open", "linear"));
    expect(row).toContain('data-next="true"');
    expect(row).toContain('data-tick="current"');
    expect(row).toContain(t("checklist.linear.skip"));
    expect(row).toContain('href="/organization/linear"');
    expect(row).toContain("bg-primary");
  });

  it("open but not next: an outline button", () => {
    const row = linearRow(render("open", "model-provider"));
    expect(row).toContain('data-tick="later"');
    expect(row).not.toContain("bg-primary");
    expect(row).toContain(t("checklist.linear.skip"));
  });

  it("while skipping, the link says so and is disabled", () => {
    const row = linearRow(render("open", "linear", true, true));
    expect(row).toContain(t("checklist.linear.skipping"));
    expect(row).toContain("disabled");
  });

  it("started: Continue, and no skip", () => {
    const row = linearRow(render("pending", "linear"));
    expect(row).toContain("paste the app");
    expect(row).toContain(t("checklist.linear.continue"));
    expect(row).not.toContain(t("checklist.linear.skip"));
  });

  it("failed: says Linear refused the token, with Authorize again in outline", () => {
    const row = linearRow(render("failed", "linear"));
    expect(row).toContain(t("checklist.linear.failed"));
    expect(row).toContain(t("checklist.linear.authorizeAgain"));
    expect(row).not.toContain("bg-primary");
  });

  it("skipped: a dashed circle, the skipped body and a link to connect it later", () => {
    const row = linearRow(render("skipped", "project"));
    expect(row).toContain('data-tick="skipped"');
    expect(row).toContain(t("checklist.linear.skipped"));
    expect(row).toContain('href="/organization/linear"');
    expect(row).not.toContain("bg-primary");
  });

  it("done: ticked, no action", () => {
    const row = linearRow(render("done", "project"));
    expect(row).toContain('data-tick="done"');
    expect(row).not.toContain("href=");
  });

  it("a member sees no Skip for now and no Connect Linear", () => {
    const row = linearRow(render("open", "linear", false));
    expect(row).not.toContain(t("checklist.linear.skip"));
    expect(row).not.toContain("href=");
  });

  it("counts done and skipped steps as settled", () => {
    expect(settledCount(steps("skipped"))).toBe(4);
    expect(settledCount(steps("open"))).toBe(3);
  });
});
