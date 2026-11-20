import { runnerNotificationKinds } from "@ostra/adapter-sdk";
import type { RunnerNoticeSubject } from "@ostra/adapter-sdk";
import { runnerIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { renderRunnerNotice, runnerNoticeHeading } from "./runner-notices.ts";

// F-091 (milestone 5's ticket 03): the runner notices render in the panel and in both parts of a
// mail, with the runner's name, its pool, its executor, the token's label and the runner's page,
// and never the join token or the runner's key.

const JOIN_TOKEN = "ostra_jt_4f1d0c9a7b2e8d6f5a3c1b0e9d8c7b6a";
const PUBLIC_KEY = "MCowBQYDK2VwAyEAq8Jx2l1n9vB3kY7fT0pW5sR4mD6hG1cZ";

/** A runner as core reads it at the join: its notice's fields, beside its token and key. */
const joinedRunner = {
  runnerId: runnerIdSchema.parse("runner-7"),
  runnerName: "build-box-07",
  poolName: "linux-docker",
  executor: "kubernetes",
  tokenLabel: "ci hosts, november",
  url: "https://ostra.example/runners/runner-7",
  joinToken: JOIN_TOKEN,
  publicKey: PUBLIC_KEY,
} as const;

type Kind = (typeof runnerNotificationKinds)[number];

// The runner's row, with its token and key, handed over as it is: the renderer must pick its fields.
const subject: RunnerNoticeSubject = joinedRunner;

const render = (kind: Kind, runner: RunnerNoticeSubject = subject) =>
  renderRunnerNotice({ kind, runner, organizationName: "Acme", publicUrl: "https://ostra.example/" });

const rendersTheFacts = (kind: Kind): void => {
  const { panel, email } = render(kind);
  expect(panel.title).toBe(runnerNoticeHeading[kind]);
  expect(panel.url).toBe(joinedRunner.url);
  for (const part of [panel.line, email.text, email.html]) {
    expect(part).toContain("build-box-07");
    expect(part).toContain("linux-docker");
    expect(part).toContain("Kubernetes");
    expect(part).toContain("ci hosts, november");
  }
  expect(email.subject).toBe(`${runnerNoticeHeading[kind]} · build-box-07 in linux-docker`);
  expect(email.text).toContain(joinedRunner.url);
  expect(email.html).toContain(`href="${joinedRunner.url}"`);
  expect(email.html).toContain("https://ostra.example/email/logo-abyss@2x.png");
};

const carriesNoSecret = (kind: Kind): void => {
  const rendered = render(kind);
  const parts = [rendered.panel.title, rendered.panel.line, rendered.panel.url, rendered.email.subject, rendered.email.html, rendered.email.text];
  for (const part of parts) {
    expect(part).not.toContain(JOIN_TOKEN);
    expect(part).not.toContain(PUBLIC_KEY);
    expect(part).not.toContain("ostra_jt_");
  }
};

describe("F-091: the runner notices", () => {
  it("F-091/c7: runner_joined renders the runner, its pool, its executor, the token's label and its page in the panel and both parts of the mail", () => {
    rendersTheFacts("runner_joined");
  });

  it("F-091/c7: runner_awaiting_approval renders the runner, its pool, its executor, the token's label and its page in the panel and both parts of the mail", () => {
    rendersTheFacts("runner_awaiting_approval");
  });

  it("F-091/c7: runner_joined carries no join token and no key in any part", () => {
    carriesNoSecret("runner_joined");
  });

  it("F-091/c7: runner_awaiting_approval carries no join token and no key in any part", () => {
    carriesNoSecret("runner_awaiting_approval");
  });

  it("F-091: every runner notice kind has its heading", () => {
    expect(Object.keys(runnerNoticeHeading).sort()).toEqual([...runnerNotificationKinds].sort());
  });

  it("F-091: only the approval notice says the runner waits, and asks for a review", () => {
    expect(render("runner_awaiting_approval").email.text).toContain("It takes no task until an admin approves it.");
    expect(render("runner_awaiting_approval").email.text).toContain("Review the runner: ");
    expect(render("runner_joined").email.text).not.toContain("approves it");
  });

  it("F-091: a runner's own name is text, escaped in the HTML, and a token without a label says so", () => {
    const { panel, email } = render("runner_joined", { ...subject, runnerName: "<img src=x onerror=alert(1)>", tokenLabel: null, executor: "host" });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.text).toContain("Joined with: a token without a label");
    expect(panel.line).toContain("host, not isolated");
  });
});
