import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { TAIL_LINES, durationOf, fixHint, formatCheckDuration, markerOf, outputLabel, plainOutput, prLineWords, propertyOf, repoSectionsOf, shownLines, statusWord, summaryOf, turnTotalMs } from "./check-words";
import type { CheckRunView, TurnChecksView } from "./check-words";
import { ChecksBody, ChecksTabMarker, FixRow, PrDraftRow, TurnSection } from "./task-checks";
import type { ChecksBodyProps } from "./task-checks";

// F-054: the Checks tab (task-checks.md): each turn's checks with status, time and output (plain
// text, the last 40 lines), "Ask the agent to fix" on the newest turn's failures, the PR's draft line.

const now = Date.UTC(2026, 10, 19, 9, 50);
const check = (over: Partial<CheckRunView> & Pick<CheckRunView, "checkId" | "name" | "status">): CheckRunView => ({
  command: `pnpm ${over.name}`,
  repo: null,
  exitCode: null,
  durationMs: 1200,
  timeoutMs: 600_000,
  startedAt: null,
  outputTail: "",
  downloadUrl: `/api/checks/${over.checkId}/output`,
  ...over,
});

const turn3: TurnChecksView = {
  turn: 3,
  at: Date.UTC(2026, 10, 19, 9, 41),
  sha: "7d41e0a9c1",
  heads: [],
  checks: [
    check({ checkId: "c1", name: "whitespace", status: "passed", durationMs: 1200, outputTail: "ok\n" }),
    check({ checkId: "c2", name: "settings-json", status: "failed", exitCode: 1, durationMs: 400, outputTail: "\u001B[31mSyntaxError: Expected double-quoted property name\u001B[0m\r\n    at JSON.parse (<anonymous>)\n<script>alert(1)</script>\n" }),
    check({ checkId: "c3", name: "unit-tests", status: "passed", durationMs: 38_500 }),
  ],
};
const turn1: TurnChecksView = {
  turn: 1,
  at: Date.UTC(2026, 10, 19, 8, 47),
  sha: "a41c9d2",
  heads: [],
  checks: [check({ checkId: "d1", name: "whitespace", status: "passed", durationMs: 0 }), check({ checkId: "d2", name: "e2e", status: "timed-out", durationMs: null, timeoutMs: 600_000 })],
};
const noop = () => undefined;
const esc = (text: string): string => text.replaceAll("'", "&#x27;");
const fix = { agent: "OpenCode", delivery: { kind: "next-turn" } as const, state: { kind: "idle" } as const, onFix: noop, onTakeOver: noop, onSeeActivity: noop };

describe("a check's words", () => {
  it("F-054: status words and durations per state", () => {
    expect(statusWord(turn3.checks[1] ?? turn3.checks[0] ?? check({ checkId: "x", name: "x", status: "passed" }))).toBe("failed · exit 1");
    expect(statusWord(check({ checkId: "x", name: "x", status: "timed-out", timeoutMs: 300_000 }))).toBe("timed out after 5 min");
    expect(statusWord(check({ checkId: "x", name: "x", status: "error" }))).toBe("couldn't run");
    expect(formatCheckDuration(400)).toBe("0.4 s");
    expect(formatCheckDuration(38_500)).toBe("38.5 s");
    expect(formatCheckDuration(72_000)).toBe("1 min 12 s");
    expect(formatCheckDuration(600_000)).toBe("10 min");
    expect(durationOf(check({ checkId: "x", name: "x", status: "timed-out" }), now)).toBeNull();
    expect(durationOf(check({ checkId: "x", name: "x", status: "running", startedAt: now - 12_400 }), now)).toBe("12 s");
  });

  it("F-054: a turn's summary puts failures first in red, and its total counts a timeout's limit", () => {
    expect(summaryOf(turn3.checks)).toEqual([
      { text: "1 failed", tone: "red" },
      { text: "2 passed", tone: "green" },
    ]);
    expect(summaryOf(turn1.checks).map((part) => part.text)).toEqual(["1 timed out", "1 passed"]);
    expect(turnTotalMs(turn1)).toBe(600_000);
    expect(turnTotalMs(turn3)).toBe(40_100);
  });

  it("F-054: the tab's marker and the property follow the newest turn", () => {
    expect(markerOf([])).toEqual({ kind: "none" });
    expect(markerOf([turn3, turn1])).toEqual({ kind: "failing", count: 1 });
    expect(markerOf([{ ...turn3, checks: [check({ checkId: "a", name: "a", status: "running" })] }])).toEqual({ kind: "running" });
    expect(markerOf([{ ...turn3, checks: [check({ checkId: "a", name: "a", status: "passed" })] }])).toEqual({ kind: "passed" });
    expect(propertyOf([turn3])).toEqual({ failing: 1, passed: 2, running: false });
    expect(renderToStaticMarkup(<ChecksTabMarker marker={{ kind: "failing", count: 1 }} />)).toContain("text-red");
  });
});

describe("the output", () => {
  it("F-054: is plain text: ANSI stripped, never interpreted as HTML", () => {
    expect(plainOutput(turn3.checks[1]?.outputTail ?? "")).toEqual(["SyntaxError: Expected double-quoted property name", "    at JSON.parse (<anonymous>)", "<script>alert(1)</script>"]);
    const html = renderToStaticMarkup(<TurnSection turn={turn3} newest now={now} repos={[]} fix={fix} />);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("\u001B");
  });

  it("F-054: past 40 lines it shows the last 40, with the count for Show all", () => {
    const lines = Array.from({ length: 55 }, (_, i) => `line ${String(i + 1)}`);
    expect(shownLines(lines, false)).toHaveLength(TAIL_LINES);
    expect(shownLines(lines, false)[0]).toBe("line 16");
    expect(shownLines(lines, true)).toHaveLength(55);
    expect(outputLabel(55)).toBe(t("checks.outputLast"));
    expect(outputLabel(3)).toBe("Output, 3 lines");
    const long = { ...turn3, checks: [check({ checkId: "f", name: "lint", status: "failed", exitCode: 2, outputTail: lines.join("\n") })] };
    const html = renderToStaticMarkup(<TurnSection turn={long} newest now={now} repos={[]} fix={fix} />);
    expect(html).toContain("Show all 55 lines");
    expect(html).not.toContain("line 15\n");
    expect(html).toContain("line 55");
  });
});

describe("a turn", () => {
  it("F-054: the newest turn opens with its failed check's output and the fix row; passes stay folded", () => {
    const html = renderToStaticMarkup(<TurnSection turn={turn3} newest now={now} repos={[]} fix={fix} />);
    expect(html).toContain("Turn 3");
    expect(html).toContain("7d41e0a");
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-output="c2"');
    expect(html).not.toContain('data-output="c1"');
    expect(html).toContain(t("checks.fixButton"));
    expect(html).toContain(esc(t("checks.fix.one", { agent: "OpenCode" })));
    expect(html).toContain('href="/api/checks/c2/output"');
  });

  it("F-054: an older turn is folded", () => {
    expect(renderToStaticMarkup(<TurnSection turn={turn1} newest={false} now={now} repos={[]} fix={null} />)).not.toContain('data-check="e2e"');
  });

  it("F-054: the fix hint follows the composer's rule, and a non-driver can't press it", () => {
    expect(fixHint({ kind: "next-turn" }, 2, "OpenCode")).toBe("Sends the 2 failing checks' output to OpenCode as the next turn.");
    expect(fixHint({ kind: "after-turn" }, 1, "OpenCode")).toBe(t("checks.fix.afterTurn", { agent: "OpenCode" }));
    expect(fixHint({ kind: "reopen" }, 1, "OpenCode")).toBe(t("checks.fix.reopen"));
    const html = renderToStaticMarkup(<FixRow {...fix} delivery={{ kind: "not-driver", driver: "Sam Rivera" }} failing={1} downloadUrl={null} />);
    expect(html).toContain("Sam Rivera is driving.");
    expect(html).toContain(t("checks.takeOver"));
    expect(/<button[^>]*data-action="fix-checks"[^>]*>/.exec(html)?.[0] ?? /<button[^>]*disabled=""[^>]*data-action="fix-checks"/.exec(html)?.[0]).toContain('disabled=""');
    expect(html).toContain(esc(t("checks.notSaved")));
    expect(renderToStaticMarkup(<FixRow {...fix} state={{ kind: "sent", at: now }} failing={1} downloadUrl={null} />)).toContain("Asked OpenCode to fix it at");
    expect(renderToStaticMarkup(<FixRow {...fix} state={{ kind: "refused", message: "Spend cap reached." }} failing={1} downloadUrl={null} />)).toContain('role="alert"');
  });
});

describe("the tab", () => {
  const body = (load: ChecksBodyProps["load"]) => renderToStaticMarkup(<ChecksBody load={load} now={now} environmentHref="/projects/p/environment" fix={fix} />);

  it("F-054: the PR's draft line says why it's a draft", () => {
    expect(prLineWords({ number: 483, repo: null, url: "https://github.com/a/b/pull/483", state: "draft-by-ostra", turn: 3 })).toEqual({ bold: "PR #483 is a draft", rest: " because a check failed after turn 3. ostra marks it ready when every check passes." });
    expect(prLineWords({ number: 91, repo: "calculator-api", url: "u", state: "ready-by-ostra", turn: 4 }).bold).toBe("PR #91 in calculator-api is ready for review");
    expect(renderToStaticMarkup(<PrDraftRow line={{ number: 483, repo: null, url: "https://github.com/a/b/pull/483", state: "draft-by-person", turn: 3 }} />)).toContain(t("checks.pr.draftByPerson"));
  });

  it("F-054: each state of the tab's body", () => {
    expect(body({ kind: "loading" })).toContain('aria-busy="true"');
    expect(body({ kind: "error", message: "nope", retry: noop })).toContain("The checks couldn&#x27;t be loaded: nope");
    expect(body({ kind: "ready", configured: false, supported: true, turns: [], prLines: [], repos: [] })).toContain(t("checks.none"));
    expect(body({ kind: "ready", configured: true, supported: false, turns: [], prLines: [], repos: [] })).toContain(esc(t("checks.oldRunner")));
    expect(body({ kind: "ready", configured: true, supported: true, turns: [], prLines: [], repos: [] })).toContain(t("checks.notYet"));
    const full = body({ kind: "ready", configured: true, supported: true, turns: [turn3, turn1], prLines: [{ number: 483, repo: null, url: "u", state: "draft-by-ostra", turn: 3 }], repos: [] });
    expect(full.indexOf("Turn 3")).toBeLessThan(full.indexOf("Turn 1"));
    expect(full).toContain('data-pr="483"');
    expect(full).toContain(t("checks.edit"));
    // Only the newest turn with a failure offers the fix.
    expect(full.match(/data-action="fix-checks"/g)).toHaveLength(1);
  });
});

describe("a task across several repos (F-098)", () => {
  const web = "ostra-test/calculator-web";
  const api = "ostra-test/calculator-api";
  const repos = [web, api] as const;
  const turn4: TurnChecksView = {
    turn: 4,
    at: Date.UTC(2026, 10, 19, 9, 45),
    sha: "aaaaaaa11112222",
    heads: [
      { repo: api, sha: "b0b0b0b0b0b0b0" },
      { repo: web, sha: "c1c1c1c1c1c1c1" },
    ],
    checks: [
      check({ checkId: "a1", name: "api-tests", status: "failed", exitCode: 1, repo: api, outputTail: "1 failing\n" }),
      check({ checkId: "w1", name: "web-tests", status: "passed", repo: web }),
      check({ checkId: "r1", name: "whitespace", status: "passed", repo: null }),
      check({ checkId: "w2", name: "web-lint", status: "failed", exitCode: 2, repo: web, outputTail: "lint error\n" }),
    ],
  };
  const at = (html: string, marker: string): number => {
    const index = html.indexOf(marker);
    expect(index, marker).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("F-098/c3: a turn has a section per repo in the project's order, each with the commit its checks ran on there and its own summary, then the workspace root's", () => {
    expect(repoSectionsOf(turn4, repos)?.map((section) => [section.repo, section.sha, section.checks.map((one) => one.name)])).toEqual([
      [web, "c1c1c1c1c1c1c1", ["web-tests", "web-lint"]],
      [api, "b0b0b0b0b0b0b0", ["api-tests"]],
      [null, null, ["whitespace"]],
    ]);
    const html = renderToStaticMarkup(<TurnSection turn={turn4} newest now={now} repos={repos} fix={fix} />);
    expect(at(html, `data-repo-section="${web}"`)).toBeLessThan(at(html, 'data-check="web-tests"'));
    expect(at(html, 'data-check="web-lint"')).toBeLessThan(at(html, `data-repo-section="${api}"`));
    expect(at(html, `data-repo-section="${api}"`)).toBeLessThan(at(html, 'data-check="api-tests"'));
    expect(at(html, 'data-check="api-tests"')).toBeLessThan(at(html, 'data-repo-section="workspace-root"'));
    expect(at(html, 'data-repo-section="workspace-root"')).toBeLessThan(at(html, 'data-check="whitespace"'));
    expect(html).toContain(t("checks.workspaceRoot"));
    // Each section names its repo's commit; the turn's header names none of them.
    const webHeading = html.slice(at(html, `data-repo-section="${web}"`), at(html, 'data-check="web-tests"'));
    expect(webHeading).toContain("c1c1c1c");
    expect(webHeading).toContain("1 failed");
    expect(webHeading).toContain("1 passed");
    const apiHeading = html.slice(at(html, `data-repo-section="${api}"`), at(html, 'data-check="api-tests"'));
    expect(apiHeading).toContain("b0b0b0b");
    expect(apiHeading).not.toContain("passed");
    expect(html).not.toContain("aaaaaaa");
    // The fix row follows the last failing check as the sections show it, and sends both.
    expect(html.match(/data-action="fix-checks"/g)).toHaveLength(1);
    expect(at(html, 'data-check="api-tests"')).toBeLessThan(at(html, 'data-action="fix-checks"'));
    expect(at(html, 'data-action="fix-checks"')).toBeLessThan(at(html, 'data-repo-section="workspace-root"'));
    expect(html).toContain(esc(t("checks.fix.several", { n: 2, agent: "OpenCode" })));
  });

  it("F-098/c3: a task with one repo keeps one list, with the turn's commit in its header", () => {
    expect(repoSectionsOf(turn4, [web])).toBeNull();
    const html = renderToStaticMarkup(<TurnSection turn={turn4} newest now={now} repos={[web]} fix={null} />);
    expect(html).not.toContain("data-repo-section");
    expect(html).toContain("aaaaaaa");
  });

  it("F-098/c3: the tab gives each turn the task's repos, and names each repo's PR", () => {
    const html = renderToStaticMarkup(
      <ChecksBody
        load={{
          kind: "ready",
          configured: true,
          supported: true,
          turns: [turn4],
          prLines: [
            { number: 12, repo: web, url: "https://github.com/ostra-test/calculator-web/pull/12", state: "draft-by-ostra", turn: 4 },
            { number: 12, repo: api, url: "https://github.com/ostra-test/calculator-api/pull/12", state: "draft-by-ostra", turn: 4 },
          ],
          repos,
        }}
        now={now}
        environmentHref={null}
        fix={fix}
      />,
    );
    expect(html).toContain(`data-repo-section="${api}"`);
    expect(html).toContain(`PR #12 in ${web} is a draft`);
    expect(html).toContain(`PR #12 in ${api} is a draft`);
  });
});
