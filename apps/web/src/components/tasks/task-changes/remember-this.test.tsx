import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommentBlock } from "./diff-view";
import type { DiffCommentView } from "./diff-words";

// F-111 (ticket 38): "Remember this" on a sent diff comment (growing app-targets/m3/task-changes).

const sent: DiffCommentView = {
  id: "01900000-0000-7000-8000-0000000000c1",
  taskRepoId: "01900000-0000-7000-8000-0000000000c2",
  path: "scripts/release.sh",
  side: "new",
  line: 12,
  headSha: "a".repeat(40),
  body: "Print a newline at the end of script output",
  state: "sent",
  author: "Sam Rivera",
  at: Date.UTC(2026, 10, 19, 12),
  outdated: null,
};
const noop = (): void => undefined;
const propose = () => Promise.resolve({ kind: "proposed" as const });

describe("Remember this (F-111)", () => {
  it("F-111/c1: a sent diff comment offers Remember this; a draft doesn't, nor a page that can't propose", () => {
    expect(renderToStaticMarkup(<CommentBlock comment={sent} onEdit={noop} onDelete={noop} onRemember={propose} />)).toContain('data-action="remember-this"');
    expect(renderToStaticMarkup(<CommentBlock comment={{ ...sent, state: "draft" }} onEdit={noop} onDelete={noop} onRemember={propose} />)).not.toContain("remember-this");
    expect(renderToStaticMarkup(<CommentBlock comment={sent} onEdit={noop} onDelete={noop} />)).not.toContain("remember-this");
  });
});
