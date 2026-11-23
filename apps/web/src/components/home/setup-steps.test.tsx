import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { connectionIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { SetupSteps, settledCount } from "./setup-steps";
import type { SetupStep, SetupStepState } from "./setup-steps";

// F-076, F-005, F-152/c7: the first-run checklist with the tracker step live (home-first-run.md,
// setup-checklist.md): step 4, "Connect a tracker", in its five states for both kinds.

const docs = (page: string): string => `https://docs.example.com/ostra/docs/${page}`;

const linear = { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), kind: "linear", name: "Acme Linear" } as const;
const jira = { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c2"), kind: "jira", name: "Globex Jira" } as const;

const steps = (tracker: SetupStepState, connection?: SetupStep["connection"]): readonly SetupStep[] => [
  { id: "admin", state: "done", docs: docs("install/first-sign-in/") },
  { id: "model-provider", state: "done", docs: docs("agents-and-models/model-providers/") },
  { id: "github", state: "done", docs: docs("install/setup/#3-connect-github") },
  { id: "tracker", state: tracker, docs: docs("install/trackers/"), ...(connection === undefined ? {} : { connection }) },
  { id: "project", state: "open", docs: docs("install/setup/#5-create-a-project") },
  { id: "runner", state: "open", docs: docs("install/setup/#6-connect-a-runner") },
  { id: "first-task", state: "open", docs: docs("using-ostra/tasks/") },
];

/** A row's links: the docs' one left out, and the marks' `aria-hidden` ones counted separately. */
const actionHrefs = (row: string): string[] => [...row.matchAll(/<a (?![^>]*data-docs)[^>]*href="([^"]*)"/g)].map((match) => match[1] ?? "");

const skip = { run: () => undefined, pending: false };

const trackerRow = (html: string): string => {
  const start = html.indexOf('data-step="tracker"');
  return html.slice(start, html.indexOf("</li>", start));
};

const render = (state: SetupStepState, next: SetupStep["id"] | null, connection?: SetupStep["connection"], admin = true, pending = false) =>
  renderToStaticMarkup(<SetupSteps steps={steps(state, connection)} next={next} admin={admin} skip={{ ...skip, pending }} />);

describe("the checklist's tracker step (F-152/c7)", () => {
  it("F-152/c7: open, as the next step, offers both marks, Skip for now and one primary Connect a tracker to Trackers", () => {
    const row = trackerRow(render("open", "tracker"));
    expect(row).toContain('data-next="true"');
    expect(row).toContain('data-tick="current"');
    expect(row).toContain(t("checklist.tracker.title"));
    expect(row).toContain(t("checklist.tracker.skip"));
    expect(row).toContain(t("checklist.tracker.action"));
    expect(row).toContain('href="/organization/trackers"');
    expect(row).toContain("bg-primary");
    // Both marks, in their brand colour, beside their names.
    expect(row).toContain('data-tracker-mark="linear"');
    expect(row).toContain('data-tracker-mark="jira"');
    expect(row).toContain('data-treatment="brand"');
    expect(row).toContain(">Linear<");
    expect(row).toContain(">Jira<");
    expect(row).toContain("tickets become tasks");
  });

  it("F-152/c7: open but not next is an outline button, and still skippable", () => {
    const row = trackerRow(render("open", "model-provider"));
    expect(row).toContain('data-tick="later"');
    expect(row).not.toContain("bg-primary");
    expect(row).toContain(t("checklist.tracker.skip"));
  });

  it("F-152/c7: while skipping, the action says so and is disabled", () => {
    const row = trackerRow(render("open", "tracker", undefined, true, true));
    expect(row).toContain(t("checklist.tracker.skipping"));
    expect(row).toContain("disabled");
  });

  it("F-152/c7: pending names the Jira connection and continues on its page", () => {
    const row = trackerRow(render("pending", "tracker", jira));
    expect(row).toContain("Started <span class=\"text-text-2\">Globex Jira</span>: add the webhook in Jira to finish.");
    expect(row).toContain(t("checklist.tracker.continue"));
    expect(row).toContain('href="/organization/trackers/01900000-0000-7000-8000-0000000000c2"');
    expect(row).not.toContain(t("checklist.tracker.skip"));
  });

  it("F-152/c7: pending names the Linear connection in Linear's words", () => {
    const row = trackerRow(render("pending", "tracker", linear));
    expect(row).toContain("Started <span class=\"text-text-2\">Acme Linear</span>: paste the app&#x27;s values and authorize to finish.");
    expect(row).toContain('href="/organization/trackers/01900000-0000-7000-8000-0000000000c1"');
  });

  it("F-152/c7: failed says Jira refused the token, with a red mark and Replace the token in outline", () => {
    const row = trackerRow(render("failed", "tracker", jira));
    expect(row).toContain("Jira refused <span class=\"text-text-2\">Globex Jira</span>&#x27;s token. Replace it to finish.");
    expect(row).toContain(t("checklist.tracker.replace"));
    expect(row).toContain("text-red");
    expect(row).not.toContain("bg-primary");
    expect(row).toContain('href="/organization/trackers/01900000-0000-7000-8000-0000000000c2"');
  });

  it("F-152/c7: failed on Linear keeps Linear's words and Authorize again", () => {
    const row = trackerRow(render("failed", "tracker", linear));
    expect(row).toContain("Linear refused the token. Authorize the app again.");
    expect(row).toContain(t("checklist.tracker.authorizeAgain"));
    expect(row).not.toContain(t("checklist.tracker.replace"));
  });

  it("F-152/c7: done reads Connected with the connection's mark and name, and offers nothing", () => {
    for (const connection of [linear, jira]) {
      const row = trackerRow(render("done", "project", connection));
      expect(row).toContain('data-tick="done"');
      expect(row).toContain("Connected");
      expect(row).toContain(connection.name);
      expect(row).toContain(`data-tracker-mark="${connection.kind}"`);
      expect(actionHrefs(row)).toEqual([]);
    }
  });

  it("F-152/c7: skipped says tasks start from prompts, and offers Connect a tracker again", () => {
    const row = trackerRow(render("skipped", "project"));
    expect(row).toContain('data-tick="skipped"');
    expect(row).toContain(t("checklist.tracker.skipped"));
    expect(row).toContain(t("checklist.tracker.action"));
    expect(row).toContain('href="/organization/trackers"');
    expect(row).not.toContain("bg-primary");
  });

  it("F-152/c7: a member sees no Skip for now and no action", () => {
    const row = trackerRow(render("open", "tracker", undefined, false));
    expect(row).not.toContain(t("checklist.tracker.skip"));
    expect(actionHrefs(row)).toEqual([]);
  });

  it("counts done and skipped steps as settled", () => {
    expect(settledCount(steps("skipped"))).toBe(4);
    expect(settledCount(steps("open"))).toBe(3);
  });
});

describe("the checklist's links to the docs", () => {
  it("F-076/c1: every step links to its page in the docs, in a new tab, done or not, for every member", () => {
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
