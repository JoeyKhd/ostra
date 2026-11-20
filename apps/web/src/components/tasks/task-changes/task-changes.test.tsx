import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { nextTabIndex } from "@/components/ui/underline-tabs";

import { DiffRowView, DiffView, escapeStep, fileHeaderOf, nextLineIndex } from "./diff-view";
import type { DiffActions } from "./diff-view";
import { aheadText, behindOf, changedFiles, draftsTitle, reviewHint, rowsOf, sendLabel, shortNames } from "./diff-words";
import type { DiffCommentView, DiffRepoView } from "./diff-words";
import { BehindLine, ChangesBody, FilesColumn, ReviewBar, middleTruncate } from "./task-changes";
import type { ChangesBodyProps, ReviewProps, UpdateBranchProps } from "./task-changes";

// F-027 (the diff), F-072 (diff comments), F-070 (update branch): the Changes tab's parts
// (task-changes.md, ADR 0051, ADR 0052), rendered as the panel renders them.

const noop = () => undefined;
const at = Date.UTC(2026, 10, 19, 9, 20);

const web: DiffRepoView = {
  taskRepoId: "r1",
  name: "calculator-web",
  branch: "ostra/calc-174-9f3c2a1b-keep-a-history",
  base: "main",
  ahead: 3,
  behind: 2,
  headSha: "7d41e0a9c1",
  state: {
    kind: "ready",
    filesTruncated: null,
    files: [
      {
        path: "src/calculator/state.ts",
        previousPath: null,
        status: "modified",
        additions: 24,
        deletions: 6,
        body: {
          kind: "hunks",
          hunks: [
            {
              header: "@@ -38,8 +38,14 @@ export const calculatorReducer",
              gapBefore: null,
              lines: [
                { kind: "context", old: 38, new: 38, text: '    case "evaluate": {' },
                { kind: "del", old: 40, text: "      return { ...state, result };" },
                { kind: "add", new: 40, text: "      const entry = { result, at: Date.now() }; // <script>alert(1)</script>" },
                { kind: "add", new: 41, text: "      return entry;" },
              ],
            },
            { header: "@@ -60,3 +66,3 @@", gapBefore: 18, lines: [{ kind: "context", old: 60, new: 66, text: "}" }, { kind: "no-newline" }] },
          ],
        },
      },
      { path: "src/history/store.ts", previousPath: "src/store.ts", status: "renamed", additions: 9, deletions: 2, body: { kind: "hunks", hunks: [] } },
      { path: "src/store.ts.bak", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, body: { kind: "renamed-only" } },
      { path: "public/history.svg", previousPath: null, status: "added", additions: 0, deletions: 0, body: { kind: "binary", url: "https://github.com/ostra-test/test1/compare#binary" } },
      { path: "pnpm-lock.yaml", previousPath: null, status: "modified", additions: 812, deletions: 40, body: { kind: "too-large", url: "https://github.com/ostra-test/test1/compare#lock" } },
    ],
  },
};
const api: DiffRepoView = {
  taskRepoId: "r2",
  name: "calculator-api",
  branch: "ostra/calc-174",
  base: "main",
  ahead: 1,
  behind: 0,
  headSha: "a41c9d2",
  state: { kind: "ready", filesTruncated: { shown: 300, url: "https://github.com/x" }, files: [{ path: "src/history/store.ts", previousPath: null, status: "modified", additions: 12, deletions: 3, body: { kind: "hunks", hunks: [] } }] },
};

const comment = (over: Partial<DiffCommentView> & Pick<DiffCommentView, "id" | "state">): DiffCommentView => ({
  taskRepoId: "r1",
  path: "src/calculator/state.ts",
  side: "new",
  line: 40,
  headSha: "7d41e0a9c1",
  body: "Call it createdAt, like the other stores.",
  author: "Alex Kim",
  at,
  outdated: null,
  ...over,
});
const sent = comment({ id: "c1", state: "sent", author: "Sam Rivera", body: "Keep the 50 in one constant <b>bold</b>" });
const draft = comment({ id: "c2", state: "draft", body: "Add a test for the 51st result." });
const outdated = comment({ id: "c3", state: "sent", author: "Sam Rivera", line: 52, headSha: "3be91f0aa", outdated: { sign: "-", text: "history.push(result);" }, body: "This keeps every result forever." });
const otherDraft = comment({ id: "c4", state: "draft", taskRepoId: "r2", path: "src/history/store.ts", line: 3 });

const actions: DiffActions = { onOpen: noop, onEdit: noop, onCancel: noop, onSave: () => Promise.resolve({ kind: "saved" }), onDelete: noop, onFold: noop };
const update: UpdateBranchProps = { state: { kind: "idle" }, driver: null, agent: "OpenCode", onUpdate: noop, onTakeOver: noop };
const review: ReviewProps = { delivery: { kind: "idle" }, agent: "OpenCode", state: { kind: "idle" }, onSend: noop, onTakeOver: noop, onSeeActivity: noop };
const body = (over: Partial<ChangesBodyProps> = {}): string =>
  renderToStaticMarkup(
    <ChangesBody
      load={{ kind: "ready", repos: [web, api], lastPushAt: at }}
      comments={[sent, draft, outdated, otherDraft]}
      canComment
      update={update}
      review={review}
      onSave={() => Promise.resolve({ kind: "saved" })}
      onDelete={noop}
      onUndoDelete={noop}
      initialHeight={4000}
      {...over}
    />,
  );

describe("the diff's rows", () => {
  it("F-027: a file's header, its hunks, the gap between them and its lines, in the files column's order", () => {
    const rows = rowsOf([web, api], [], new Set(), null);
    const kinds = rows.map((row) => row.kind);
    expect(kinds.slice(0, 9)).toEqual(["file", "hunk", "line", "line", "line", "line", "gap", "hunk", "line"]);
    const files = rows.flatMap((row) => (row.kind === "file" ? [row.file.path] : []));
    expect(files).toEqual(["src/calculator/state.ts", "src/history/store.ts", "src/store.ts.bak", "public/history.svg", "pnpm-lock.yaml", "src/history/store.ts"]);
    expect(rows.flatMap((row) => (row.kind === "note" ? [row.text] : []))).toEqual(["renamed-only", "binary", "too-large"]);
    expect(changedFiles([web, api])).toBe(6);
    expect(changedFiles([web, { ...api, state: { kind: "loading" } }])).toBeNull();
  });

  it("F-027: a folded file keeps only its header", () => {
    const rows = rowsOf([web], [], new Set(["r1:src/calculator/state.ts"]), null);
    expect(rows[0]?.kind).toBe("file");
    expect(rows[1]?.kind).toBe("file");
  });

  it("F-072: on a line, sent comments come first, then the viewer's drafts, then the open field; outdated ones go after the file's last hunk", () => {
    const rows = rowsOf([web], [draft, sent, outdated], new Set(), { kind: "new", target: { taskRepoId: "r1", path: "src/calculator/state.ts", side: "new", line: 40 } });
    const at40 = rows.findIndex((row) => row.kind === "line" && row.line.kind === "add" && row.line.new === 40);
    expect(rows.slice(at40 + 1, at40 + 4).map((row) => (row.kind === "comment" ? row.comment.id : row.kind))).toEqual(["c1", "c2", "field"]);
    const label = rows.findIndex((row) => row.kind === "outdated-label");
    const lastLine = rows.findLastIndex((row) => row.kind === "line" && row.path === "src/calculator/state.ts");
    expect(label).toBeGreaterThan(lastLine);
    expect(rows[label + 1]?.kind === "comment" && rows[label + 1]?.key.endsWith(":o:c3")).toBe(true);
  });

  it("F-102: an AI review's findings sit on their line before its comments, newest round first; off the diff at the file's top; outdated after its last hunk", () => {
    const finding = (id: string, line: number, round: number, state: "open" | "resolved" | "outdated" = "open") => ({ id, taskRepoId: "r1", path: "src/calculator/state.ts", side: "new" as const, line, state, round });
    const rows = rowsOf([web], [sent, draft], new Set(), null, [finding("f1", 40, 1, "resolved"), finding("f2", 40, 2), finding("f3", 99, 2), finding("f4", 41, 1, "outdated")]);
    const at40 = rows.findIndex((row) => row.kind === "line" && row.line.kind === "add" && row.line.new === 40);
    expect(rows.slice(at40 + 1, at40 + 5).map((row) => (row.kind === "finding" ? row.finding.id : row.kind === "comment" ? row.comment.id : row.kind))).toEqual(["f2", "f1", "c1", "c2"]);
    // Off the diff: under a label, right after the file's header.
    expect(rows.slice(1, 3).map((row) => (row.kind === "finding" ? row.finding.id : row.kind))).toEqual(["findings-label", "f3"]);
    const label = rows.findIndex((row) => row.kind === "outdated-label");
    expect(label).toBeGreaterThan(rows.findLastIndex((row) => row.kind === "line" && row.path === "src/calculator/state.ts"));
    expect(rows[label + 1]?.kind === "finding" ? rows[label + 1]?.key : null).toContain(":of:f4");
    // The Changes tab passes none: nothing changes.
    expect(rowsOf([web], [sent], new Set(), null).some((row) => row.kind === "finding" || row.kind === "findings-label")).toBe(false);
  });

  it("F-072: editing a draft swaps it for the field with its text", () => {
    const rows = rowsOf([web], [draft], new Set(), { kind: "edit", comment: draft });
    const field = rows.find((row) => row.kind === "field");
    expect(field?.kind === "field" ? field.editing?.id : null).toBe("c2");
    expect(rows.some((row) => row.kind === "comment" && row.comment.id === "c2")).toBe(false);
  });

  it("F-027: the sticky header and the roving focus find their rows", () => {
    const rows = rowsOf([web], [], new Set(), null);
    expect(fileHeaderOf(rows, 5)).toBe(0);
    expect(nextLineIndex(rows, 0, 1)).toBe(2);
    expect(nextLineIndex(rows, 2, -1)).toBeNull();
  });
});

describe("the diff's view", () => {
  it("F-027: lines draw their numbers, signs and diff colours, code as plain text", () => {
    const html = renderToStaticMarkup(<DiffView rows={rowsOf([web], [], new Set(), null)} canComment actions={actions} scrollTo={null} onTopFile={noop} initialHeight={4000} />);
    expect(html).toContain("@@ -38,8 +38,14 @@ export const calculatorReducer");
    expect(html).toContain("bg-diff-add");
    expect(html).toContain("bg-diff-del");
    expect(html).toContain("−");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("18 unchanged lines");
    expect(html).toContain("No newline at end of file");
    expect(html).toContain('aria-label="Comment on line 40"');
  });

  it("F-027: a rename shows where it came from; a binary and a too-large file show a note with GitHub's link", () => {
    const html = renderToStaticMarkup(<DiffView rows={rowsOf([web], [], new Set(), null)} canComment actions={actions} scrollTo={null} onTopFile={noop} initialHeight={4000} />);
    expect(html).toContain("← src/store.ts");
    expect(html).toContain("Renamed, no changes");
    expect(html).toContain("Binary file, not shown");
    expect(html).toContain("Too large to show here");
    expect(html).toContain('href="https://github.com/ostra-test/test1/compare#binary"');
  });

  it("F-027: the list is virtualized: a long diff draws only the rows in view", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => ({ kind: "add" as const, new: i + 1, text: `line ${String(i + 1)}` }));
    const big: DiffRepoView = { ...web, state: { kind: "ready", filesTruncated: null, files: [{ path: "big.ts", previousPath: null, status: "added", additions: 5000, deletions: 0, body: { kind: "hunks", hunks: [{ header: "@@ -0,0 +1,5000 @@", gapBefore: null, lines }] } }] } };
    const html = renderToStaticMarkup(<DiffView rows={rowsOf([big], [], new Set(), null)} canComment actions={actions} scrollTo={null} onTopFile={noop} initialHeight={400} />);
    const drawn = html.match(/data-line="/g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(100);
  });

  it("F-072: a sent comment, a draft with its edit and delete, and an outdated one with the line as it was", () => {
    const one = (c: DiffCommentView) => renderToStaticMarkup(<DiffRowView row={{ kind: "comment", key: c.id, comment: c }} focused={false} canComment actions={actions} />);
    const s = one(sent);
    expect(s).toContain("Sam Rivera");
    expect(s).toContain(">Sent<");
    expect(s).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(s).not.toContain('aria-label="Delete"');
    const d = one(draft);
    expect(d).toContain(">Draft<");
    expect(d).toContain('aria-label="Edit"');
    expect(d).toContain('aria-label="Delete"');
    const o = one(outdated);
    expect(o).toContain(">Outdated<");
    expect(o).toContain("line 52 · 3be91f0");
    expect(o).toContain("history.push(result);");
  });

  it("F-072: the field asks before throwing away text on Esc", () => {
    expect(escapeStep("", false)).toBe("cancel");
    expect(escapeStep("half a thought", false)).toBe("arm");
    expect(escapeStep("half a thought", true)).toBe("cancel");
    const html = renderToStaticMarkup(<DiffRowView row={{ kind: "field", key: "f", target: { taskRepoId: "r1", path: "a", side: "new", line: 40 }, editing: null }} focused={false} canComment actions={actions} />);
    expect(html).toContain('placeholder="Comment on line 40…"');
    expect(html).toContain("Only you see a draft until you send it.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save draft<\/button>/);
  });
});

describe("the files column", () => {
  it("F-027: short names tell same-named files apart; branch names cut in the middle", () => {
    const names = shortNames(["src/history/store.ts", "src/store.ts", "src/panel.tsx"]);
    expect(names.get("src/history/store.ts")).toBe("history/store.ts");
    expect(names.get("src/store.ts")).toBe("src/store.ts");
    expect(names.get("src/panel.tsx")).toBe("panel.tsx");
    expect(middleTruncate("ostra/calc-174-9f3c2a1b-keep-a-history", 22)).toBe("ostra/calc-174-…istory");
    expect(aheadText(web)).toBe("3 ahead · 2 behind");
    expect(aheadText(api)).toBe("1 ahead · up to date with main");
  });

  it("F-027, F-072: glyphs, counts, binary and too-large, and each file's comment count", () => {
    const html = renderToStaticMarkup(<FilesColumn repos={[web, api]} comments={[sent, draft, outdated, otherDraft]} selected="r1:src/calculator/state.ts" onSelect={noop} />);
    expect(html).toContain("calculator-web");
    expect(html).toContain("3 ahead · 2 behind · <span class=\"font-mono\">7d41e0a</span>");
    expect(html).toContain("GitHub sent the first 300 files.");
    expect(html).toContain('aria-label="3 comments"');
    expect(html).toContain('aria-label="1 comment"');
    expect(html).toContain(">binary<");
    expect(html).toContain(">too large<");
    expect(html).toContain('aria-current="true"');
  });
});

describe("behind and update branch", () => {
  it("F-070: one repo behind names its count; several list theirs", () => {
    const one = renderToStaticMarkup(<BehindLine repos={[web, api]} lastPushAt={at} update={update} />);
    expect(one).toMatch(/calculator-web<\/span> is 2 commits behind <span[^>]*>main<\/span>/);
    expect(one).toContain(" Update branch</button>");
    expect(one).toContain("As of the last turn · ");
    const both = renderToStaticMarkup(<BehindLine repos={[web, { ...api, behind: 1 }]} lastPushAt={at} update={update} />);
    expect(both).toContain("2 repos are behind their base: ");
    expect(both).toMatch(/calculator-api<\/span> \(1\)/);
    expect(behindOf([web, api])).toEqual([{ repo: "calculator-web", behind: 2, base: "main" }]);
  });

  it("F-070: nothing behind shows no button; a sent update says who was asked; a viewer who doesn't drive can take over", () => {
    expect(renderToStaticMarkup(<BehindLine repos={[api]} lastPushAt={at} update={update} />)).not.toContain("Update branch");
    const sentLine = renderToStaticMarkup(<BehindLine repos={[web]} lastPushAt={at} update={{ ...update, state: { kind: "sent", n: 1 } }} />);
    expect(sentLine).toContain(" · asked OpenCode to merge it");
    expect(sentLine).not.toContain("Update branch");
    const driving = renderToStaticMarkup(<BehindLine repos={[web]} lastPushAt={at} update={{ ...update, driver: "Alex Kim" }} />);
    expect(driving).toMatch(/<button[^>]*disabled=""[^>]*>.*Update branch<\/button>/);
    expect(driving).toContain("Alex Kim is driving.");
    expect(driving).toContain(">Take over<");
  });
});

describe("the review bar", () => {
  it("F-072: the drafts' count, their files, and the send button's words", () => {
    expect(draftsTitle([draft, otherDraft])).toEqual({ count: "2 draft comments", files: " on 2 files" });
    expect(draftsTitle([draft])).toEqual({ count: "1 draft comment", files: " on 1 file" });
    expect(sendLabel(3)).toBe("Send 3 comments to the agent");
    expect(sendLabel(1)).toBe("Send 1 comment to the agent");
    const html = renderToStaticMarkup(<ReviewBar drafts={[draft, otherDraft]} review={review} />);
    expect(html).toContain("Send 2 comments to the agent");
    expect(html).toContain("The session is idle, so they start the next turn.");
  });

  it("F-072: every delivery has its hint; a viewer who doesn't drive can't send; over 50 can't send", () => {
    expect(reviewHint({ kind: "steer" }, "OpenCode")).toBe("Sent together as one message. OpenCode reads them at its next step.");
    expect(reviewHint({ kind: "after-turn" }, "OpenCode")).toBe("Sent together as one message, after the current turn.");
    expect(reviewHint({ kind: "reopen" }, "OpenCode")).toBe("Sent together as one message. Sending reopens the task.");
    const notDriver = renderToStaticMarkup(<ReviewBar drafts={[draft]} review={{ ...review, delivery: { kind: "not-driver", driver: "Alex Kim" } }} />);
    expect(notDriver).toContain("Alex Kim is driving. Take over to send your comments.");
    expect(notDriver).toMatch(/<button[^>]*disabled=""[^>]*>.*Send 1 comment to the agent<\/button>/);
    const many = Array.from({ length: 51 }, (_, i) => comment({ id: `d${String(i)}`, state: "draft" }));
    const tooMany = renderToStaticMarkup(<ReviewBar drafts={many} review={review} />);
    expect(tooMany).toContain("At most 50 comments go in one message.");
    expect(tooMany).toMatch(/<button[^>]*disabled=""[^>]*>.*Send 51 comments to the agent<\/button>/);
    expect(renderToStaticMarkup(<ReviewBar drafts={[]} review={review} />)).toBe("");
    expect(renderToStaticMarkup(<ReviewBar drafts={[]} review={{ ...review, state: { kind: "sent", n: 2 } }} />)).toContain("Sent 2 comments as one message.");
  });
});

describe("the tab", () => {
  it("F-027: loading, failed, and nothing pushed", () => {
    expect(body({ load: { kind: "loading" } })).toContain("aria-busy");
    expect(body({ load: { kind: "failed", error: "GitHub said 502", retry: noop } })).toContain("The diff couldn&#x27;t be loaded: GitHub said 502");
    expect(body({ load: { kind: "ready", repos: [{ ...web, state: { kind: "not-pushed" } }], lastPushAt: null } })).toContain("Nothing pushed yet.");
  });

  it("F-027, F-072, F-070: the whole tab draws the behind line, both repos, the diff and the review bar", () => {
    const html = body();
    expect(html).toContain("Update branch");
    expect(html).toContain("calculator-api");
    expect(html).toContain("src/calculator/state.ts");
    expect(html).toContain("2 draft comments");
    expect(html).toContain("Send 2 comments to the agent");
  });

  it("the tabs' arrow keys wrap", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("a", 0, 3)).toBeNull();
  });
});
