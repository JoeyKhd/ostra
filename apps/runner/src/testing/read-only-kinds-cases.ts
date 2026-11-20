import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fakeMarker, fakeToolArgs, sampleDraft, sampleReview, toolSetsByKind } from "@ostra/adapter-sdk/testing";
import { gitShaSchema, repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { expect } from "vitest";
import { startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "./task-host-harness.ts";

// Ticket 22 (F-099, F-100, Q221): a refine or a review task on one executor, with the scripted fake agent,
// the real git proxy and the git upstream stub. The agent's push and hidden-ref push are refused by
// the proxy before anything reaches the upstream; the runner itself pushes nothing after a turn,
// though the session archive still goes up; a review task's repos sit at the given heads, detached,
// with the base fetched; and the agent's `submit_draft` and `submit_review` reach the fake core.
// The same cases run on `host` (`read-only-kinds.host.test.ts`) and on `docker` as a box's sidecar
// drives it (`read-only-kinds.docker.test.ts`): the proxy and the tools are the sidecar's there.

export type ReadOnlyKindsMode = {
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

const memoryWithTools = { block: "## Memory\n\nNo notes yet.", indexNoteIds: [], alwaysNoteIds: [], omitted: 0, tools: true };

export const readOnlyKindsCases = (mode: ReadOnlyKindsMode) => {
  let current: Shared | undefined;
  let harness: Harness | undefined;
  const shared = (): Shared => {
    if (current === undefined) {
      throw new Error("the cases' setup didn't run");
    }
    return current;
  };

  const bareOf = (name: string): string => path.join(shared().root, "upstream", "repos", "ostra-test", `${name}.git`);

  /** A commit on a PR's head, pushed to the upstream only as `refs/pull/<number>/head`, as GitHub keeps a fork's PR. */
  const pullHead = async (name: string, prNumber: number, file: string): Promise<{ readonly baseSha: string; readonly headSha: string }> => {
    const work = await mkdtemp(path.join(shared().root, `pr-${name}-`));
    await git(shared().root, "clone", "--quiet", bareOf(name), work);
    const baseSha = await git(work, "rev-parse", "HEAD");
    await writeFile(path.join(work, file), `Changed for #${String(prNumber)}.\n`);
    await git(work, "add", "--all");
    await git(work, "-c", "user.name=Member", "-c", "user.email=member@example.test", "commit", "--quiet", "-m", "the PR's change");
    const headSha = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", "origin", `HEAD:refs/pull/${String(prNumber)}/head`);
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { baseSha, headSha };
  };

  /** The requests the upstream took for a repo since `from`. */
  const upstreamSince = (from: number, name: string): readonly string[] =>
    shared().upstream.requests.slice(from).flatMap((request) => (request.repo === `ostra-test/${name}` ? [request.endpoint] : []));

  const start = async (): Promise<Harness> => {
    harness = await startHarness(shared(), mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor });
    return harness;
  };

  return {
    setup: async (): Promise<void> => {
      current = await startShared(`read-only-${mode.name}`);
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
    /** F-099: a refine task's push and hidden-ref push from the agent's shell are refused before anything reaches the fake upstream */
    refinePushRefused: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("say", "ready"), { kind: "refine", tools: [...toolSetsByKind.refine] });
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      const mark = shared().upstream.requests.length;
      h.steer(spec, fakeMarker("git-push", `. ${spec.branchName}`));
      await h.waitForKind(spec, "session.saved", 2);
      h.steer(spec, fakeMarker("git-push", `. refs/ostra/wip/${spec.taskId}`));
      await h.waitForKind(spec, "session.saved", 3);
      expect(said(h, spec).match(/push refused/g) ?? []).toHaveLength(2);
      // The git proxy refused both at its door: the upstream saw nothing of either push.
      expect(upstreamSince(mark, "test1")).toEqual([]);
      expect(await shared().upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBeNull();
      expect(await shared().upstream.refSha("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toBeNull();
      // The proxy logged each refusal by its code.
      expect(h.logs.filter((record) => record.fields["code"] === "read-only").length).toBeGreaterThanOrEqual(2);
    },
    /** F-099: the runner pushes nothing after a refine turn that changed files, and the session archive still goes up */
    refinePushesNothing: async (): Promise<void> => {
      const h = await start();
      const { spec } = h.taskFor(fakeMarker("write", "prototype.txt"), { kind: "refine", tools: [...toolSetsByKind.refine] });
      const mark = shared().upstream.requests.length;
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      h.steer(spec, fakeMarker("write", "second-prototype.txt"));
      await h.waitForKind(spec, "session.saved", 2);
      for (const saved of h.ofKind(spec, "session.saved")) {
        expect(saved.repos).toEqual([{ repoId: spec.repos[0]?.repoId, headSha: null, ahead: false, hiddenRefSha: null }]);
        expect(saved.archive).not.toBeNull();
      }
      expect(h.kinds(spec)).not.toContain("git.pushed");
      // The clone's fetches only: no push of the branch or the hidden ref was even tried.
      expect(upstreamSince(mark, "test1").filter((endpoint) => endpoint !== "info/refs" && endpoint !== "git-upload-pack")).toEqual([]);
      expect(h.logs.some((record) => record.message === "push refused" || record.message === "hidden ref saved" || record.message === "pushed")).toBe(false);
      expect(await shared().upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBeNull();
      expect(await shared().upstream.refSha("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toBeNull();
      // The session ends without changes: no PR for a refine task.
      h.stop(spec);
      await h.idle();
      expect(h.kinds(spec)).not.toContain("session.crashed");
    },
    /** F-100: a review task's repos sit at the given heads, detached, with the base fetched, and the runner pushes nothing */
    reviewAtHeads: async (): Promise<void> => {
      const h = await start();
      const one = await pullHead("test1", 7, "banner.ts");
      const two = await pullHead("test2", 8, "api.ts");
      const base = h.taskFor("unused").spec.repos[0];
      if (base === undefined) throw new Error("no repo in the fixture");
      const repos = [repoOf(base, "test1"), repoOf(base, "test2")];
      const [first, second] = repos;
      if (first === undefined || second === undefined) throw new Error("two repos");
      const mark = shared().upstream.requests.length;
      const { spec } = h.taskFor(fakeMarker("heads", "test1 test2"), {
        kind: "review",
        tools: [...toolSetsByKind.review],
        repos,
        review: {
          codeTaskId: taskIdSchema.parse("0196f1a0-code-task-under-review"),
          round: 1,
          repos: [
            { repoId: first.repoId, prNumber: 7, baseSha: gitShaSchema.parse(one.baseSha), headSha: gitShaSchema.parse(one.headSha) },
            { repoId: second.repoId, prNumber: 8, baseSha: gitShaSchema.parse(two.baseSha), headSha: gitShaSchema.parse(two.headSha) },
          ],
        },
      });
      h.dispatch(spec);
      await h.waitForKind(spec, "session.saved", 1);
      // The agent starts at the workspace root, and reads each repo at its PR's head.
      expect(said(h, spec)).toContain(`test1 ${one.headSha}`);
      expect(said(h, spec)).toContain(`test2 ${two.headSha}`);
      const root = h.launches[0]?.cwd;
      if (root === undefined) throw new Error("no launch");
      for (const [name, pr] of [["test1", one], ["test2", two]] as const) {
        const checkout = path.join(root, name);
        expect(await git(checkout, "rev-parse", "HEAD")).toBe(pr.headSha);
        expect(await git(checkout, "rev-parse", "refs/ostra/review-base")).toBe(pr.baseSha);
        // Detached: there's no branch to commit on.
        await expect(git(checkout, "symbolic-ref", "--quiet", "HEAD")).rejects.toThrow();
      }
      const [saved] = h.ofKind(spec, "session.saved");
      expect(saved?.repos.every((repo) => !repo.ahead && repo.headSha === null && repo.hiddenRefSha === null)).toBe(true);
      expect(h.kinds(spec)).not.toContain("git.pushed");
      for (const name of ["test1", "test2"]) {
        expect(upstreamSince(mark, name).filter((endpoint) => endpoint === "git-receive-pack")).toEqual([]);
      }
    },
    /** F-099, F-100: the agent's submit_draft and submit_review reach the fake core with the task's token */
    toolsReachCore: async (): Promise<void> => {
      const h = await start();
      const refine = h.taskFor(fakeMarker("submit-draft", fakeToolArgs(sampleDraft)), { kind: "refine", tools: [...toolSetsByKind.refine], memory: memoryWithTools });
      h.dispatch(refine.spec);
      await h.waitForKind(refine.spec, "session.saved", 1);
      expect(said(h, refine.spec)).toContain("submit_draft: Draft version 1 is saved.");
      expect(h.server.team.drafts.map((draft) => [draft.taskId, draft.body])).toEqual([[refine.spec.taskId, sampleDraft]]);
      // A refusal reaches the agent in the protocol's words.
      h.server.team.refusals.draft = { code: "limit-reached" };
      h.steer(refine.spec, fakeMarker("submit-draft", fakeToolArgs(sampleDraft)));
      await h.waitForKind(refine.spec, "session.saved", 2);
      expect(said(h, refine.spec)).toContain("submit_draft: This task has handed in as many drafts as it may.");
      expect(h.server.team.drafts).toHaveLength(1);

      const review = h.taskFor(fakeMarker("submit-review", fakeToolArgs(sampleReview(repoFullNameSchema.parse("ostra-test/test1")))), {
        kind: "review",
        tools: [...toolSetsByKind.review],
        memory: memoryWithTools,
      });
      h.dispatch(review.spec);
      await h.waitForKind(review.spec, "session.saved", 1);
      expect(said(h, review.spec)).toContain("submit_review: The review is saved.");
      expect(h.server.team.reviews.map((each) => [each.taskId, each.body.findings.map((finding) => finding.repoId)])).toEqual([
        [review.spec.taskId, [review.spec.repos[0]?.repoId, review.spec.repos[0]?.repoId]],
      ]);
      // A code task is offered neither tool: its call never reaches core.
      const code = h.taskFor(fakeMarker("submit-review", fakeToolArgs(sampleReview(repoFullNameSchema.parse("ostra-test/test1")))), { memory: memoryWithTools });
      h.dispatch(code.spec);
      await h.waitForKind(code.spec, "session.saved", 1);
      expect(h.server.team.reviews).toHaveLength(1);
      // Neither text reached a log line.
      const logged = JSON.stringify(h.logs);
      expect(logged).not.toContain("banner shows");
      expect(logged).not.toContain("whoami");
    },
  };
};
