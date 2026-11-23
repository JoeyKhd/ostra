import { connectionIdSchema, memberIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { LiveFamilyRows, LiveTaskRow } from "./live-task-row";
import { liveCount, liveFromRow, projectLive, runningLine, yoursLive } from "./live-tasks";
import type { LiveMark, LiveTask } from "./live-tasks";
import { DensityProvider } from "./nav-link";
import type { Density } from "./nav-link";

// F-147/c5 (milestone 8, ticket 10): a live task's row in the panel, in each state it can be in and
// at both densities (the docked panel, the phone's menu sheet). The keyboard walk over the drawn
// shell is `e2e/23-shell.spec.ts` and `e2e/a11y/a11y.spec.ts`, whose world has a running task.

const where = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => where.pathname }));

const marks: readonly LiveMark[] = ["amber", "green", "preparing", "queued", "in-review"];
const densities: readonly Density[] = ["desktop", "sheet"];

const liveTask = (mark: LiveMark): LiveTask => ({
  taskId: `t-${mark}`,
  key: "3964702f",
  title: "Add a history panel",
  mark,
  line: mark === "amber" ? { tone: "needs-you", text: t("shell.live.approval") } : { tone: "plain", text: mark === "green" ? runningLine(null) : t(mark === "preparing" ? "tasks.row.preparing" : mark === "in-review" ? "taskState.inReview" : "tasks.row.queued") },
  followUp: null,
  connection: null,
});

const draw = (task: LiveTask, density: Density): string =>
  renderToStaticMarkup(
    <DensityProvider value={density}>
      <LiveTaskRow task={task} onNavigate={() => undefined} />
    </DensityProvider>,
  );

/** Every class token the markup gives, element by element. */
const classTokens = (markup: string): readonly string[] => [...markup.matchAll(/class="([^"]*)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/));

/** The row's text, as a reader hears it: the markup without its tags and its hidden parts. */
const spoken = (markup: string): string =>
  markup
    .replace(/<([a-z]+)[^>]*aria-hidden="true"[^>]*>.*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'");

describe("a live task's row (F-147, app-shell.md \"A live task row\")", () => {
  it("F-147/c5: a live row is one link in every state and at both densities: nothing in it takes the focus apart, and nothing hides it, fades it or moves it", () => {
    for (const mark of marks) {
      for (const density of densities) {
        for (const open of [false, true]) {
          const task = liveTask(mark);
          where.pathname = open ? `/tasks/${task.taskId}` : "/";
          const markup = draw(task, density);
          const at = `${mark}, ${density}${open ? ", its page open" : ""}`;
          // One control: the link to the task, in the Tab order, and nothing else that takes the focus.
          expect(markup.match(/<a\b/g), at).toHaveLength(1);
          expect(markup, at).toMatch(new RegExp(`^<a [^>]*href="/tasks/${task.taskId}"`));
          expect(markup, at).not.toMatch(/<(button|input|select|textarea|summary|iframe)\b|tabindex=|contenteditable/);
          // Drawn as it stands: no fade, no hiding class, no animation or transition on any part.
          expect(classTokens(markup).filter((token) => /^(hidden|invisible|sr-only|opacity-.+|animate-.+|transition.*|motion-.+|scale-.+|translate-.+)$/.test(token)), at).toEqual([]);
          expect(markup, at).not.toMatch(/style="[^"]*(opacity|visibility|display)/);
          // The open task's row says so.
          expect(markup.includes('aria-current="page"'), at).toBe(open);
        }
      }
    }
  });

  it("F-147/c5: a live row says its state in words, never by its dot alone, and a running task with nothing to show yet reads Running", () => {
    expect(runningLine(null)).toBe(t("taskState.running"));
    expect(runningLine({ kind: "tool.called", detail: "pnpm test --shard 1/4", toolKind: "execute" })).toBe("Running pnpm test --shard 1/4");
    const running = liveFromRow({
      id: taskIdSchema.parse("01a1f173-8696-70be-a85a-85223964702f"),
      key: "3964702f",
      title: "Add a history panel",
      connection: null,
      kind: "code",
      reviewOf: null,
      state: "running",
      subState: null,
      reason: null,
      needsYouReason: null,
      stoppedReason: null,
      group: "running",
      waiting: null,
      queue: null,
      doing: null,
      runner: null,
      driver: null,
      prs: [],
      createdAt: 0,
      updatedAt: 0,
    });
    expect(running?.line).toEqual({ tone: "plain", text: t("taskState.running") });
    where.pathname = "/";
    const words: Readonly<Record<LiveMark, string>> = {
      amber: t("shell.live.approval"),
      green: t("taskState.running"),
      preparing: t("tasks.row.preparing"),
      queued: t("tasks.row.queued"),
      "in-review": t("taskState.inReview"),
    };
    for (const mark of marks) {
      const markup = draw(liveTask(mark), "desktop");
      // The mark is colour or a shape: hidden from a reader, and the line names the state instead.
      expect(markup, mark).toMatch(/<span class="flex justify-center[^"]*"><(span|svg)[^>]*aria-hidden="true"/);
      expect(spoken(markup), mark).toBe(`Add a history panel3964702f · ${words[mark]}`);
      expect(markup, mark).toContain(`title="Add a history panel · 3964702f · ${words[mark]}"`);
    }
  });
});

describe("a live row's ticket's tracker (ticket-chips.md, F-152/c4)", () => {
  it("F-152/c4: the second line carries the tracker's mark in the key's colour, before the key", () => {
    const task: LiveTask = { ...liveTask("green"), connection: { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c2"), kind: "jira", name: "Globex Jira" } };
    const markup = draw(task, "desktop");
    expect(markup).toContain('data-tracker-mark="jira"');
    expect(markup).toContain('data-treatment="mono"');
    // Hidden from readers: the row's title already names the task and its key.
    expect(markup).toContain('aria-hidden="true"');
    expect(spoken(markup)).toBe(`Add a history panel 3964702f · ${task.line.text}`);
    // Without a connection (a prompt task) the line is the key and nothing else.
    expect(draw(liveTask("green"), "desktop")).not.toContain("data-tracker-mark");
  });
});

// F-147/c8 (2026-11-21, ADR 0059 amended): a follow-up, its code task's AI review, sits under that
// task, indented with its tag, and never as a look-alike row of its own.

type ListRow = RouterOutputs["tasks"]["list"][number]["tasks"][number];
type Card = RouterOutputs["home"]["board"]["columns"][number]["cards"][number];

const codeId = taskIdSchema.parse("01a1f173-8696-70be-a85a-85223964702f");
const reviewId = taskIdSchema.parse("01a1f173-8696-70be-a85a-8522396470aa");
const otherId = taskIdSchema.parse("01a1f173-8696-70be-a85a-8522396470bb");

const listRow = (over: Partial<ListRow> & Pick<ListRow, "id" | "state">): ListRow => ({
  key: over.id.slice(-8),
  title: "add a simple index.html file that i can preview",
  connection: null,
  kind: "code",
  reviewOf: null,
  subState: null,
  reason: null,
  needsYouReason: null,
  stoppedReason: null,
  group: "running",
  waiting: null,
  queue: null,
  doing: null,
  runner: null,
  driver: null,
  prs: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const groupsOf = (rows: readonly ListRow[]): RouterOutputs["tasks"]["list"] => [{ group: "running", tasks: [...rows] }];

describe("a follow-up in the live lists (F-147/c8)", () => {
  it("F-147/c8: a review sits under its code task, drawn in review when it isn't live itself, and counts once", () => {
    const rows = [
      listRow({ id: codeId, state: "in_review", subState: "ai_review" }),
      listRow({ id: reviewId, state: "queued", kind: "review", reviewOf: codeId, title: "Review: add a simple index.html file that i can preview" }),
      listRow({ id: otherId, state: "running", title: "Add a history panel" }),
    ];
    const families = projectLive(groupsOf(rows), null);
    // Running first; then the code task, held for its queued review.
    expect(families.map((family) => family.task.taskId)).toEqual([otherId, codeId]);
    const [, family] = families;
    expect(family).toMatchObject({ context: true, task: { mark: "in-review", line: { text: t("taskState.inReview") } } });
    expect(family?.followUps.map((task) => [task.taskId, task.followUp, task.mark])).toEqual([[reviewId, "review", "queued"]]);
    // Two live tasks: the code task in review isn't one.
    expect(liveCount(families)).toBe(2);

    // Drawn: the code task's row, then the review's, indented, with its tag and what it does now.
    where.pathname = "/";
    const markup = renderToStaticMarkup(
      <DensityProvider value="desktop">
        {family === undefined ? null : <LiveFamilyRows family={family} onNavigate={() => undefined} />}
      </DensityProvider>,
    );
    expect(markup.match(/<a\b/g)).toHaveLength(2);
    const [, nested] = markup.split(/(?=<a\b)/);
    expect(nested).toContain('data-follow-up="review"');
    expect(nested).toMatch(/class="[^"]*pl-\[30px\]/);
    expect(spoken(nested ?? "")).toBe(`${t("draft.chipReview")}${t("tasks.row.queued")}`);
    // Its title is never drawn as a row of its own: the code task's is.
    expect(spoken(markup).startsWith("add a simple index.html file that i can preview")).toBe(true);
    expect(spoken(markup)).not.toContain("Review: add a simple");
  });

  it("F-147/c8: a live code task keeps its place with its review under it; a review whose task isn't known keeps a row of its own, tagged", () => {
    const families = projectLive(
      groupsOf([listRow({ id: codeId, state: "running" }), listRow({ id: reviewId, state: "running", kind: "review", reviewOf: codeId })]),
      null,
    );
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ context: false, task: { taskId: codeId, mark: "green" }, followUps: [{ taskId: reviewId, followUp: "review" }] });
    expect(liveCount(families)).toBe(2);

    const alone = projectLive(groupsOf([listRow({ id: reviewId, state: "queued", kind: "review", reviewOf: otherId })]), null);
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ task: { taskId: reviewId, followUp: "review" }, followUps: [], context: false });
    const markup = renderToStaticMarkup(
      <DensityProvider value="desktop">
        {alone[0] === undefined ? null : <LiveFamilyRows family={alone[0]} onNavigate={() => undefined} />}
      </DensityProvider>,
    );
    expect(spoken(markup)).toContain(`${t("draft.chipReview")} ${reviewId.slice(-8)}`);
  });

  it("F-147/c8: Home's own live tasks nest a running review under its code task, named from the board", () => {
    const memberId = memberIdSchema.parse("01a1f173-8696-70be-a85a-8522396470cc");
    const card: Card = {
      taskId: reviewId,
      key: null,
      title: "Review: add a simple index.html file that i can preview",
      connection: null,
      kind: "review",
      reviewOf: { taskId: codeId, key: null, title: "add a simple index.html file that i can preview" },
      state: "running",
      project: { id: projectIdSchema.parse("01a1f173-8696-70be-a85a-8522396470dd"), name: "test1" },
      driver: { memberId, name: "demo" },
      enteredAt: 0,
      status: { kind: "running", doing: null },
    };
    const families = yoursLive([card], memberId);
    expect(families).toHaveLength(1);
    expect(families[0]?.task).toEqual({ taskId: codeId, key: codeId.slice(-7), title: "add a simple index.html file that i can preview", mark: "in-review", line: { tone: "plain", text: t("taskState.inReview") }, followUp: null, connection: null });
    expect(families[0]).toMatchObject({ context: true, followUps: [{ taskId: reviewId, followUp: "review", mark: "green" }] });
    expect(liveCount(families)).toBe(1);
    // Someone else's review isn't the member's own.
    expect(yoursLive([{ ...card, driver: null }], memberId)).toEqual([]);
  });
});
