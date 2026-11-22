import type { RepoFullName } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { readTreeRefusal } from "../code-host/base.ts";
import type {
  RepoTree,
  TreeLimits,
  InstallationAccess,
  AppManifest,
  AppOwner,
  BranchRules,
  CheckRunInput,
  CiResults,
  DiffFileLines,
  RequestedReviewers,
  ReviewLineComment,
  CodeHostAdapter,
  CodeHostWebhookEvent,
  CodeHostAppCredentials,
  CodeHostOAuthClient,
  CommentRef,
  LinkedUser,
  PullRequestReview,
  RepoAccess,
  WebhookInput,
} from "../code-host/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";
import {
  fakeTreeBytes,
  movedSkillTree,
  privateSkillTree,
  SKILL_FOLDER,
  SKILL_TREE_BYTE_CAP,
  SKILL_TREE_TAG,
  skillFolderFiles,
  skillTree,
} from "./fake-repo-trees.ts";
import type { FakeTree } from "./fake-repo-trees.ts";

// The cases every code host adapter passes (ADR 0025, spec section 8): against a fake host, and,
// gated on `github.env` and `github-test.env`, against `ostra-test/test1`.

export type CodeHostFixture = {
  readonly app: CodeHostAppCredentials;
  /** An App the host refuses: its credentials are wrong. */
  readonly wrongApp: CodeHostAppCredentials;
  readonly installationId: string;
  readonly access: RepoAccess;
  readonly defaultBranch: string;
  /** A file that exists at the default branch, with its content. */
  readonly file: { readonly path: string; readonly content: string };
  readonly missingPath: string;
  /** The repo's PR template, or `null` when it has none. */
  readonly prTemplate: string | null;
  /**
   * A branch, ahead of the default branch, that the suite may open a PR from. `null` skips the PR
   * cases. The factory's `dispose` closes the PR and deletes the branch.
   */
  readonly prHead: string | null;
  /** A webhook signed with its secret; the suite checks it and a tampered copy. */
  readonly webhook: WebhookInput;
  // ---- milestone 2: absent, the case is skipped (an adapter adds them as it builds each one) ----
  /** Branches with known rules, and what `readBranchRules` must answer for each. */
  readonly branchRules?: readonly { readonly branch: string; readonly expected: Omit<BranchRules, "reasons"> }[];
  /** A signed `pull_request` webhook, and the PR it's about. */
  readonly pullRequestWebhook?: { readonly input: WebhookInput; readonly number: number; readonly state: "open" | "closed" | "merged" };
  /** A ref the suite may delete, such as a hidden ref made for it. */
  readonly deletableRef?: string;
  // ---- milestone 3: absent, the case is skipped; without the capability, the call must be `unsupported` ----
  /** Pairs of a base and a head the host knows, with their counts, and a file over the host's patch limit. */
  readonly compare?: {
    readonly ahead: ComparePair;
    readonly behind: ComparePair;
    readonly diverged: ComparePair;
    /** A pair whose `path` is over the patch limit, and which changes more files than the host lists. */
    readonly truncated: { readonly base: string; readonly head: string; readonly path: string };
  };
  /** Signed webhooks of the three new kinds, and what each must read as. */
  readonly commentWebhooks?: {
    readonly issueComment: { readonly input: WebhookInput; readonly number: number; readonly commentId: string; readonly authorId: string; readonly body: string };
    readonly reviewComment: {
      readonly input: WebhookInput;
      readonly number: number;
      readonly commentId: string;
      readonly path: string;
      readonly line: number;
      readonly side: "old" | "new";
    };
    readonly push: { readonly input: WebhookInput; readonly ref: string; readonly after: string; readonly changedPaths: readonly string[] };
  };
  /** A comment the suite may react to. */
  readonly comment?: CommentRef;
  /** The App's OAuth client, a sign-in's code and the account it stands for, and the host's count of revoked tokens. */
  readonly userLink?: {
    readonly client: CodeHostOAuthClient;
    readonly code: string;
    readonly redirectUri: string;
    readonly user: LinkedUser;
    readonly revokedTokens: () => number;
    /** Makes the host's next revocation fail. */
    readonly failNextRevocation: () => void;
  };
  // ---- milestone 4 (ticket 03, F-104) ----
  /** A PR whose reviews the fake holds, and what `listReviews` must answer, oldest first: a dismissal, a bot's and an approval among them. Absent: skipped. */
  readonly reviews?: { readonly number: number; readonly expected: readonly PullRequestReview[] };
  /** Heads to publish check runs on, and the fake's view of them. Absent: skipped. */
  readonly checkRuns?: {
    readonly headSha: string;
    readonly otherHeadSha: string;
    readonly read: (checkRunId: string) => Promise<CheckRunView | undefined>;
    /** How many runs the head has under the name. */
    readonly count: (headSha: string, name: string) => Promise<number>;
  };
  /** Signed `pull_request_review` webhooks (submitted, dismissed) and a `pull_request` `synchronize`. Absent: skipped. */
  readonly reviewWebhooks?: {
    readonly submitted: { readonly input: WebhookInput; readonly number: number; readonly headSha: string; readonly review: PullRequestReview };
    readonly dismissed: { readonly input: WebhookInput; readonly number: number; readonly reviewId: string };
    readonly synchronize: { readonly input: WebhookInput; readonly number: number; readonly headSha: string };
  };
  // ---- milestone 4 (ticket 47, F-136): installations on other accounts ----
  /** Reads the host's manifest format: whether it makes a public App, and the App's homepage. Absent: skipped. */
  readonly manifestVisibility?: (manifest: AppManifest["manifest"]) => { readonly public: boolean; readonly homepage: string };
  /** The App's owner, and an installation on another account than the owner's (a stranger's). Absent: skipped. */
  readonly installations?: {
    readonly owner: AppOwner;
    readonly stranger: { readonly installationId: string; readonly accountLogin: string; readonly accountId: string };
  };
  /** An installation the suite may remove, one the host never had, and how many removals reached the host. Absent: skipped. */
  readonly removal?: { readonly installationId: string; readonly unknownInstallationId: string; readonly calls: () => number };
  /**
   * Signed `installation` (created, deleted, suspend, unsuspend) and `installation_repositories`
   * (added, removed) webhooks, each with what it must read as. Absent: skipped.
   */
  readonly installationWebhooks?: readonly { readonly input: WebhookInput; readonly expected: InstallationEvent }[];
  // ---- milestone 6 (ticket 03, ADR 0058): absent, the case is skipped; without the capability, the call must be `unsupported` ----
  /** A head with other apps' check runs and statuses (a run that stays `queued`, a status that never completes), and what `listCiResults` reads. */
  readonly ci?: { readonly headSha: string; readonly expected: CiResults };
  /** Logs: a run with a long one (and a line no error may hold), one whose log expired, and a status. */
  readonly ciLogs?: {
    readonly checkRunId: string;
    readonly log: string;
    /** A line of the log that no error message, from any call, may carry. */
    readonly secretLine: string;
    readonly expiredCheckRunId: string;
    readonly status: { readonly headSha: string; readonly context: string; readonly words: string };
  };
  /** A PR with a diff: what `diffLines` reads, a comment on a line of it, one off it, and how to read a posted review's comments back. */
  readonly commentReview?: {
    readonly number: number;
    readonly headSha: string;
    readonly expectedLines: readonly DiffFileLines[];
    readonly onDiff: ReviewLineComment;
    readonly offDiff: ReviewLineComment;
    /** How many reviews the host holds on the PR, to see a refused one posted nothing. */
    readonly reviewCount: () => Promise<number>;
  };
  /** A PR with requested people and teams. */
  readonly requestedReviewers?: { readonly number: number; readonly expected: RequestedReviewers };
  /** A ref whose `CODEOWNERS` is in the host's first place, a ref with one only in a later place, and a ref with none. */
  readonly codeOwners?: {
    readonly first: { readonly ref: string; readonly text: string };
    readonly later: { readonly ref: string; readonly text: string };
    readonly none: string;
  };
  /** Signed `check_run`, `check_suite`, `status` and `pull_request` review-request webhooks, and what each reads as. */
  readonly ciWebhooks?: readonly { readonly input: WebhookInput; readonly expected: Extract<CodeHostWebhookEvent, { readonly kind: "ci" | "pull_request_reviewers" }> }[];
  // ---- milestone 8 (ticket 02, F-145, ADR 0069): absent, the cases are skipped; without `readTree`, both calls must be `unsupported` ----
  /**
   * The repos of `createFakeRepoTrees`: the public one holding `skillTree` on `branch`, with the
   * tag `SKILL_TREE_TAG` on that commit, and the private one the installation covers.
   */
  readonly trees?: {
    readonly publicRepo: RepoFullName;
    readonly branch: string;
    readonly privateRepo: RepoFullName;
    /** Pushes `movedSkillTree` to the public repo's `branch` as a new commit, once. */
    readonly moveBranch: () => Promise<void>;
  };
};

/** Milestone 4 (F-136): the two installation webhooks, as the suite expects them read. */
export type InstallationEvent = Extract<CodeHostWebhookEvent, { readonly kind: "installation" | "installation_repositories" }>;

/** Every action the suite needs an installation webhook for, as `<kind>:<action>`. */
export const installationWebhookActions = [
  "installation:created",
  "installation:deleted",
  "installation:suspend",
  "installation:unsuspend",
  "installation_repositories:added",
  "installation_repositories:removed",
] as const;

/** Milestone 4: a check run as the fake host holds it, for the suite to read back. */
export type CheckRunView = CheckRunInput & { readonly checkRunId: string };

/** A check run's first state, as the review check publishes it on a new head (ADR 0040). */
export const checkRunInput = (headSha: string, name: string): CheckRunInput => ({
  name,
  headSha,
  status: "in_progress",
  conclusion: null,
  title: "Waiting for an independent reviewer",
  summary: "A member who didn't drive the task approves the PR's current head.",
  externalId: `suite:${name}`,
});

/** A base and a head the host can compare, and the counts it must report. */
export type ComparePair = { readonly base: string; readonly head: string; readonly aheadBy: number; readonly behindBy: number };

export const defineCodeHostContractSuite = (options: ContractSuiteOptions<CodeHostAdapter, CodeHostFixture>): void => {
  describe(`code host contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "code-host", {
      checkRuns: "boolean",
      prTemplates: "boolean",
      lfsActionHosts: "array",
      branchRules: "boolean",
      compare: "boolean",
      draftPullRequests: "boolean",
      prComments: "boolean",
      userLink: "boolean",
      reviews: "boolean",
      installableByOtherAccounts: "boolean",
      ciResults: "boolean",
      ciLogs: "boolean",
      reviewComments: "boolean",
      requestedReviewers: "boolean",
      codeOwners: "boolean",
      readTree: "boolean",
    });

    // ---- milestone 8 (ticket 02, F-145, ADR 0069): a repo's files at a commit ----
    // The cases read the tag, which never moves, except the last, which moves the branch.

    /** The caps when a case isn't testing them: wide open. */
    const wide: TreeLimits = { maxFiles: 1000, maxBytes: 16 * 1024 * 1024 };
    const decoded = (tree: RepoTree, path: string): string | undefined => {
      const found = tree.files.find((candidate) => candidate.path === path);
      return found === undefined ? undefined : new TextDecoder().decode(found.bytes);
    };
    const contentOf = (tree: FakeTree, path: string): string => {
      const entry = tree[path];
      if (entry?.kind !== "file") throw new Error(`the fake tree has no file ${path}`);
      return new TextDecoder().decode(fakeTreeBytes(entry));
    };
    /** The commit a ref names, or the case fails. */
    const commitOf = async (adapter: CodeHostAdapter, repo: RepoFullName, ref: string, access: InstallationAccess | null = null): Promise<string> => {
      const resolved = await adapter.resolveRef(access, repo, ref);
      if (!resolved.ok || resolved.value === null) throw new Error(`${ref} didn't resolve`);
      return resolved.value.commit;
    };

    it("F-145/c1: a host without readTree declares it, both calls refuse, and an install through it is refused with the reason", async () => {
      const { adapter, fixture } = subject();
      const refusal = readTreeRefusal(adapter);
      if (adapter.capabilities.readTree) {
        expect(refusal).toBeNull();
        return;
      }
      expect(refusal).toContain(adapter.name);
      const repo = fixture.trees?.publicRepo ?? fixture.access.repo;
      expect(await adapter.resolveRef(null, repo, "main")).toEqual({ ok: false, error: { code: "unsupported", message: refusal } });
      expect(await adapter.readTree(fixture.access, repo, "a".repeat(40), "", wide)).toEqual({ ok: false, error: { code: "unsupported", message: refusal } });
    });

    it("F-145/c1: resolves a branch, a tag and a commit to the commit they name, anonymously on a public repo, and a ref that doesn't exist to none", async (context) => {
      const { adapter, fixture } = subject();
      const trees = fixture.trees;
      if (!adapter.capabilities.readTree || trees === undefined) {
        context.skip();
        return;
      }
      const commit = await commitOf(adapter, trees.publicRepo, trees.branch);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(await adapter.resolveRef(null, trees.publicRepo, SKILL_TREE_TAG)).toEqual({ ok: true, value: { commit } });
      expect(await adapter.resolveRef(null, trees.publicRepo, commit)).toEqual({ ok: true, value: { commit } });
      expect(await adapter.resolveRef(null, trees.publicRepo, "no-such-branch")).toEqual({ ok: true, value: null });
      expect(await adapter.resolveRef(null, trees.publicRepo, "f".repeat(40))).toEqual({ ok: true, value: null });
    });

    it("F-145/c1: reads a skill's folder at a commit: repo-relative paths inside it, sizes and modes, a link inside followed and one leaving it noted", async (context) => {
      const { adapter, fixture } = subject();
      const trees = fixture.trees;
      if (!adapter.capabilities.readTree || trees === undefined) {
        context.skip();
        return;
      }
      const commit = await commitOf(adapter, trees.publicRepo, SKILL_TREE_TAG);
      const read = await adapter.readTree(null, trees.publicRepo, commit, SKILL_FOLDER, wide);
      if (!read.ok) throw new Error(read.error.message);
      const tree = read.value;
      expect(tree.files.map((file) => file.path)).toEqual([...skillFolderFiles]);
      expect(tree.truncated).toBe(false);
      expect(tree.notes).toEqual([{ path: "skills/pdf/style.md", reason: "symlink-outside" }]);
      expect(decoded(tree, "skills/pdf/SKILL.md")).toBe(contentOf(skillTree, "skills/pdf/SKILL.md"));
      // The link inside the folder is its target's bytes; the one leaving it never brings the outside file in.
      expect(decoded(tree, "skills/pdf/forms.md")).toBe(contentOf(skillTree, "skills/pdf/reference.md"));
      expect(tree.files.some((file) => decoded(tree, file.path) === contentOf(skillTree, "skills/shared/style.md"))).toBe(false);
      for (const file of tree.files) {
        expect(file.size, file.path).toBe(file.bytes.length);
        expect(file.mode, file.path).toBe(file.path === "skills/pdf/scripts/extract.py" ? "executable" : "regular");
      }
      // The whole repo, for finding its skills: every `SKILL.md`, at every depth.
      const whole = await adapter.readTree(null, trees.publicRepo, commit, "", wide);
      if (!whole.ok) throw new Error(whole.error.message);
      expect(whole.value.files.map((file) => file.path).filter((path) => path.endsWith("SKILL.md"))).toEqual([
        "skills/archive/old/v1/legacy/SKILL.md",
        "skills/pdf/SKILL.md",
        "skills/team/web/review/SKILL.md",
        "writer/SKILL.md",
      ]);
      // A folder is no way out: `..`, an absolute path and a backslash are refused before any call.
      for (const unsafe of ["../other", "skills/../..", "/etc", "skills\\pdf"]) {
        expect(await adapter.readTree(null, trees.publicRepo, commit, unsafe, wide), unsafe).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
      // A tree is read at a commit, never at a branch's name.
      expect(await adapter.readTree(null, trees.publicRepo, trees.branch, SKILL_FOLDER, wide)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("F-145/c1: the caps truncate while reading: past maxFiles reading stops, and a file over the bytes left is left out, each noted", async (context) => {
      const { adapter, fixture } = subject();
      const trees = fixture.trees;
      if (!adapter.capabilities.readTree || trees === undefined) {
        context.skip();
        return;
      }
      const commit = await commitOf(adapter, trees.publicRepo, SKILL_TREE_TAG);
      const fewer = await adapter.readTree(null, trees.publicRepo, commit, SKILL_FOLDER, { maxFiles: 2, maxBytes: wide.maxBytes });
      if (!fewer.ok) throw new Error(fewer.error.message);
      expect(fewer.value.files).toHaveLength(2);
      expect(fewer.value.truncated).toBe(true);
      // The first file past the cap is noted, and so is a link to a file reading stopped before.
      expect(fewer.value.notes.some((note) => note.reason === "over-max-files")).toBe(true);
      expect(fewer.value.notes.every((note) => note.reason === "over-max-files" || note.reason === "symlink-outside")).toBe(true);
      for (const file of fewer.value.files) {
        expect(skillFolderFiles).toContain(file.path);
      }
      const smaller = await adapter.readTree(null, trees.publicRepo, commit, SKILL_FOLDER, { maxFiles: wide.maxFiles, maxBytes: SKILL_TREE_BYTE_CAP });
      if (!smaller.ok) throw new Error(smaller.error.message);
      expect(smaller.value.truncated).toBe(true);
      expect(smaller.value.files.map((file) => file.path)).toEqual(skillFolderFiles.filter((path) => path !== "skills/pdf/assets/sample.pdf"));
      expect(smaller.value.notes).toContainEqual({ path: "skills/pdf/assets/sample.pdf", reason: "over-max-bytes" });
      expect(smaller.value.files.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(SKILL_TREE_BYTE_CAP);
      expect(await adapter.readTree(null, trees.publicRepo, commit, SKILL_FOLDER, { maxFiles: 0, maxBytes: 10 })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("F-145/c1: a private repo is refused without access, and read through the installation that covers it", async (context) => {
      const { adapter, fixture } = subject();
      const trees = fixture.trees;
      if (!adapter.capabilities.readTree || trees === undefined) {
        context.skip();
        return;
      }
      const access: InstallationAccess = { app: fixture.app, installationId: fixture.installationId };
      // Anonymously, a private repo is no repo at all, as the host answers.
      expect(await adapter.resolveRef(null, trees.privateRepo, "main")).toMatchObject({ ok: false, error: { code: "not-found" } });
      const commit = await commitOf(adapter, trees.privateRepo, "main", access);
      expect(await adapter.readTree(null, trees.privateRepo, commit, "", wide)).toMatchObject({ ok: false, error: { code: "not-found" } });
      const read = await adapter.readTree(access, trees.privateRepo, commit, "", wide);
      if (!read.ok) throw new Error(read.error.message);
      expect(read.value.files.map((file) => file.path)).toEqual(Object.keys(privateSkillTree));
      expect(decoded(read.value, "skills/internal/SKILL.md")).toBe(contentOf(privateSkillTree, "skills/internal/SKILL.md"));
      // A wrong App reads nothing.
      expect((await adapter.resolveRef({ app: fixture.wrongApp, installationId: fixture.installationId }, trees.privateRepo, "main")).ok).toBe(false);
    });

    it("F-145/c2: a tree read at a commit is the same after its branch moves on, and the new commit reads the push", async (context) => {
      const { adapter, fixture } = subject();
      const trees = fixture.trees;
      if (!adapter.capabilities.readTree || trees === undefined) {
        context.skip();
        return;
      }
      const pinned = await commitOf(adapter, trees.publicRepo, trees.branch);
      const first = await adapter.readTree(null, trees.publicRepo, pinned, SKILL_FOLDER, wide);
      await trees.moveBranch();
      const head = await commitOf(adapter, trees.publicRepo, trees.branch);
      expect(head).not.toBe(pinned);
      // The pin reads what it read before, byte for byte.
      const again = await adapter.readTree(null, trees.publicRepo, pinned, SKILL_FOLDER, wide);
      expect(again).toEqual(first);
      if (!again.ok) throw new Error(again.error.message);
      expect(decoded(again.value, "skills/pdf/SKILL.md")).toBe(contentOf(skillTree, "skills/pdf/SKILL.md"));
      expect(again.value.files.map((file) => file.path)).not.toContain("skills/pdf/signing.md");
      // The tag stays on the old commit too.
      expect(await adapter.resolveRef(null, trees.publicRepo, SKILL_TREE_TAG)).toEqual({ ok: true, value: { commit: pinned } });
      const moved = await adapter.readTree(null, trees.publicRepo, head, SKILL_FOLDER, wide);
      if (!moved.ok) throw new Error(moved.error.message);
      expect(decoded(moved.value, "skills/pdf/SKILL.md")).toBe(contentOf(movedSkillTree, "skills/pdf/SKILL.md"));
      expect(moved.value.files.map((file) => file.path)).toContain("skills/pdf/signing.md");
    });

    // ---- milestone 6 (ticket 03, ADR 0058): CI, comment-type reviews, reviewers and CODEOWNERS ----

    it("F-035: lists a head's check runs and statuses, other apps' included, a queued run and a status that never completes among them", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.ciResults) {
        expect(await adapter.listCiResults(fixture.access, "0".repeat(40))).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      const ci = fixture.ci;
      if (ci === undefined) {
        context.skip();
        return;
      }
      // The fixture must hold what the verdict reads past: another app's run left queued, and a status still pending.
      expect(ci.expected.checkRuns.some((run) => run.status === "queued")).toBe(true);
      expect(ci.expected.statuses.some((status) => status.state === "pending")).toBe(true);
      expect(new Set(ci.expected.checkRuns.map((run) => run.appSlug)).size).toBeGreaterThan(1);
      expect(await adapter.listCiResults(fixture.access, ci.headSha)).toEqual({ ok: true, value: ci.expected });
      expect(await adapter.listCiResults(fixture.access, "f".repeat(40))).toEqual({ ok: true, value: { checkRuns: [], statuses: [] } });
      expect((await adapter.listCiResults({ ...fixture.access, app: fixture.wrongApp }, ci.headSha)).ok).toBe(false);
    });

    it("F-035: reads a log's tail up to the cap, from the end, with its size; an expired log is none, with why; no log line reaches an error", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.ciLogs) {
        expect(await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: "1" }, 1024)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      const logs = fixture.ciLogs;
      if (logs === undefined) {
        context.skip();
        return;
      }
      const size = new TextEncoder().encode(logs.log).length;
      expect(size).toBeGreaterThan(64);
      const whole = await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: logs.checkRunId }, size + 10);
      expect(whole).toEqual({ ok: true, value: { found: true, text: logs.log, truncated: false, totalBytes: size } });
      const tail = await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: logs.checkRunId }, 64);
      if (!tail.ok || !tail.value.found) throw new Error("no tail");
      expect(tail.value).toMatchObject({ truncated: true, totalBytes: size });
      expect(new TextEncoder().encode(tail.value.text).length).toBeLessThanOrEqual(64);
      expect(logs.log.endsWith(tail.value.text)).toBe(true);
      expect(await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: logs.expiredCheckRunId }, 1024)).toEqual({
        ok: true,
        value: { found: false, reason: "expired" },
      });
      const status = await adapter.getCiLog(fixture.access, { kind: "status", headSha: logs.status.headSha, context: logs.status.context }, 4096);
      expect(status.ok && status.value.found && status.value.text).toContain(logs.status.words);
      // A refusal never carries the log: not for a bad cap, an unknown run or a stranger's App.
      for (const refused of [
        await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: logs.checkRunId }, 0),
        await adapter.getCiLog(fixture.access, { kind: "check-run", checkRunId: "404404" }, 1024),
        await adapter.getCiLog({ ...fixture.access, app: fixture.wrongApp }, { kind: "check-run", checkRunId: logs.checkRunId }, 1024),
      ]) {
        expect(refused.ok).toBe(false);
        expect(JSON.stringify(refused)).not.toContain(logs.secretLine);
      }
    });

    it("F-100: posts a comment-type review with line comments, and refuses a line off the diff by naming it, posting nothing", async (context) => {
      const { adapter, fixture } = subject();
      const review = fixture.commentReview;
      if (!adapter.capabilities.reviewComments) {
        const input = { commitId: "0".repeat(40), body: "Findings", event: "COMMENT", comments: [] } as const;
        expect(await adapter.createReview(fixture.access, review?.number ?? 1, input)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(await adapter.diffLines(fixture.access, review?.number ?? 1)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(await adapter.listReviewComments(fixture.access, review?.number ?? 1, "1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (review === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.diffLines(fixture.access, review.number)).toEqual({ ok: true, value: review.expectedLines });
      const before = await review.reviewCount();
      const refused = await adapter.createReview(fixture.access, review.number, {
        commitId: review.headSha,
        body: "Two findings",
        event: "COMMENT",
        comments: [review.onDiff, review.offDiff],
      });
      expect(refused).toMatchObject({ ok: false, error: { code: "line-outside-diff", commentIndex: 1 } });
      expect(await review.reviewCount()).toBe(before);
      const posted = await adapter.createReview(fixture.access, review.number, { commitId: review.headSha, body: "One finding", event: "COMMENT", comments: [review.onDiff] });
      if (!posted.ok) throw new Error(posted.error.message);
      expect(posted.value.url).toMatch(/^https:\/\//);
      expect(await review.reviewCount()).toBe(before + 1);
      const comments = await adapter.listReviewComments(fixture.access, review.number, posted.value.reviewId);
      expect(comments.ok && comments.value.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body }))).toEqual([review.onDiff]);
    });

    it("F-100: createReview refuses any event but COMMENT at runtime too: no approval, no change request", async (context) => {
      const { adapter, fixture } = subject();
      const review = fixture.commentReview;
      if (!adapter.capabilities.reviewComments || review === undefined) {
        context.skip();
        return;
      }
      const before = await review.reviewCount();
      for (const event of ["APPROVE", "REQUEST_CHANGES"] as const) {
        // @ts-expect-error The interface takes "COMMENT" and nothing else (ADR 0028).
        const input: Parameters<CodeHostAdapter["createReview"]>[2] = { commitId: review.headSha, body: "Looks good", event, comments: [] };
        expect(await adapter.createReview(fixture.access, review.number, input)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
      expect(await review.reviewCount()).toBe(before);
    });

    it("F-102: lists a PR's requested reviewers, people and teams", async (context) => {
      const { adapter, fixture } = subject();
      const requested = fixture.requestedReviewers;
      if (!adapter.capabilities.requestedReviewers) {
        expect(await adapter.listRequestedReviewers(fixture.access, requested?.number ?? 1)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (requested === undefined) {
        context.skip();
        return;
      }
      expect(requested.expected.users.length).toBeGreaterThan(0);
      expect(requested.expected.teams.length).toBeGreaterThan(0);
      expect(await adapter.listRequestedReviewers(fixture.access, requested.number)).toEqual({ ok: true, value: requested.expected });
      expect((await adapter.listRequestedReviewers(fixture.access, 404_404)).ok).toBe(false);
    });

    it("F-102: reads CODEOWNERS at a ref from the first place the host looks, a later place, or none", async (context) => {
      const { adapter, fixture } = subject();
      const owners = fixture.codeOwners;
      if (!adapter.capabilities.codeOwners) {
        expect(await adapter.readCodeOwners(fixture.access, fixture.defaultBranch)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (owners === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.readCodeOwners(fixture.access, owners.first.ref)).toEqual({ ok: true, value: owners.first.text });
      expect(await adapter.readCodeOwners(fixture.access, owners.later.ref)).toEqual({ ok: true, value: owners.later.text });
      expect(await adapter.readCodeOwners(fixture.access, owners.none)).toEqual({ ok: true, value: null });
    });

    it("F-035: reads the check_run, check_suite and status hints, and a review request's, from their signed webhooks", (context) => {
      const { adapter, fixture } = subject();
      const hooks = fixture.ciWebhooks;
      if (hooks === undefined) {
        context.skip();
        return;
      }
      const seen = new Set(hooks.map((hook) => (hook.expected.kind === "ci" ? hook.expected.event : hook.expected.action)));
      expect([...seen].sort()).toEqual(["check_run", "check_suite", "review_request_removed", "review_requested", "status"]);
      for (const hook of hooks) {
        expect(adapter.verifyWebhook(hook.input)).toBe(true);
        expect(adapter.parseWebhook(hook.input)).toEqual({ ok: true, value: hook.expected });
      }
    });

    it("builds a manifest that points the App's webhooks at the given address", () => {
      const { manifest, createUrl } = subject().adapter.appManifest({
        name: "ostra-contract",
        homepageUrl: "http://localhost:3000",
        webhookUrl: "https://example.com/hooks/abc",
        redirectUrl: "http://localhost:3000/setup/github/callback",
        ownerLogin: null,
      });
      expect(createUrl).toMatch(/^https:\/\//);
      expect(JSON.stringify(manifest)).toContain("https://example.com/hooks/abc");
    });

    it("reads the App, and refuses wrong credentials", async () => {
      const { adapter, fixture } = subject();
      const app = await adapter.readApp(fixture.app);
      expect(app).toMatchObject({ ok: true, value: { appId: fixture.app.appId } });
      const wrong = await adapter.readApp(fixture.wrongApp);
      expect(wrong).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    });

    it("lists the installation and its repo", async () => {
      const { adapter, fixture } = subject();
      const installations = await adapter.listInstallations(fixture.app);
      expect(installations.ok && installations.value.map((item) => item.installationId)).toContain(fixture.installationId);
      const repos = await adapter.listRepos(fixture.app, fixture.installationId);
      expect(repos.ok && repos.value.map((repo) => repo.fullName)).toContain(fixture.access.repo);
    });

    it("reads the default branch, files and the PR template", async () => {
      const { adapter, fixture } = subject();
      expect(await adapter.getDefaultBranch(fixture.access)).toEqual({ ok: true, value: fixture.defaultBranch });
      const files = await adapter.readFiles(fixture.access, fixture.defaultBranch, [fixture.file.path, fixture.missingPath]);
      expect(files).toEqual({ ok: true, value: { files: [fixture.file], missing: [fixture.missingPath] } });
      expect(await adapter.getPullRequestTemplate(fixture.access, fixture.defaultBranch)).toEqual({
        ok: true,
        value: fixture.prTemplate,
      });
    });

    it("mints a token for the one repo, with an expiry ahead", async () => {
      const { adapter, fixture } = subject();
      const token = await adapter.mintRepoToken(fixture.access, { contents: "write", metadata: "read" });
      expect(token.ok).toBe(true);
      if (token.ok) {
        expect(token.value.token.length).toBeGreaterThan(0);
        expect(token.value.expiresAt).toBeGreaterThan(Date.now());
      }
    });

    it("names the App's bot as the commit author", async () => {
      const { adapter, fixture } = subject();
      const bot = await adapter.getBotIdentity(fixture.app);
      expect(bot.ok && bot.value.name).toMatch(/\[bot\]$/);
    });

    it("opens a PR once: a second open is a conflict, and find returns it", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      expect(await adapter.findPullRequest(fixture.access, fixture.prHead)).toEqual({ ok: true, value: null });
      const input = {
        access: fixture.access,
        head: fixture.prHead,
        base: fixture.defaultBranch,
        title: "ostra contract suite",
        body: "Opened by the code host contract suite.",
        draft: false,
      };
      const opened = await adapter.openPullRequest(input);
      expect(opened).toMatchObject({ ok: true, value: { state: "open", headBranch: fixture.prHead } });
      expect(await adapter.openPullRequest(input)).toMatchObject({ ok: false, error: { code: "conflict" } });
      const found = await adapter.findPullRequest(fixture.access, fixture.prHead);
      expect(found.ok && found.value?.number).toBe(opened.ok ? opened.value.number : -1);
      // Milestone 2: the reconcile reads it back by number.
      if (opened.ok) {
        const byNumber = await adapter.getPullRequest(fixture.access, opened.value.number);
        if (!byNumber.ok && byNumber.error.code === "unsupported") {
          return;
        }
        expect(byNumber).toMatchObject({ ok: true, value: { number: opened.value.number, state: "open", merged: false } });
        expect(byNumber.ok && byNumber.value.headSha.length).toBeGreaterThan(0);
      }
    });

    it("reads a branch's protection and signed-commit rule (F-055, F-060)", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.branchRules) {
        expect(await adapter.readBranchRules(fixture.access, fixture.defaultBranch)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.branchRules === undefined) {
        context.skip();
        return;
      }
      for (const { branch, expected } of fixture.branchRules) {
        const rules = await adapter.readBranchRules(fixture.access, branch);
        expect(rules, branch).toMatchObject({ ok: true, value: expected });
        if (rules.ok && (rules.value.protected === "unknown" || rules.value.requiresSignedCommits === "unknown")) {
          expect(rules.value.reasons.length, "an unknown says why").toBeGreaterThan(0);
        }
      }
    });

    it("reads a pull_request webhook into its PR, and another event as other", (context) => {
      const { adapter, fixture } = subject();
      if (fixture.pullRequestWebhook === undefined) {
        context.skip();
        return;
      }
      const { input, number, state } = fixture.pullRequestWebhook;
      expect(adapter.verifyWebhook(input)).toBe(true);
      expect(adapter.parseWebhook(input)).toMatchObject({ ok: true, value: { kind: "pull_request", number, state } });
      // Milestone 3 reads `push` too, so the event no milestone reads is a star.
      const other = adapter.parseWebhook({ ...input, headers: { ...input.headers, "x-github-event": "star" } });
      expect(other).toMatchObject({ ok: true, value: { kind: "other" } });
    });

    it("deletes a ref once, and deleting it again isn't an error", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.deletableRef === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.deleteRef(fixture.access, fixture.deletableRef)).toEqual({ ok: true, value: { deleted: true } });
      expect(await adapter.deleteRef(fixture.access, fixture.deletableRef)).toEqual({ ok: true, value: { deleted: false } });
    });

    // ---------- milestone 3 (ADR 0051, ADR 0052) ----------

    it("F-027: compares an ahead, a behind and a diverged branch, with their counts", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.compare) {
        expect(await adapter.compare(fixture.access, "a", "b")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.compare === undefined) {
        context.skip();
        return;
      }
      for (const [name, pair] of Object.entries({ ahead: fixture.compare.ahead, behind: fixture.compare.behind, diverged: fixture.compare.diverged })) {
        const compared = await adapter.compare(fixture.access, pair.base, pair.head);
        expect(compared, name).toMatchObject({ ok: true, value: { aheadBy: pair.aheadBy, behindBy: pair.behindBy } });
        if (compared.ok) {
          expect(compared.value.limits.maxFiles).toBeGreaterThan(0);
          expect(compared.value.limits.maxPatchBytes).toBeGreaterThan(0);
        }
      }
      expect((await adapter.compare(fixture.access, "no-such-base", "no-such-head")).ok).toBe(false);
    });

    it("F-027: reports the host's limits: a file over the patch limit is truncated, and a long list is cut, never hidden", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.compare || fixture.compare === undefined) {
        context.skip();
        return;
      }
      const { base, head, path } = fixture.compare.truncated;
      const compared = await adapter.compare(fixture.access, base, head);
      if (!compared.ok) throw new Error(compared.error.message);
      const file = compared.value.files.find((candidate) => candidate.path === path);
      expect(file).toMatchObject({ truncated: true, patch: null });
      expect(compared.value.filesTruncated).toBe(true);
      expect(compared.value.files.length).toBeLessThanOrEqual(compared.value.limits.maxFiles);
      // Every other file's patch is whole.
      expect(compared.value.files.filter((candidate) => candidate.path !== path).every((candidate) => !candidate.truncated)).toBe(true);
    });

    it("F-054: makes a PR a draft and back", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.draftPullRequests) {
        expect(await adapter.setPullRequestDraft(fixture.access, 1, true)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      const existing = await adapter.findPullRequest(fixture.access, fixture.prHead);
      if (!existing.ok) throw new Error(existing.error.message);
      const pr =
        existing.value ??
        (await adapter.openPullRequest({ access: fixture.access, head: fixture.prHead, base: fixture.defaultBranch, title: "ostra contract suite", body: "x", draft: false }));
      const number = "number" in pr ? pr.number : pr.ok ? pr.value.number : -1;
      expect(await adapter.setPullRequestDraft(fixture.access, number, true)).toMatchObject({ ok: true, value: { number, draft: true } });
      expect(await adapter.setPullRequestDraft(fixture.access, number, false)).toMatchObject({ ok: true, value: { number, draft: false } });
      expect((await adapter.setPullRequestDraft(fixture.access, 999_999, true)).ok).toBe(false);
    });

    it("F-053: reads a PR comment, a line comment and a push from their signed webhooks, and refuses a bad signature", (context) => {
      const { adapter, fixture } = subject();
      const hooks = fixture.commentWebhooks;
      if (!adapter.capabilities.prComments || hooks === undefined) {
        context.skip();
        return;
      }
      for (const hook of [hooks.issueComment, hooks.reviewComment, hooks.push]) {
        expect(adapter.verifyWebhook(hook.input)).toBe(true);
        expect(adapter.verifyWebhook({ ...hook.input, body: `${hook.input.body} ` })).toBe(false);
      }
      expect(adapter.parseWebhook(hooks.issueComment.input)).toMatchObject({
        ok: true,
        value: {
          kind: "issue_comment",
          number: hooks.issueComment.number,
          onPullRequest: true,
          comment: { commentId: hooks.issueComment.commentId, authorId: hooks.issueComment.authorId, body: hooks.issueComment.body },
        },
      });
      expect(adapter.parseWebhook(hooks.reviewComment.input)).toMatchObject({
        ok: true,
        value: {
          kind: "pull_request_review_comment",
          number: hooks.reviewComment.number,
          path: hooks.reviewComment.path,
          line: hooks.reviewComment.line,
          side: hooks.reviewComment.side,
          comment: { commentId: hooks.reviewComment.commentId },
        },
      });
      const push = adapter.parseWebhook(hooks.push.input);
      expect(push).toMatchObject({ ok: true, value: { kind: "push", ref: hooks.push.ref, after: hooks.push.after } });
      if (push.ok && push.value.kind === "push") {
        expect([...(push.value.changedPaths ?? [])].sort()).toEqual([...hooks.push.changedPaths].sort());
      }
      // A body that isn't the event it says is refused, never read as something else.
      expect(adapter.parseWebhook({ ...hooks.push.input, body: "{}" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    });

    it("F-053: a reaction twice is one reaction", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.prComments) {
        expect(await adapter.addReaction(fixture.access, { kind: "issue", commentId: "1" }, "eyes")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (fixture.comment === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.addReaction(fixture.access, fixture.comment, "eyes")).toEqual({ ok: true, value: { created: true } });
      expect(await adapter.addReaction(fixture.access, fixture.comment, "eyes")).toEqual({ ok: true, value: { created: false } });
    });

    it("F-119: links a member's account, and revokes the sign-in's token before it answers", async (context) => {
      const { adapter, fixture } = subject();
      const link = fixture.userLink;
      if (!adapter.capabilities.userLink) {
        expect(adapter.userAuthorizeUrl({ clientId: "x", clientSecret: "y" }, "state", "https://x")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (link === undefined) {
        context.skip();
        return;
      }
      const url = adapter.userAuthorizeUrl(link.client, "state-123", link.redirectUri);
      expect(url.ok).toBe(true);
      if (url.ok) {
        const parsed = new URL(url.value);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.searchParams.get("state")).toBe("state-123");
        expect(parsed.searchParams.get("redirect_uri")).toBe(link.redirectUri);
        expect(url.value).not.toContain(link.client.clientSecret);
      }
      const before = link.revokedTokens();
      expect(await adapter.exchangeUserCode(link.client, link.code, link.redirectUri)).toEqual({ ok: true, value: link.user });
      expect(link.revokedTokens()).toBe(before + 1);
      // A revocation that fails is an error, never a link made with a live token.
      link.failNextRevocation();
      expect((await adapter.exchangeUserCode(link.client, link.code, link.redirectUri)).ok).toBe(false);
      expect(link.revokedTokens()).toBe(before + 1);
      expect((await adapter.exchangeUserCode(link.client, "a-wrong-code", link.redirectUri)).ok).toBe(false);
    });

    // ---- milestone 4 (ticket 03, F-104): reviews, check runs and PR bodies ----

    it("F-104: lists a PR's reviews oldest first, a dismissal and a bot's among them; a host without reviews says unsupported", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.reviews) {
        expect(await adapter.listReviews(fixture.access, fixture.reviews?.number ?? 1)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      const reviews = fixture.reviews;
      if (reviews === undefined) {
        context.skip();
        return;
      }
      // The fixture must hold what the check reads past: a dismissed review, a bot's, and an approval.
      expect(reviews.expected.some((review) => review.state === "dismissed")).toBe(true);
      expect(reviews.expected.some((review) => review.isBot)).toBe(true);
      expect(reviews.expected.some((review) => review.state === "approved")).toBe(true);
      expect(await adapter.listReviews(fixture.access, reviews.number)).toEqual({ ok: true, value: reviews.expected });
      expect(await adapter.listReviews({ ...fixture.access, app: fixture.wrongApp }, reviews.number)).toMatchObject({ ok: false });
    });

    it("F-104: publishes a check run once per head and name: a second publish answers the same run", async (context) => {
      const { adapter, fixture } = subject();
      const runs = fixture.checkRuns;
      const input = checkRunInput(runs?.headSha ?? "0".repeat(40), "ostra/independent-review");
      if (!adapter.capabilities.checkRuns) {
        expect(await adapter.publishCheckRun(fixture.access, input)).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (runs === undefined) {
        context.skip();
        return;
      }
      const first = await adapter.publishCheckRun(fixture.access, input);
      if (!first.ok) throw new Error(first.error.message);
      expect(await adapter.publishCheckRun(fixture.access, input)).toEqual(first);
      expect(await runs.count(runs.headSha, input.name)).toBe(1);
      // Another name on the same head is another run, and so is the same name on another head.
      const other = await adapter.publishCheckRun(fixture.access, { ...input, name: "ostra/another-check" });
      expect(other.ok && other.value.checkRunId).not.toBe(first.value.checkRunId);
      const otherHead = await adapter.publishCheckRun(fixture.access, { ...input, headSha: runs.otherHeadSha });
      expect(otherHead.ok && otherHead.value.checkRunId).not.toBe(first.value.checkRunId);
      expect(await runs.count(runs.headSha, input.name)).toBe(1);
    });

    it("F-104: updating a check run changes its status, conclusion and words, on its own head", async (context) => {
      const { adapter, fixture } = subject();
      const runs = fixture.checkRuns;
      if (!adapter.capabilities.checkRuns || runs === undefined) {
        context.skip();
        return;
      }
      const name = "ostra/updated-check";
      const published = await adapter.publishCheckRun(fixture.access, checkRunInput(runs.headSha, name));
      if (!published.ok) throw new Error(published.error.message);
      const id = published.value.checkRunId;
      expect(await runs.read(id)).toMatchObject({ name, headSha: runs.headSha, status: "in_progress", conclusion: null });
      const passed: CheckRunInput = { ...checkRunInput(runs.headSha, name), status: "completed", conclusion: "success", title: "Approved by an independent reviewer" };
      expect(await adapter.updateCheckRun(fixture.access, id, passed)).toEqual({ ok: true, value: undefined });
      expect(await runs.read(id)).toMatchObject({ name, headSha: runs.headSha, status: "completed", conclusion: "success", title: passed.title });
      const back: CheckRunInput = { ...checkRunInput(runs.headSha, name), status: "completed", conclusion: "action_required" };
      expect(await adapter.updateCheckRun(fixture.access, id, back)).toEqual({ ok: true, value: undefined });
      expect(await runs.read(id)).toMatchObject({ status: "completed", conclusion: "action_required" });
      // A second publish after the update answers the same run and leaves its state.
      expect(await adapter.publishCheckRun(fixture.access, checkRunInput(runs.headSha, name))).toEqual(published);
      expect(await runs.read(id)).toMatchObject({ conclusion: "action_required" });
    });

    it("F-104: a body update replaces the description and keeps the rest of the PR", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      const found = await adapter.findPullRequest(fixture.access, fixture.prHead);
      const pr = found.ok && found.value !== null
        ? found.value
        : await adapter.openPullRequest({ access: fixture.access, head: fixture.prHead, base: fixture.defaultBranch, title: "ostra contract suite", body: "Opened by the code host contract suite.", draft: false }).then((opened) => {
            if (!opened.ok) throw new Error(opened.error.message);
            return opened.value;
          });
      const body = "Opened by the code host contract suite.\n\nRelated: another repo's PR.";
      const updated = await adapter.updatePullRequestBody({ access: fixture.access, number: pr.number, body });
      if (!updated.ok && updated.error.code === "unsupported") {
        context.skip();
        return;
      }
      expect(updated).toMatchObject({ ok: true, value: { number: pr.number, title: pr.title, headBranch: pr.headBranch, baseBranch: pr.baseBranch, state: pr.state } });
      const read = await adapter.getPullRequest(fixture.access, pr.number);
      if (read.ok) {
        expect(read.value).toMatchObject({ number: pr.number, title: pr.title, headBranch: pr.headBranch, baseBranch: pr.baseBranch, state: pr.state });
        if (read.value.body !== undefined) {
          expect(read.value.body).toBe(body);
        }
      }
    });

    it("F-030/c2: a title update renames the PR and keeps the rest of it", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.prHead === null) {
        context.skip();
        return;
      }
      const found = await adapter.findPullRequest(fixture.access, fixture.prHead);
      const pr = found.ok && found.value !== null
        ? found.value
        : await adapter.openPullRequest({ access: fixture.access, head: fixture.prHead, base: fixture.defaultBranch, title: "ostra contract suite", body: "Opened by the code host contract suite.", draft: false }).then((opened) => {
            if (!opened.ok) throw new Error(opened.error.message);
            return opened.value;
          });
      const title = "Rename the PR from the contract suite";
      const renamed = await adapter.updatePullRequestTitle({ access: fixture.access, number: pr.number, title });
      if (!renamed.ok && renamed.error.code === "unsupported") {
        context.skip();
        return;
      }
      expect(renamed).toMatchObject({ ok: true, value: { number: pr.number, title, headBranch: pr.headBranch, baseBranch: pr.baseBranch, state: pr.state } });
      const read = await adapter.getPullRequest(fixture.access, pr.number);
      if (read.ok) {
        expect(read.value).toMatchObject({ number: pr.number, title, headBranch: pr.headBranch, state: pr.state });
      }
      // Back as it was, for the suite's other cases.
      expect((await adapter.updatePullRequestTitle({ access: fixture.access, number: pr.number, title: pr.title })).ok).toBe(true);
    });

    it("F-104: reads a review submitted and dismissed, and a new head, from their signed webhooks", (context) => {
      const { adapter, fixture } = subject();
      const hooks = fixture.reviewWebhooks;
      if (!adapter.capabilities.reviews || hooks === undefined) {
        context.skip();
        return;
      }
      expect(adapter.verifyWebhook(hooks.submitted.input)).toBe(true);
      expect(adapter.parseWebhook(hooks.submitted.input)).toMatchObject({
        ok: true,
        value: { kind: "pull_request_review", action: "submitted", number: hooks.submitted.number, headSha: hooks.submitted.headSha, review: hooks.submitted.review },
      });
      expect(adapter.parseWebhook(hooks.dismissed.input)).toMatchObject({
        ok: true,
        value: { kind: "pull_request_review", action: "dismissed", number: hooks.dismissed.number, review: { reviewId: hooks.dismissed.reviewId, state: "dismissed" } },
      });
      expect(adapter.parseWebhook(hooks.synchronize.input)).toMatchObject({
        ok: true,
        value: { kind: "pull_request", action: "synchronize", number: hooks.synchronize.number, headSha: hooks.synchronize.headSha },
      });
    });

    // ---- milestone 4 (ticket 47, F-136, ADR 0065): a public App, and installations on other accounts ----

    it("F-136: makes a private App by default and a public one when asked, and a public App's homepage isn't the install's address", (context) => {
      const { adapter, fixture } = subject();
      const read = fixture.manifestVisibility;
      if (read === undefined) {
        context.skip();
        return;
      }
      const input = {
        name: "ostra-contract",
        homepageUrl: "https://ostra.acme.example",
        webhookUrl: "https://ostra.acme.example/hooks/abc",
        redirectUrl: "https://ostra.acme.example/setup/github/callback",
        ownerLogin: null,
      };
      expect(read(adapter.appManifest(input).manifest)).toEqual({ public: false, homepage: input.homepageUrl });
      expect(read(adapter.appManifest({ ...input, public: false }).manifest)).toEqual({ public: false, homepage: input.homepageUrl });
      if (!adapter.capabilities.installableByOtherAccounts) {
        return;
      }
      const shown = read(adapter.appManifest({ ...input, public: true }).manifest);
      expect(shown.public).toBe(true);
      expect(shown.homepage).toMatch(/^https:\/\//);
      expect(shown.homepage).not.toContain("acme.example");
    });

    it("F-136: reads the App's owner, and each installation's account ID beside its login, a stranger's included", async (context) => {
      const { adapter, fixture } = subject();
      const known = fixture.installations;
      if (known === undefined) {
        context.skip();
        return;
      }
      expect(await adapter.readApp(fixture.app)).toMatchObject({ ok: true, value: { owner: known.owner } });
      const listed = await adapter.listInstallations(fixture.app);
      if (!listed.ok) throw new Error(listed.error.message);
      expect(listed.value.every((installation) => (installation.accountId ?? "").length > 0)).toBe(true);
      expect(listed.value).toContainEqual(expect.objectContaining({ installationId: fixture.installationId, accountLogin: known.owner.login, accountId: known.owner.accountId }));
      expect(listed.value).toContainEqual(expect.objectContaining(known.stranger));
    });

    it("F-136: removes an installation with one call, and an unknown one, or one already removed, is not-found", async (context) => {
      const { adapter, fixture } = subject();
      const removal = fixture.removal;
      if (!adapter.capabilities.installableByOtherAccounts) {
        expect(await adapter.removeInstallation(fixture.app, removal?.installationId ?? "1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      if (removal === undefined) {
        context.skip();
        return;
      }
      const before = removal.calls();
      expect(await adapter.removeInstallation(fixture.app, removal.installationId)).toEqual({ ok: true, value: undefined });
      expect(removal.calls()).toBe(before + 1);
      const listed = await adapter.listInstallations(fixture.app);
      expect(listed.ok && listed.value.map((installation) => installation.installationId)).not.toContain(removal.installationId);
      expect(await adapter.removeInstallation(fixture.app, removal.installationId)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.removeInstallation(fixture.app, removal.unknownInstallationId)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect((await adapter.removeInstallation(fixture.wrongApp, removal.unknownInstallationId)).ok).toBe(false);
    });

    it("F-136: reads the installation and installation_repositories webhooks, each with its installation and account", (context) => {
      const { adapter, fixture } = subject();
      const hooks = fixture.installationWebhooks;
      if (!adapter.capabilities.installableByOtherAccounts || hooks === undefined) {
        context.skip();
        return;
      }
      const covered = new Set(hooks.map(({ expected }) => `${expected.kind}:${expected.action}`));
      for (const action of installationWebhookActions) {
        expect(covered, `a webhook for ${action}`).toContain(action);
      }
      for (const { input, expected } of hooks) {
        expect(adapter.verifyWebhook(input), `${expected.kind}:${expected.action}`).toBe(true);
        expect(adapter.parseWebhook(input), `${expected.kind}:${expected.action}`).toEqual({ ok: true, value: expected });
      }
    });

    it("verifies a webhook's signature and refuses a tampered body", () => {
      const { adapter, fixture } = subject();
      expect(adapter.verifyWebhook(fixture.webhook)).toBe(true);
      expect(adapter.verifyWebhook({ ...fixture.webhook, body: `${fixture.webhook.body} ` })).toBe(false);
      expect(adapter.verifyWebhook({ ...fixture.webhook, secret: `${fixture.webhook.secret}x` })).toBe(false);
    });
  });
};
