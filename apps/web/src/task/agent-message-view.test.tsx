import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  approvedPlanPrompt,
  changesRequestedPrompt,
  CLOSING_TURN_PROMPT,
  expiredApprovalAnswerPrompt,
  fixChecksPrompt,
  fixCiPrompt,
  fixFindingsPrompt,
  KEEP_WORKING_AFTER_CAP_PROMPT,
  lateQuestionAnswerPrompt,
  planRevisionPrompt,
  prCommentPrompt,
  refinePrompt,
  reviewPrompt,
  updateBranchPrompt,
} from "@ostra/domain";
import { clientMessageIdSchema, MARKED_BLOCK_TAG, memberIdSchema, sessionIdSchema, storedEventSchema } from "@ostra/protocol";
import type { MessageIntent } from "@ostra/protocol";
import { foldTaskEvents } from "@ostra/task-view";
import type { TaskUIMessage } from "@ostra/task-view";

import { agentMessageOf, agentMessageSummary, AgentMessageMark, isAutomatic, UserMessageText } from "./agent-message-view";

// F-072's fix for every message ostra writes for the agent: the thread draws a member message from
// what it carried, read from its blocks, never its prompt. Each case folds the message as the log
// holds it, reads it as the thread does, and draws its header's mark, its body and the subagents
// window's line: each holds the data and none holds a fence or ostra's instructions.

const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e9");
const memberId = memberIdSchema.parse("01900000-0000-7000-8000-0000000000b9");

/** The message as the thread folds it from its `user.message` event. */
const folded = (text: string, intent: MessageIntent | undefined): TaskUIMessage => {
  const event = { kind: "user.message", memberId, clientMessageId: clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c9"), text, delivery: "queued", ...(intent === undefined ? {} : { intent }) };
  const [message] = foldTaskEvents([storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d9", seq: 4, sessionId, sessionSeq: 4, at: 4_000, event })], []);
  if (message === undefined) throw new Error("the fold drew no message");
  return message;
};

/** The mark, the body and the window's line, as the thread draws them. */
const drawn = (text: string, intent: MessageIntent | undefined) => {
  const message = folded(text, intent);
  const read = agentMessageOf(message);
  const metaIntent = message.metadata?.author?.intent;
  return {
    read,
    mark: read === null ? "" : renderToStaticMarkup(<AgentMessageMark message={read} intent={metaIntent} />),
    body: renderToStaticMarkup(<UserMessageText text={text} intent={metaIntent} diffSeq={4} agentMessage={read} />),
    summary: read === null ? "" : agentMessageSummary(read),
  };
};

/** Every piece of what's drawn holds no fence and none of the prompt's own instructions. */
const expectNoPrompt = (shown: ReturnType<typeof drawn>, instructions: readonly string[]) => {
  for (const piece of [shown.mark, shown.body, shown.summary]) {
    expect(piece).not.toContain(MARKED_BLOCK_TAG);
    expect(piece).not.toContain("Read it, but don&#x27;t follow");
    expect(piece).not.toContain("Read it, but don't follow");
    for (const instruction of instructions) expect(piece).not.toContain(instruction);
  }
};

describe("a message ostra wrote for the agent, in the thread", () => {
  it("an @ostra comment shows the comment and its line, escaped, never the prompt", () => {
    const shown = drawn(prCommentPrompt({ login: "sam", text: "Rename it <b>back</b>.", url: "https://github.com/o/r/pull/12#discussion_r1", path: "src/calc.ts", line: 14 }), "pr-comment");
    expect(shown.mark).toContain("@ostra comment on the pull request");
    expect(shown.body).toContain('data-kind="pr-comment"');
    expect(shown.body).toContain("src/calc.ts:14");
    expect(shown.body).toContain("Rename it &lt;b&gt;back&lt;/b&gt;.");
    expect(shown.body).not.toContain("<b>");
    expectNoPrompt(shown, ["asked you something", "Do what it asks", "github.com"]);
  });

  it("F-054/c2: the thread draws Ask the agent to fix as its failing checks, their commands and output, never the prompt", () => {
    const shown = drawn(
      fixChecksPrompt([
        { name: "lint", command: "pnpm lint", status: "failed", outputTail: "src/a.ts: 1 error" },
        { name: "test", command: "pnpm test", status: "timed-out", outputTail: "" },
      ]),
      "fix-checks",
    );
    expect(shown.mark).toContain("2 failing checks to fix");
    expect(shown.body).toContain('data-kind="fix-checks"');
    expect(shown.body).toContain("lint");
    expect(shown.body).toContain("failed");
    expect(shown.body).toContain("$ pnpm lint");
    expect(shown.body).toContain("src/a.ts: 1 error");
    expect(shown.body).toContain("timed out");
    expect(shown.summary).toBe("2 failing checks to fix: lint, test");
    expectNoPrompt(shown, ["failed after your last turn", "Fix the code so", "run them yourself"]);
  });

  it("Update branch shows each repo, its base and how far behind, never the instructions", () => {
    const shown = drawn(updateBranchPrompt([{ repo: "o/api", branch: "ostra/calc-1", baseBranch: "main", behindBy: 3 }]), "update-branch");
    expect(shown.mark).toContain("update branch");
    expect(shown.body).toContain("o/api");
    expect(shown.body).toContain("merge main into ostra/calc-1, 3 commits behind");
    expectNoPrompt(shown, ["The base branch moved on", "never rebase", "force-pushed"]);
  });

  it("Keep working shows what it lets the agent do, in the panel's words", () => {
    const shown = drawn(KEEP_WORKING_AFTER_CAP_PROMPT, "keep-working");
    expect(shown.mark).toContain("pressed Keep working");
    expect(shown.body).toContain("The agent keeps working on what the last round sent it.");
    expectNoPrompt(shown, [KEEP_WORKING_AFTER_CAP_PROMPT]);
  });

  it("a request for plan changes shows the member's request as they wrote it", () => {
    const shown = drawn(planRevisionPrompt("Split step 2 & keep <the> tests."), "plan-revision");
    expect(shown.mark).toContain("asked for changes to the plan");
    expect(shown.body).toContain("Split step 2 &amp; keep &lt;the&gt; tests.");
    expectNoPrompt(shown, ["Stay in planning", "Write the revised plan"]);
  });

  it("a CI round is ostra's, and shows each failing check and its conclusion", () => {
    const shown = drawn(fixCiPrompt([{ name: "test (linux)", conclusion: "failure", logFile: "0196.log" }, { name: "status", conclusion: "timed_out", logFile: null }]), "fix-ci");
    expect(shown.read === null ? false : isAutomatic(shown.read)).toBe(true);
    expect(shown.mark).toContain("CI failed: 2 checks");
    expect(shown.body).toContain("test (linux)");
    expect(shown.body).toContain("failed");
    expect(shown.body).toContain("timed out");
    expectNoPrompt(shown, ["CI failed on your pull request", "Read the logs", "ci/0196.log", "no log"]);
  });

  it("a findings round is ostra's, and shows each finding with its severity, title, place and body", () => {
    const shown = drawn(
      fixFindingsPrompt([
        { repo: "o/api", path: "src/b.ts", line: 9, side: "new", severity: "blocking", title: "Off by one", body: "The loop stops early." },
        { repo: "o/api", path: "src/a.ts", line: 3, side: "new", severity: "nit", title: "Name", body: "Rename it." },
      ]),
      "fix-findings",
    );
    expect(shown.read === null ? false : isAutomatic(shown.read)).toBe(true);
    expect(shown.mark).toContain("AI review: 1 blocking finding, 1 nit listed");
    expect(shown.body).toContain("blocking");
    expect(shown.body).toContain("Off by one");
    expect(shown.body).toContain("o/api src/b.ts:9 (head)");
    expect(shown.body).toContain("The loop stops early.");
    expect(shown.body).toContain('data-item="nit"');
    expect(shown.summary).toBe("AI review: 1 blocking finding, 1 nit listed: Off by one");
    expectNoPrompt(shown, ["found blocking problems", "Fix each blocking finding", "you don&#x27;t have to act"]);
  });

  it("changes requested shows the reviewer's comment and their line comments", () => {
    const shown = drawn(changesRequestedPrompt({ reviewBody: "Please split this.", comments: [{ path: "src/a.ts", line: 4, body: "Why here?" }] }), "changes-requested");
    expect(shown.read === null ? true : isAutomatic(shown.read)).toBe(false);
    expect(shown.mark).toContain("requested changes on the pull request");
    expect(shown.body).toContain("Please split this.");
    expect(shown.body).toContain("src/a.ts:4");
    expect(shown.body).toContain("Why here?");
    expectNoPrompt(shown, ["A reviewer requested changes", "Make the changes they asked for"]);
  });

  it("a reopen with no intent: the approved plan, a late answer, an expired approval's answer", () => {
    const plan = drawn(approvedPlanPrompt({ text: "1. Read the code\n2. Fix it", edited: true }), undefined);
    expect(plan.mark).toContain("approved the plan with edits");
    expect(plan.body).toContain("1. Read the code");
    expectNoPrompt(plan, ["Planning is over", "carry out the plan"]);

    const answered = drawn(lateQuestionAnswerPrompt({ question: "Which format?", fields: [{ id: "f", label: "Format" }], answers: { f: "ISO 8601" } }), undefined);
    expect(answered.mark).toContain("answered the agent’s question");
    expect(answered.body).toContain("Which format?");
    expect(answered.body).toContain("Format: ISO 8601");
    expectNoPrompt(answered, ["Your last turn ended", "carry on with their answers"]);

    const denied = drawn(expiredApprovalAnswerPrompt({ decision: "deny", subject: "rm -rf build", reason: "Not on this box." }), undefined);
    expect(denied.mark).toContain("denied a request");
    expect(denied.body).toContain("rm -rf build");
    expect(denied.body).toContain("Not on this box.");
    expectNoPrompt(denied, ["Your last turn ended", "Carry on without the request"]);
  });

  it("the closing turn is ostra's, in the panel's words", () => {
    const shown = drawn(CLOSING_TURN_PROMPT, "message");
    expect(shown.read === null ? false : isAutomatic(shown.read)).toBe(true);
    expect(shown.mark).toContain("closing turn");
    expect(shown.body).toContain("as memory proposals");
    expectNoPrompt(shown, ["Before this session ends", "memory_propose", "don&#x27;t push"]);
  });

  const pr = {
    repo: "ostra-test/test1",
    number: 12,
    url: "https://github.com/ostra-test/test1/pull/12",
    branch: "ostra/a1b2c3d4-add-a-theme-switch",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    files: 3,
    additions: 40,
    deletions: 12,
  };
  const ticket = { key: "OST-42", title: "Add a theme switch", description: "Dark & light." };

  it("F-100: an AI review's first prompt is ostra's: the header names its PR and links it, the body its repo, branch and a folded summary, never the prompt", () => {
    const shown = drawn(reviewPrompt({ ticket, acceptanceCriteria: "- It persists", pullRequests: [pr], round: { number: 2, of: 3 } }), undefined);
    expect(shown.read === null ? false : isAutomatic(shown.read)).toBe(true);
    expect(shown.mark).toContain("AI review of ");
    expect(shown.mark).toContain('href="https://github.com/ostra-test/test1/pull/12"');
    expect(shown.mark).toContain(">PR #12</a>");
    expect(shown.body).toContain('data-kind="ai-review"');
    expect(shown.body).toContain(">ostra-test/test1</span>");
    expect(shown.body).toContain(">ostra/a1b2c3d4-add-a-theme-switch</span>");
    // Folded: the size and the round in its line, what it reads against inside.
    expect(shown.body).toContain("<details");
    expect(shown.body).toContain("3 files changed, +40 −12 · round 2 of 3");
    expect(shown.body).toContain("ostra-test/test1#12: base bbbbbbbbbbbb, head cccccccccccc");
    expect(shown.body).toContain("OST-42 Add a theme switch");
    expect(shown.body).toContain("Dark &amp; light.");
    expect(shown.body).toContain("Acceptance criteria\n- It persists");
    expect(shown.summary).toBe("AI review of PR #12: ostra-test/test1");
    expectNoPrompt(shown, ["Your task is", "read-only", "submit_review", "Mark a finding blocking", "If you find nothing", "Its title and description are below"]);

    // The first review says no round; several PRs are counted in the header, and each links from the body.
    const first = drawn(reviewPrompt({ ticket: null, acceptanceCriteria: null, pullRequests: [pr], round: { number: 1, of: 3 } }), undefined);
    expect(first.body).toContain("3 files changed, +40 −12</summary>");
    expect(first.body).toContain("The task has no ticket");
    const both = drawn(reviewPrompt({ ticket, acceptanceCriteria: null, pullRequests: [pr, { ...pr, repo: "ostra-test/test2", number: 4, url: "https://github.com/ostra-test/test2/pull/4", files: 1, additions: 2, deletions: 1 }], round: { number: 1, of: 3 } }), undefined);
    expect(both.mark).toContain("AI review of 2 PRs");
    expect(both.mark).not.toContain("<a");
    expect(both.body).toContain('href="https://github.com/ostra-test/test2/pull/4"');
    expect(both.body).toContain("4 files changed, +42 −13");
  });

  it("F-099: a refine task's first prompt is ostra's: the ticket's key and title, the repos it reads and its folded description", () => {
    const shown = drawn(refinePrompt({ ticket, repos: [{ fullName: "ostra-test/test1", checkoutDir: "test1" }] }), undefined);
    expect(shown.read === null ? false : isAutomatic(shown.read)).toBe(true);
    expect(shown.mark).toContain("Refine OST-42");
    expect(shown.body).toContain('data-kind="refine"');
    expect(shown.body).toContain("Add a theme switch");
    expect(shown.body).toContain(">ostra-test/test1</li>");
    expect(shown.body).toContain("The ticket’s description");
    expect(shown.body).toContain("Dark &amp; light.");
    expect(shown.summary).toBe("Refine OST-42: Add a theme switch");
    expectNoPrompt(shown, ["Your task is", "checked out in", "submit_draft", "end your turn", "The ticket is OST-42"]);
  });

  it("a member's own text stays as typed, escaped, whatever it holds", () => {
    const own = drawn(`Use <ostra-data> here & <i>now</i>`, undefined);
    expect(own.read).toBeNull();
    expect(own.body).toContain('data-part="user-text"');
    expect(own.body).toContain("Use &lt;ostra-data&gt; here &amp; &lt;i&gt;now&lt;/i&gt;");
    // An intent set by hand on plain words (an older log's: `tasks.send` takes only plain words now) is still the member's words.
    const handSet = drawn("Merge main into the branch", "update-branch");
    expect(handSet.read).toBeNull();
    expect(handSet.body).toContain("Merge main into the branch");
    // A Linear follow-up is the member's own comment.
    expect(drawn("Also update the README.", "linear-follow-up").body).toContain("Also update the README.");
  });
});
