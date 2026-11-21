import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { diffCommentIdSchema, markedBlock } from "@ostra/protocol";

import { MessageIntentMark, SentDiffCommentsContext, sentBySeq, UserMessageText } from "./diff-comments-message";
import type { SentDiffComments } from "./diff-comments-message";

// F-072 (ticket 46; task-changes.md, "In the Activity tab"): the message "Send 2 comments to the
// agent" writes is the agent's prompt, each comment fenced as data. The thread draws it from the
// comments it carried instead: `{n} comments on the diff`, then each `{path}:{line}`, the quoted
// line and the comment. Sending them is the browser's (`e2e/21-task-changes.spec.ts`).

const seq = 12;
const prompt = [
  "A member left 2 comments on your changes. Address each one, then say what you changed.",
  "1. Line 2 of the file in this block:",
  markedBlock("diff-location", "fake-org/test1 src/calc.ts"),
  markedBlock("diff-lines", '+export const name = "calc";'),
  markedBlock("diff-comment", "Keep the old name exported for a release."),
  "2. Line 3 of the file in this block:",
  markedBlock("diff-location", "fake-org/test1 README.md"),
  markedBlock("diff-comment", "Say what it calculates."),
].join("\n\n");

const listed = [
  { commentId: diffCommentIdSchema.parse("0196f1a0-0000-7000-8000-000000000021"), path: "src/calc.ts", line: 2, quoted: { kind: "add" as const, text: 'export const name = "calc";' }, body: "Keep the old name exported for a release.", sentInSeq: seq },
  { commentId: diffCommentIdSchema.parse("0196f1a0-0000-7000-8000-000000000022"), path: "README.md", line: 3, quoted: { kind: "context" as const, text: "A calculator." }, body: "Say what it calculates.", sentInSeq: seq },
  // A draft carries no message, and another message's comment isn't this one's.
  { commentId: diffCommentIdSchema.parse("0196f1a0-0000-7000-8000-000000000023"), path: "README.md", line: 4, quoted: null, body: "Still a draft.", sentInSeq: null },
  { commentId: diffCommentIdSchema.parse("0196f1a0-0000-7000-8000-000000000024"), path: "README.md", line: 5, quoted: null, body: "Sent earlier.", sentInSeq: 7 },
];

const render = (sent: SentDiffComments, node: ReactNode): string => renderToStaticMarkup(<SentDiffCommentsContext.Provider value={sent}>{node}</SentDiffCommentsContext.Provider>);

describe("a diff-comments message in the thread (F-072)", () => {
  it("F-072/c1: the thread draws the comments a message carried, by its sequence, and never its fenced prompt", () => {
    const sent = sentBySeq(listed);
    const body = render(sent, <UserMessageText text={prompt} intent="diff-comments" seq={seq} />);
    expect(body).not.toContain("ostra-data");
    expect(body).not.toContain("Address each one");
    expect(body).toContain('data-part="diff-comments"');
    expect(body).toContain("src/calc.ts:2");
    expect(body).toContain("+ export const name = &quot;calc&quot;;");
    expect(body).toContain("Keep the old name exported for a release.");
    expect(body).toContain("README.md:3");
    expect(body).toContain("A calculator.");
    expect(body).not.toContain("Still a draft.");
    expect(body).not.toContain("Sent earlier.");
    expect(render(sent, <MessageIntentMark intent="diff-comments" seq={seq} />)).toContain("2 comments on the diff");

    // Until the comments are read, the header keeps the intent's tag and the body stays empty.
    expect(render(null, <UserMessageText text={prompt} intent="diff-comments" seq={seq} />)).toBe("");
    expect(render(null, <MessageIntentMark intent="diff-comments" seq={seq} />)).toContain("from diff comments");

    // Any other member message is its own text.
    expect(render(sent, <UserMessageText text="Rename it back." intent={undefined} seq={3} />)).toContain("Rename it back.");
  });
});
