import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { severalReposCases } from "../testing/several-repos-cases.ts";

// Milestone 4's ticket 21 (F-098) on the `host` executor: two bare repos side by side, behind the
// real git proxy. The same cases on `docker` are `several-repos.docker.test.ts`.

const cases = severalReposCases({ name: "host" });

beforeAll(cases.setup, 60_000);
afterAll(cases.teardown, 60_000);
afterEach(cases.cleanup, 120_000);

describe("several repos on host", () => {
  it("F-098/c1,c2: on host, both repos are checked out side by side on the task's one branch, the agent at the root told about both", cases.sideBySide, 240_000);
  it("F-098/c2: on host, a turn that changes one repo pushes that one, and the other gets no branch", cases.onePushesOne, 240_000);
  it("F-098/c2: on host, a turn that changes both repos pushes both, on the same branch", cases.bothPushBoth, 240_000);
  it("F-098/c3: on host, a reopen on a fresh worktree restores each repo from its own hidden ref, and clones a repo new to the task at its base", cases.reopenRestoresBoth, 300_000);
  it("F-098/c2: on host, the git proxy refuses a push to another task's branch in either repo, and takes the task's own", cases.proxyRefusesOtherBranch, 240_000);
  it("F-098/c1: on host, each repo is cloned with its own git token", cases.ownTokenPerRepo, 240_000);
  it("F-136/c10: on host, repos of two Apps are each committed by their own bot, the agent's commits and ostra's, with the member's trailer", cases.ownIdentityPerRepo, 240_000);
  it("F-078/c2: on host, a member's message mid-session puts their trailer on every later commit in each repo, the agent's own and ostra's, once each", cases.coAuthorFromMessage, 240_000);
  it("F-078/c2: on host, a message steered into a running turn credits its sender on that turn's commit", cases.coAuthorMidTurn, 240_000);
  it("F-098/c1: on host, each task's workspace holds its own repos and nothing of another task's", cases.containment, 240_000);
  it("F-098/c1: on host, instructions that name other folders than the spec's repos crash the session before anything is cloned", cases.foldersMustMatch, 240_000);
});
