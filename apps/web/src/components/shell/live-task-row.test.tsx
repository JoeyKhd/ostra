import { taskIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";

import { LiveTaskRow } from "./live-task-row";
import { liveFromRow, runningLine } from "./live-tasks";
import type { LiveMark, LiveTask } from "./live-tasks";
import { DensityProvider } from "./nav-link";
import type { Density } from "./nav-link";

// F-147/c5 (milestone 8, ticket 10): a live task's row in the panel, in each state it can be in and
// at both densities (the docked panel, the phone's menu sheet). The keyboard walk over the drawn
// shell is `e2e/23-shell.spec.ts` and `e2e/a11y/a11y.spec.ts`, whose world has a running task.

const where = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => where.pathname }));

const marks: readonly LiveMark[] = ["amber", "green", "preparing", "queued"];
const densities: readonly Density[] = ["desktop", "sheet"];

const liveTask = (mark: LiveMark): LiveTask => ({
  taskId: `t-${mark}`,
  key: "3964702f",
  title: "Add a history panel",
  mark,
  line: mark === "amber" ? { tone: "needs-you", text: t("shell.live.approval") } : { tone: "plain", text: mark === "green" ? runningLine(null) : t(mark === "preparing" ? "tasks.row.preparing" : "tasks.row.queued") },
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
      kind: "code",
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
