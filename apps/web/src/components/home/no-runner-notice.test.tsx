import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { homeSetupView, NoRunnerNotice } from "./no-runner-notice";

// F-076 (2026-11-21): Home's checklist on a first run only; once setup was done, a quiet notice
// while no runner is online, with the way to Runners for admins.

type SetupStatus = RouterOutputs["setup"]["status"];

const docs = "https://docs.example.com/ostra/docs/install/setup/";
const status = (over: Partial<SetupStatus>): SetupStatus => ({
  steps: [
    { id: "admin", state: "done", docs },
    { id: "model-provider", state: "done", docs },
    { id: "github", state: "done", docs },
    { id: "tracker", state: "skipped", docs },
    { id: "project", state: "done", docs },
    { id: "runner", state: "open", docs },
    { id: "first-task", state: "done", docs },
  ],
  next: "runner",
  complete: false,
  completedAt: null,
  runnerOnline: false,
  ...over,
});

const esc = (text: string): string => text.replaceAll("'", "&#x27;");

describe("Home's setup line", () => {
  it("F-076/c1: a first run shows the checklist; a finished setup with every runner offline shows the notice instead, and with one online nothing", () => {
    expect(homeSetupView(undefined)).toBe("loading");
    expect(homeSetupView(status({}))).toBe("checklist");
    const done = Date.UTC(2026, 10, 20, 9);
    expect(homeSetupView(status({ complete: true, completedAt: done, runnerOnline: false }))).toBe("no-runner");
    expect(homeSetupView(status({ complete: true, completedAt: done, runnerOnline: true, next: null }))).toBe("done");
  });

  it("F-076/c1: the notice says new tasks wait in the queue, and links to Runners for admins only", () => {
    const admin = renderToStaticMarkup(<NoRunnerNotice admin />);
    expect(admin).toContain(esc(t("home.noRunner.text")));
    expect(admin).toContain('href="/organization/runners"');
    expect(admin).toContain('role="status"');
    const member = renderToStaticMarkup(<NoRunnerNotice admin={false} />);
    expect(member).toContain(esc(t("home.noRunner.text")));
    expect(member).not.toContain("href=");
  });
});
