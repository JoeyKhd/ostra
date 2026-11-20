import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { SetupSteps, settledCount } from "./setup-steps";
import type { SetupStep, SetupStepState } from "./setup-steps";

// F-076, F-005: the first-run checklist with the Linear step live (home-first-run.md).

const docs = (page: string): string => `https://docs.example.com/ostra/docs/${page}`;

const steps = (linear: SetupStepState): readonly SetupStep[] => [
  { id: "admin", state: "done", docs: docs("install/first-sign-in/") },
  { id: "model-provider", state: "done", docs: docs("agents-and-models/model-providers/") },
  { id: "github", state: "done", docs: docs("install/setup/#3-connect-github") },
  { id: "linear", state: linear, docs: docs("install/linear/") },
  { id: "project", state: "open", docs: docs("install/setup/#5-create-a-project") },
  { id: "runner", state: "open", docs: docs("install/setup/#6-connect-a-runner") },
  { id: "first-task", state: "open", docs: docs("using-ostra/tasks/") },
];

/** The row's links, the docs' one left out: what the step offers to do. */
const actionHrefs = (row: string): string[] => [...row.matchAll(/<a (?![^>]*data-docs)[^>]*href="([^"]*)"/g)].map((match) => match[1] ?? "");

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
    expect(actionHrefs(row)).toEqual([]);
  });

  it("a member sees no Skip for now and no Connect Linear", () => {
    const row = linearRow(render("open", "linear", false));
    expect(row).not.toContain(t("checklist.linear.skip"));
    expect(actionHrefs(row)).toEqual([]);
  });

  it("counts done and skipped steps as settled", () => {
    expect(settledCount(steps("skipped"))).toBe(4);
    expect(settledCount(steps("open"))).toBe(3);
  });
});

describe("the checklist's links to the docs", () => {
  it("F-076: every step links to its page in the docs, in a new tab, done or not, for every member", () => {
    for (const admin of [true, false]) {
      const html = renderToStaticMarkup(<SetupSteps steps={steps("open")} next="project" admin={admin} skip={skip} />);
      for (const step of steps("open")) {
        const start = html.indexOf(`data-step="${step.id}"`);
        const row = html.slice(start, html.indexOf("</li>", start));
        const link = /<a [^>]*data-docs[^>]*>/.exec(row)?.[0] ?? "";
        expect(link, step.id).toContain(`href="${step.docs}"`);
        expect(link).toContain('target="_blank"');
        expect(link).toContain('rel="noreferrer"');
      }
    }
  });
});
