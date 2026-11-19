import { taskIdSchema } from "@ostra/protocol";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  closedCallTotals,
  countLines,
  countRows,
  judgeAgentEnvironment,
  judgePullRequest,
  judgeStoppedMidTurn,
  judgeStoppedRefs,
  judgeTokenCounts,
  MAIN_REFUSAL,
  OTHER_REPO_REFUSAL,
  refusedBy,
  titleFromPrompt,
  unexplainedNames,
} from "./checks.ts";
import type { PullRequestExpectation } from "./checks.ts";

// A query result as `pg` returns it: only the rows matter to `countRows`.
const result = (rows: readonly unknown[]): pg.QueryResult => ({ rows: [...rows], command: "SELECT", rowCount: rows.length, oid: 0, fields: [] });

describe("countRows", () => {
  it("reads the count of a row", () => {
    expect(countRows(result([{ n: 3 }]))).toBe(3);
    expect(countRows(result([{ n: "0" }]))).toBe(0);
  });

  it("fails on a row that isn't a count, instead of returning NaN", () => {
    expect(() => countRows(result([]))).toThrow();
    expect(() => countRows(result([{ n: "many" }]))).toThrow();
    expect(() => countRows(result([{ other: 1 }]))).toThrow();
  });
});

describe("refusedBy", () => {
  it("needs the proxy's own words, not just a failed push", () => {
    expect(refusedBy({ code: 1, output: "remote: ostra: only the task's branch and its hidden ref can be pushed" }, MAIN_REFUSAL)).toBe(true);
    expect(refusedBy({ code: 1, output: "fatal: unable to access: Could not resolve host" }, MAIN_REFUSAL)).toBe(false);
    expect(refusedBy({ code: 1, output: "remote: Permission denied (GitHub's own refusal)" }, OTHER_REPO_REFUSAL)).toBe(false);
  });

  it("is not satisfied by the words on a push that succeeded", () => {
    expect(refusedBy({ code: 0, output: "ostra: this task's proxy serves only the task's own repos" }, OTHER_REPO_REFUSAL)).toBe(false);
  });
});

describe("titleFromPrompt", () => {
  it("takes the first non-empty line, one space between words", () => {
    expect(titleFromPrompt("\n  Add a   CONTRIBUTING.md \nwith more")).toBe("Add a CONTRIBUTING.md");
  });

  it("cuts at 120 characters", () => {
    expect(titleFromPrompt("x".repeat(200))).toBe(`${"x".repeat(117)}...`);
  });
});

const expected: PullRequestExpectation = {
  botLogin: "ostra-sandbox[bot]",
  adminUsername: "admin",
  publicUrl: "http://localhost:3000/",
  taskId: taskIdSchema.parse("01a1f107-8cda-731b-8a2a-2d5f46ba29e3"),
  prompt: "Add a CONTRIBUTING.md",
};
const bot = { name: "ostra-sandbox[bot]", email: "123+ostra-sandbox[bot]@users.noreply.github.com" };
const goodPull = { title: "Add a CONTRIBUTING.md", body: "Done.\n\nhttp://localhost:3000/tasks/01a1f107-8cda-731b-8a2a-2d5f46ba29e3", user: { login: "ostra-sandbox[bot]" } };
const goodCommit = { commit: { message: "Add it\n\nCo-authored-by: admin <admin@example.com>\n", author: bot, committer: bot } };

describe("judgePullRequest", () => {
  it("passes a PR the bot opened, with the admin as co-author, the prompt as title and the task linked", () => {
    expect(judgePullRequest(goodPull, [goodCommit], expected).ok).toBe(true);
  });

  it("fails a PR opened by someone else", () => {
    const result = judgePullRequest({ ...goodPull, user: { login: "a-person" } }, [goodCommit], expected);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("a-person");
  });

  it("fails a commit authored or committed by anyone but the bot", () => {
    const person = { name: "ostra", email: "ostra@ostra.dev" };
    expect(judgePullRequest(goodPull, [{ commit: { ...goodCommit.commit, author: person } }], expected).detail).toContain("author isn't the bot");
    expect(judgePullRequest(goodPull, [{ commit: { ...goodCommit.commit, committer: person } }], expected).detail).toContain("committer isn't the bot");
  });

  it("fails a commit with no co-author trailer for the admin", () => {
    const result = judgePullRequest(goodPull, [{ commit: { ...goodCommit.commit, message: "Add it\n\nCo-authored-by: someone <s@example.com>" } }], expected);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Co-authored-by admin");
  });

  it("fails another title, a body without the task's link, and a PR with no commits", () => {
    expect(judgePullRequest({ ...goodPull, title: "Something else" }, [goodCommit], expected).ok).toBe(false);
    expect(judgePullRequest({ ...goodPull, body: "Done." }, [goodCommit], expected).detail).toContain("doesn't link the task");
    expect(judgePullRequest({ ...goodPull, body: null }, [goodCommit], expected).ok).toBe(false);
    expect(judgePullRequest(goodPull, [], expected).ok).toBe(false);
  });

  it("fails an answer that isn't a PR", () => {
    expect(judgePullRequest({ nope: 1 }, [goodCommit], expected).ok).toBe(false);
  });
});

describe("closedCallTotals", () => {
  it("sums every call but the last, which OpenCode hasn't closed while its tool runs", () => {
    expect(closedCallTotals([{ input: 4035, output: 87 }, { input: 140, output: 224 }, { input: 173, output: 173 }])).toEqual({ input: 4175, output: 311 });
  });

  it("has nothing to compare with one call or none", () => {
    expect(closedCallTotals([{ input: 10, output: 1 }])).toBeNull();
    expect(closedCallTotals([])).toBeNull();
  });
});

describe("unexplainedNames", () => {
  const selfSet = { OPENCODE_CLIENT: "acp", NO_PROXY: "127.0.0.1,localhost,::1" };
  const environment = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("accounts for what the agent sets itself, with the agent's own value", () => {
    expect(unexplainedNames(environment({ PATH: "p", OPENCODE_CLIENT: "acp", NO_PROXY: "127.0.0.1,localhost,::1" }), ["PATH"], selfSet)).toEqual([]);
  });

  it("names a self-set variable whose value the launch changed, and any other stray name", () => {
    expect(unexplainedNames(environment({ PATH: "p", NO_PROXY: "proxy.internal,127.0.0.1,localhost,::1", AWS_KEY: "x" }), ["PATH"], selfSet)).toEqual([
      "AWS_KEY",
      "NO_PROXY",
    ]);
  });
});

describe("judgeStoppedMidTurn", () => {
  it("passes one stopped session and no PR", () => {
    expect(judgeStoppedMidTurn({ sessionStates: ["stopped"], pullRequests: 0 }).ok).toBe(true);
  });

  it("fails a session that ended on its own, as when the agent moved its command to the background", () => {
    expect(judgeStoppedMidTurn({ sessionStates: ["ended"], pullRequests: 1 }).ok).toBe(false);
    expect(judgeStoppedMidTurn({ sessionStates: ["ended"], pullRequests: 0 }).ok).toBe(false);
  });

  it("fails a stopped session whose branch got a PR anyway, or no session at all", () => {
    expect(judgeStoppedMidTurn({ sessionStates: ["stopped"], pullRequests: 1 }).ok).toBe(false);
    expect(judgeStoppedMidTurn({ sessionStates: [], pullRequests: 0 }).ok).toBe(false);
  });
});

describe("judgeStoppedRefs", () => {
  const ten = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n");

  it("passes when both refs exist and the hidden ref holds the ten lines", () => {
    expect(judgeStoppedRefs({ branch: "ostra/x", branchRefs: 1, hiddenRefs: 1, wipFile: `${ten}\n` }).ok).toBe(true);
  });

  it("fails a hidden ref that exists without the file, or with another number of lines", () => {
    expect(judgeStoppedRefs({ branch: "ostra/x", branchRefs: 1, hiddenRefs: 1, wipFile: null }).ok).toBe(false);
    expect(judgeStoppedRefs({ branch: "ostra/x", branchRefs: 1, hiddenRefs: 1, wipFile: "one\ntwo\n" }).ok).toBe(false);
  });

  it("fails a missing branch or hidden ref", () => {
    expect(judgeStoppedRefs({ branch: "ostra/x", branchRefs: 0, hiddenRefs: 1, wipFile: ten }).ok).toBe(false);
    expect(judgeStoppedRefs({ branch: "ostra/x", branchRefs: 1, hiddenRefs: 0, wipFile: null }).ok).toBe(false);
  });
});

describe("countLines", () => {
  it("counts the lines that hold something", () => {
    expect(countLines("a\r\n\r\nb\n  \nc")).toBe(3);
  });
});

describe("judgeTokenCounts", () => {
  it("passes counts within 2% of the agent's", () => {
    expect(judgeTokenCounts({ input: 10_100, output: 2000 }, { input: 10_000, output: 1990 }).ok).toBe(true);
  });

  it("fails counts more than 2% apart, on either side", () => {
    expect(judgeTokenCounts({ input: 10_500, output: 2000 }, { input: 10_000, output: 2000 }).ok).toBe(false);
    expect(judgeTokenCounts({ input: 10_000, output: 1000 }, { input: 10_000, output: 2000 }).ok).toBe(false);
  });

  it("fails when the agent's figure can't be read, and on zero output", () => {
    expect(judgeTokenCounts({ input: 1, output: 1 }, null).ok).toBe(false);
    expect(judgeTokenCounts({ input: 0, output: 0 }, { input: 0, output: 0 }).ok).toBe(false);
  });
});

describe("judgeAgentEnvironment", () => {
  it("passes an agent with only allowed names and no secret", () => {
    expect(judgeAgentEnvironment({ launches: 1, outside: [], leaking: 0 }).ok).toBe(true);
  });

  it("fails when no agent was found, a name is outside the list, or a value holds a secret", () => {
    expect(judgeAgentEnvironment({ launches: 0, outside: [], leaking: 0 }).ok).toBe(false);
    const outside = judgeAgentEnvironment({ launches: 1, outside: ["AWS_SECRET"], leaking: 0 });
    expect(outside.ok).toBe(false);
    expect(outside.detail).toContain("AWS_SECRET");
    expect(judgeAgentEnvironment({ launches: 1, outside: [], leaking: 1 }).ok).toBe(false);
  });
});
