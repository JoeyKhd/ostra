import { repoFullNameSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { TinyCodeHost } from "../test-adapters/tiny-adapters.ts";
import { FakeCiHost } from "../testing/fake-ci-host.ts";
import { logTail } from "./base.ts";
import type { CodeHostAdapter, CommentReviewInput, RepoAccess } from "./base.ts";

// Milestone 6 (ticket 03, ADR 0028): ostra's review is a comment and nothing else. The type keeps
// a caller from asking for an approval or a change request, and the fake host refuses one that
// gets past the type; and a CI log's tail is cut the same way by every adapter.

const repo = repoFullNameSchema.parse("test-org/test1");
const app = { appId: "42", privateKey: "-----BEGIN TEST KEY-----", slug: "ostra-tiny", name: "ostra tiny" };
const access: RepoAccess = { app: { appId: app.appId, privateKey: app.privateKey }, installationId: "7", repo };

const fakeHost = async () => {
  const ci = new FakeCiHost();
  const host = new TinyCodeHost({ app, installationId: "7", repos: [{ hostRepoId: "1001", fullName: repo, defaultBranch: "main", files: {}, branches: ["main", "ostra/task"] }] }, { ci });
  const opened = await host.openPullRequest({ access, head: "ostra/task", base: "main", title: "Task", body: "", draft: false });
  if (!opened.ok) throw new Error(opened.error.message);
  ci.setDiff(repo, opened.value.number, [{ path: "src/a.ts", new: [{ start: 1, end: 3 }], old: [] }]);
  return { host, ci, number: opened.value.number };
};

describe("a comment-type review", () => {
  it("F-100/c4: the interface takes COMMENT and nothing else: APPROVE and REQUEST_CHANGES don't compile, and the fake host refuses them at runtime, posting nothing", async () => {
    const { host, ci, number } = await fakeHost();
    const comment: CommentReviewInput = { commitId: "1".repeat(40), body: "One nit", event: "COMMENT", comments: [{ path: "src/a.ts", line: 2, side: "new", body: "A nit" }] };
    // @ts-expect-error An approval isn't a comment-type review (ADR 0028).
    const approve: CommentReviewInput = { ...comment, event: "APPROVE" };
    // @ts-expect-error Nor is a change request.
    const requestChanges: CommentReviewInput = { ...comment, event: "REQUEST_CHANGES" };
    for (const refused of [approve, requestChanges]) {
      expect(await host.createReview(access, number, refused)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
    expect(ci.reviews(repo, number)).toEqual([]);
    expect(await host.listReviews(access, number)).toEqual({ ok: true, value: [] });
    const posted = await host.createReview(access, number, comment);
    expect(posted.ok).toBe(true);
    // Posted as the App's bot, it's a `commented` review, which never counts as an approval (F-104).
    expect(await host.listReviews(access, number)).toMatchObject({ ok: true, value: [{ state: "commented", isBot: true }] });
  });

  it("F-100/c4: a host without comment-type reviews says unsupported, and the base class can't be asked for another event either", async () => {
    const host: CodeHostAdapter = new TinyCodeHost({ app, installationId: "7", repos: [{ hostRepoId: "1001", fullName: repo, defaultBranch: "main", files: {}, branches: ["main"] }] });
    expect(host.capabilities.reviewComments).toBe(false);
    expect(await host.createReview(access, 1, { commitId: "1".repeat(40), body: "x", event: "COMMENT", comments: [] })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});

describe("a CI log's tail", () => {
  it("F-035/c1: keeps at most the cap from the end, cut on a whole character, with the size before the cut", () => {
    const text = `start\n${"x".repeat(20)}\nend: café ✓`;
    const size = new TextEncoder().encode(text).length;
    expect(logTail(text, size)).toEqual({ text, truncated: false, totalBytes: size });
    for (let cap = 1; cap < size; cap += 1) {
      const tail = logTail(text, cap);
      expect(tail.truncated).toBe(true);
      expect(tail.totalBytes).toBe(size);
      expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(cap);
      expect(text.endsWith(tail.text)).toBe(true);
      expect(tail.text).not.toContain("�");
    }
    // The check mark is 3 bytes: a cap of 2 can't hold it, so the tail is empty, never half a character.
    expect(logTail(text, 2).text).toBe("");
    expect(logTail(text, 3).text).toBe("✓");
  });
});
