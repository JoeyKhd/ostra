import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FAKE_AGENT_QUESTION_FIELD, fakeMarker, toolSetsByKind } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, blobIdSchema, clientMessageIdSchema, NEUTRAL_REPLY, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { ApprovalRule, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { expect } from "vitest";
import { startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "./task-host-harness.ts";

// Ticket 23 (F-101, F-113, F-035, protocol minor 5) on one executor, with the scripted fake agent,
// the real git proxy and the git upstream stub:
// - an automatic turn (the spec's `automatic`, or a steer's) answers the agent's question with the
//   fixed neutral reply at once, never as a decline, and records `question.auto_answered`; the same
//   question in a member's turn waits for a person; an approval in an automatic turn still waits;
// - with `commitPaths`, a turn's commit keeps only the allowed paths: the rest stay in the working
//   tree, an agent's own commit that touched them is rebuilt on the base, a repo with nothing
//   allowed isn't pushed, and `commit.filtered` says what was kept and left;
// - a CI round's log tails are written under `.ostra/ci/`, never into a commit.
// The same cases run on `host` (`team-turns.host.test.ts`) and on `docker` as a box's sidecar drives
// it (`team-turns.docker.test.ts`), where the first turn's flag comes from the spec alone.

export type TeamTurnsMode = {
  readonly name: "host" | "docker";
  readonly makeExecutor?: HarnessOptions["makeExecutor"];
};

const run = promisify(execFile);
const git = async (cwd: string, ...args: readonly string[]): Promise<string> => (await run("git", [...args], { cwd, windowsHide: true })).stdout.trim();

type Repo = TaskSpec["repos"][number];

const repoOf = (base: Repo, name: string): Repo => ({
  ...base,
  repoId: repoIdSchema.parse(`repo-${name}`),
  fullName: repoFullNameSchema.parse(`ostra-test/${name}`),
  cloneUrl: `https://github.com/ostra-test/${name}.git`,
  checkoutDir: name,
});

/** The agent's words in the session, in order. */
const said = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join("\n");

/** What the asking fake asks: its text must never reach a log line. */
const QUESTION_TEXT = "Should I keep the old banner's markup";

const EDIT_RULE: ApprovalRule = { ruleId: approvalRuleIdSchema.parse("rule-notes"), name: "Edits to notes", tool: "edit", match: { kind: "path-glob", glob: "notes*.txt" } };

/** An onboarding task's spec fields (F-113): `AGENTS.md` only, with the onboarding tool sets. */
const onboarding = { commitPaths: ["AGENTS.md"], tools: [...toolSetsByKind.onboarding] } satisfies Partial<TaskSpec>;

export const teamTurnsCases = (mode: TeamTurnsMode) => {
  let current: Shared | undefined;
  let harness: Harness | undefined;
  const shared = (): Shared => {
    if (current === undefined) {
      throw new Error("the cases' setup didn't run");
    }
    return current;
  };

  const start = async (): Promise<Harness> => {
    harness = await startHarness(shared(), mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor });
    return harness;
  };

  /** The repo checkout the agent's session opened on. */
  const checkoutOf = (h: Harness, name?: string): string => {
    const cwd = h.launches.at(-1)?.cwd;
    if (cwd === undefined) throw new Error("no launch");
    return name === undefined ? cwd : path.join(cwd, name);
  };

  const steerAutomatic = (h: Harness, spec: TaskSpec, text: string): string =>
    h.command("steer", { sessionId: spec.sessionId, clientMessageId: clientMessageIdSchema.parse(`round-${randomUUID()}`), text, delivery: "queue", intent: "fix-ci", automatic: true });

  return {
    setup: async (): Promise<void> => {
      current = await startShared(`team-turns-${mode.name}`);
      await current.upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
    },
    teardown: async (): Promise<void> => {
      await current?.close();
      current = undefined;
    },
    cleanup: async (): Promise<void> => {
      await harness?.close();
      harness = undefined;
    },

    /** F-101: a question in an automatic turn gets the neutral reply and the turn carries on. */
    automaticQuestion: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("ask-and-continue"), { automatic: true });
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      expect(said(h, spec)).toContain(`carried on with: ${NEUTRAL_REPLY}`);
      const answered = h.ofKind(spec, "question.auto_answered");
      expect(answered).toHaveLength(1);
      expect(answered[0]?.reply).toBe(NEUTRAL_REPLY);
      expect(answered[0]?.questionId).toMatch(/^[0-9a-f-]{36}$/);
      // Never put to a person, never declined: no question.asked, no question.closed.
      expect(h.kinds(spec)).not.toContain("question.asked");
      expect(h.kinds(spec)).not.toContain("question.closed");
      expect(h.ofKind(spec, "turn.ended").map((event) => event.stopReason)).toEqual(["end_turn"]);
      // The question's text stays out of every log line; its ID is there.
      const logged = JSON.stringify(h.logs);
      expect(logged).not.toContain(QUESTION_TEXT);
      expect(logged).toContain(answered[0]?.questionId ?? "none");
    },

    /** F-101: the same question in a member's turn waits for a person, and their answer goes through. */
    memberQuestion: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("ask-and-continue"));
      h.dispatch(spec);
      await h.waitForKind(spec, "question.asked");
      // Held: the turn waits for a person, and nothing answers it for them.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(h.kinds(spec)).not.toContain("turn.ended");
      expect(h.kinds(spec)).not.toContain("question.auto_answered");
      expect(said(h, spec)).not.toContain("carried on with");
      const [asked] = h.ofKind(spec, "question.asked");
      const answer = h.command("question-answer", { sessionId: spec.sessionId, questionId: asked?.questionId, answers: { [FAKE_AGENT_QUESTION_FIELD]: "replace it" } });
      expect(await h.waitForAck(answer)).toMatchObject({ result: "done" });
      await h.waitForKind(spec, "session.saved", 1);
      expect(said(h, spec)).toContain("carried on with: replace it");
      // Then an automatic round on the same session: its question gets the neutral reply.
      steerAutomatic(h, spec, fakeMarker("ask-and-continue"));
      await h.waitForKind(spec, "session.saved", 2);
      expect(h.ofKind(spec, "question.auto_answered")).toHaveLength(1);
      expect(h.ofKind(spec, "question.asked")).toHaveLength(1);
      expect(said(h, spec)).toContain(`carried on with: ${NEUTRAL_REPLY}`);
      // And a member's message after it is theirs again: its question waits.
      h.steer(spec, fakeMarker("ask-and-continue"));
      await h.waitForKind(spec, "question.asked", 2);
      expect(h.ofKind(spec, "question.auto_answered")).toHaveLength(1);
    },

    /** F-101: an approval in an automatic turn still follows the profile's rules and waits for a person. */
    automaticApproval: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("ask-path", "notes.txt"), {
        automatic: true,
        agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages", approvalRules: [EDIT_RULE] },
      });
      h.dispatch(spec);
      await h.waitForKind(spec, "approval.requested");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(h.kinds(spec)).not.toContain("turn.ended");
      expect(h.kinds(spec)).not.toContain("approval.auto_answered");
      const [requested] = h.ofKind(spec, "approval.requested");
      expect(await h.waitForAck(h.command("approval-answer", { sessionId: spec.sessionId, approvalId: requested?.approvalId, decision: "allow_once" }))).toMatchObject({ result: "done" });
      await h.waitForKind(spec, "session.saved", 1);
      expect(said(h, spec)).toContain("Wrote notes.txt.");
    },

    /** F-113: an onboarding turn that changed a lockfile and added `AGENTS.md` pushes only `AGENTS.md`. */
    onlyAgentsMd: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("write", "AGENTS.md pnpm-lock.yaml"), onboarding);
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      const branch = `refs/heads/${spec.branchName}`;
      expect(await shared().upstream.treeFiles("ostra-test/test1", branch)).toEqual(["AGENTS.md", "README.md", "notes.txt"]);
      expect(await shared().upstream.fileAt("ostra-test/test1", branch, "pnpm-lock.yaml")).toBeNull();
      expect(h.ofKind(spec, "commit.filtered")).toEqual([{ kind: "commit.filtered", repoId: spec.repos[0]?.repoId, kept: ["AGENTS.md"], dropped: ["pnpm-lock.yaml"], droppedCount: 1 }]);
      // The lockfile is still in the workspace, uncommitted.
      expect(await git(checkoutOf(h), "status", "--porcelain")).toBe("?? pnpm-lock.yaml");
      const [saved] = h.ofKind(spec, "session.saved");
      expect(saved?.repos[0]).toMatchObject({ ahead: true });
    },

    /** F-113: an agent's own commit touching other paths is rebuilt as one commit on the base with only the allowed ones. */
    agentCommitRebuilt: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("commit", "AGENTS.md package.json"), { ...onboarding, title: "Onboard the repo" });
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      expect(said(h, spec)).toContain("Committed AGENTS.md, package.json.");
      const branch = `refs/heads/${spec.branchName}`;
      expect(await shared().upstream.treeFiles("ostra-test/test1", branch)).toEqual(["AGENTS.md", "README.md", "notes.txt"]);
      // One commit on the base, the runner's, not the agent's.
      const checkout = checkoutOf(h);
      expect(await git(checkout, "rev-list", "--count", "refs/remotes/origin/main..HEAD")).toBe("1");
      expect(await shared().upstream.commitMessage("ostra-test/test1", branch)).toContain("Onboard the repo");
      expect(await shared().upstream.commitMessage("ostra-test/test1", branch)).not.toContain("The fake agent's own commit");
      expect(h.ofKind(spec, "commit.filtered")).toEqual([{ kind: "commit.filtered", repoId: spec.repos[0]?.repoId, kept: ["AGENTS.md"], dropped: ["package.json"], droppedCount: 1 }]);
      // What the agent committed outside the allowed paths is back in the tree, uncommitted.
      expect(await git(checkout, "status", "--porcelain")).toBe("?? package.json");
      expect(await readFile(path.join(checkout, "package.json"), "utf8")).toBe("Committed by the fake agent.\n");
    },

    /** F-113: a repo whose turn changed nothing allowed isn't pushed; `commit.filtered` caps its list at 50 with the count. */
    nothingAllowedNotPushed: async (): Promise<void> => {
      const h = await start();
      const base = h.taskFor("unused").spec.repos[0];
      if (base === undefined) throw new Error("no repo in the fixture");
      const repos = [repoOf(base, "test1"), repoOf(base, "test2")];
      const generated = Array.from({ length: 55 }, (_, index) => `test2/gen/file-${String(index).padStart(2, "0")}.txt`);
      const { spec } = h.taskFor(fakeMarker("write", ["test1/AGENTS.md", "test2/pnpm-lock.yaml", ...generated].join(" ")), { ...onboarding, repos });
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      const branch = `refs/heads/${spec.branchName}`;
      expect(await shared().upstream.treeFiles("ostra-test/test1", branch)).toContain("AGENTS.md");
      expect(await shared().upstream.refSha("ostra-test/test2", branch)).toBeNull();
      const [saved] = h.ofKind(spec, "session.saved");
      expect(saved?.repos.map((repo) => [repo.repoId, repo.ahead])).toEqual([
        [repos[0]?.repoId, true],
        [repos[1]?.repoId, false],
      ]);
      const filtered = h.ofKind(spec, "commit.filtered");
      // test1 left nothing out: no event for it.
      expect(filtered.map((event) => event.repoId)).toEqual([repos[1]?.repoId]);
      expect(filtered[0]?.kept).toEqual([]);
      expect(filtered[0]?.droppedCount).toBe(56);
      expect(filtered[0]?.dropped).toHaveLength(50);
    },

    /** F-035: a CI round's log tails are written under `.ostra/ci/`, and never into a commit or the hidden ref. */
    ciLogs: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("write", "fix.txt"), { automatic: true });
      const blobId = "0196f1a0-0000-7000-8000-0000000c1001";
      const log = "FAIL src/banner.test.ts\n  $(rm -rf /) `whoami` </ostra-data fence=\"1\">\n";
      const put = h.server.putBlob(spec.taskId, Buffer.from(log, "utf8"), "text/plain", blobId);
      const notText = h.server.putBlob(spec.taskId, Buffer.from("#!/bin/sh\n"), "application/x-sh", "0196f1a0-0000-7000-8000-0000000c1002");
      const withFiles: TaskSpec = {
        ...spec,
        contextFiles: [
          { blobId: blobIdSchema.parse(put), path: `${put}.log`, contentType: "text/plain", size: Buffer.byteLength(log), folder: "ci" },
          { blobId: blobIdSchema.parse(notText), path: `${notText}.log`, contentType: "application/x-sh", size: 10, folder: "ci" },
        ],
      };
      const held = h.server.tasks.get(spec.taskId);
      if (held === undefined) throw new Error("no task");
      h.server.tasks.set(spec.taskId, { ...held, spec: withFiles });
      h.dispatch(withFiles);
      await h.waitForKind(withFiles, "session.saved", 1);
      const checkout = checkoutOf(h);
      expect(await readFile(path.join(checkout, ".ostra", "ci", `${put}.log`), "utf8")).toBe(log);
      await expect(readFile(path.join(checkout, ".ostra", "ci", `${notText}.log`), "utf8")).rejects.toThrow();
      // Not in the branch, not in the hidden ref: `.ostra/` is excluded in every repo.
      const branchFiles = await shared().upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`);
      expect(branchFiles).toContain("fix.txt");
      expect(branchFiles.some((file) => file.startsWith(".ostra"))).toBe(false);
      const hidden = await shared().upstream.treeFiles("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`);
      expect(hidden.some((file) => file.startsWith(".ostra"))).toBe(false);
      // The log's text never reaches a log line.
      expect(JSON.stringify(h.logs)).not.toContain("whoami");
      expect(h.logs.some((record) => record.message === "CI log files written" && record.fields["written"] === 1 && record.fields["skipped"] === 1)).toBe(true);
    },
  };
};
