import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@ostra/api";
import type { TaskUIMessage } from "@ostra/task-view";

import { NextTurnMenu } from "@/components/tasks/task-effort";
import type { TaskEffort } from "@/components/tasks/task-effort";
import { composerMode } from "@/components/tasks/task-ticket";
import type { ComposerInput } from "@/components/tasks/task-ticket";
import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";

import { toThreadMessageLike } from "../convert";
import { Composer } from "./composer";
import { composerWordsOf, showsInterrupt } from "./composer-words";
import type { ComposerSituation } from "./composer-words";

// Milestone 10, ticket 11 (F-151/c4, parts.md part 14, choice 14): the composer is one box. Its
// buttons, its words and what sits under it, drawn inside assistant-ui's runtime as the task page
// draws it: `Interrupt and send` only while a turn runs and the driver may interrupt it, both
// buttons asleep while the field is empty, the hint and the next turn's model and level under the
// box, in the targets' words (`s1.md`, `s2.md`, `s5.md`).

const InRuntime = ({ children }: { readonly children: ReactNode }) => {
  const runtime = useExternalStoreRuntime<TaskUIMessage>({ messages: [], convertMessage: toThreadMessageLike, isRunning: true, onNew: () => Promise.resolve() });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

const render = (node: ReactNode): string => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Never called: the box takes no files here, so it reads no limits.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <InRuntime>{node}</InRuntime>
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

const high: TaskEffort = { level: "high", levels: ["default", "low", "medium", "high", "max"], runningTurn: null };
const menu = <NextTurnMenu model="Claude Sonnet 5.5" effort={high} canChange onChange={() => undefined} pending={false} />;
const running: ComposerSituation = { agent: "OpenCode", running: true, interrupt: true, steers: true, waits: null, refine: false };
const sendMode = (over: Partial<ComposerInput> = {}) => {
  const mode = composerMode({ state: "running", send: true, reopen: false, boxState: "running", ...over });
  if (mode.kind !== "send" && mode.kind !== "reopen") throw new Error("not a box that sends");
  return mode;
};

/** The markup of the element that opens with `marker`, up to its close. */
const elementAt = (html: string, marker: string): string => {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`missing: ${marker}`);
  const open = html.lastIndexOf("<", at);
  const tags = /<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[3] === "/" || ["img", "br", "input", "path", "line", "circle", "rect", "polyline"].includes(match[2] ?? "")) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(open, tags.lastIndex);
  }
  throw new Error(`unclosed: ${marker}`);
};

const textOf = (html: string): string => html.replaceAll(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll(/\s+/g, " ").trim();

describe("the composer (F-151/c4)", () => {
  it("F-151/c4: shows `Interrupt and send` only while a turn runs and the driver may interrupt it", () => {
    expect(showsInterrupt({ canSend: true, running: true, canInterrupt: true })).toBe(true);
    expect(showsInterrupt({ canSend: true, running: true, canInterrupt: false })).toBe(false);
    expect(showsInterrupt({ canSend: true, running: false, canInterrupt: true })).toBe(false);
    expect(showsInterrupt({ canSend: false, running: true, canInterrupt: true })).toBe(false);

    const working = render(<Composer interrupt onSend={() => Promise.resolve()} words={composerWordsOf(sendMode(), running)} nextTurn={menu} files={null} />);
    expect(textOf(elementAt(working, 'data-action="interrupt-and-send"'))).toBe(t("task.composer.interruptAndSend"));
    // Between turns: no `Interrupt and send`, and the hint doesn't name it.
    const between = { ...running, running: false, interrupt: false };
    const idle = render(<Composer interrupt={false} onSend={() => Promise.resolve()} words={composerWordsOf(sendMode(), between)} nextTurn={menu} files={null} />);
    expect(idle).not.toContain('data-action="interrupt-and-send"');
    expect(idle).not.toContain(t("task.composer.interruptAndSend"));
  });

  it("F-151/c4: one box with both buttons asleep on an empty field, the hint and the model menu under it", () => {
    const html = render(<Composer interrupt onSend={() => Promise.resolve()} words={composerWordsOf(sendMode(), running)} nextTurn={menu} files={null} />);
    const box = elementAt(html, 'data-part="composer"');
    // The field, then `Interrupt and send` (labelled) and Send (an icon with its name), both asleep.
    expect(box).toContain('placeholder="Message OpenCode…"');
    const interrupt = elementAt(box, 'data-action="interrupt-and-send"');
    expect(interrupt).toContain("disabled");
    expect(textOf(interrupt)).toBe("Interrupt and send");
    const send = elementAt(box, 'data-action="send"');
    expect(send).toContain("disabled");
    expect(send).toContain('aria-label="Send"');
    expect(send).toContain("lucide-arrow-up");
    expect(textOf(send)).toBe("");
    // Under the box, not in it: the hint at the left and the next turn's model and level at the right.
    expect(box).not.toContain('data-testid="composer-hint"');
    const under = elementAt(html, 'data-part="composer-under"');
    expect(textOf(elementAt(under, 'data-testid="composer-hint"'))).toBe("Send reaches OpenCode at its next step. Interrupt and send stops the turn first.");
    const model = elementAt(under, 'data-testid="composer-next-turn"');
    expect(model).toContain('role="combobox"');
    expect(model).toContain(`aria-label="${t("task.composer.nextTurn").replaceAll("'", "&#x27;")}"`);
    expect(textOf(model)).toBe("Claude Sonnet 5.5 · High");
    // Someone who can't change it, or a model with no levels: the words alone, no menu.
    expect(render(<NextTurnMenu model="Claude Sonnet 5.5" effort={high} canChange={false} onChange={() => undefined} pending={false} />)).not.toContain('role="combobox"');
    expect(textOf(render(<NextTurnMenu model="DeepSeek V4.1 Flash" effort={{ level: "default", levels: ["default"], runningTurn: null }} canChange onChange={() => undefined} pending={false} />))).toBe("DeepSeek V4.1 Flash");
  });

  it("F-151/c4: says what Send does in each state, in the targets' words", () => {
    // S1 mid-turn, an agent that steers (`s1-working`); one that doesn't.
    expect(composerWordsOf(sendMode(), running)).toEqual({ placeholder: "Message OpenCode…", hint: "Send reaches OpenCode at its next step. Interrupt and send stops the turn first.", send: "Send" });
    expect(composerWordsOf(sendMode(), { ...running, steers: false }).hint).toBe(t("task.composer.hint"));
    // S1 waiting on the question (`s1`), the plan (`s5-plan`), a reply.
    expect(composerWordsOf(sendMode({ state: "needs_you" }), { ...running, running: false, interrupt: false, waits: "question" })).toEqual({ placeholder: "Reply to OpenCode…", hint: "Send reaches OpenCode after your answer.", send: "Send" });
    expect(composerWordsOf(sendMode({ state: "needs_you" }), { ...running, running: false, interrupt: false, waits: "plan" })).toEqual({ placeholder: "Ask for changes to the plan…", hint: "Send asks OpenCode for another plan. To start the work, approve the plan.", send: "Send" });
    expect(composerWordsOf(sendMode({ state: "needs_you" }), { ...running, running: false, interrupt: false, waits: "reply" }).placeholder).toBe("Reply to OpenCode…");
    // S2: in review, its box idle, the driver's message starts the next turn in it (a reopen there).
    const inBox = sendMode({ state: "in_review", send: false, reopen: true, reopenInBox: true, boxState: "idle" });
    expect(inBox).toEqual({ kind: "reopen", hint: t("taskPage.composer.idleHint"), inBox: true });
    expect(composerWordsOf(inBox, { ...running, running: false, interrupt: false })).toEqual({ placeholder: "Message OpenCode…", hint: "The box is idle. Send starts the next turn in it.", send: "Send" });
    // A reopen on a box it picks says so.
    const reopen = sendMode({ state: "stopped", send: false, reopen: true, boxState: "released" });
    expect(composerWordsOf(reopen, { ...running, running: false, interrupt: false })).toEqual({ placeholder: t("taskPage.composer.reopenPlaceholder"), hint: t("taskPage.composer.reopenHint"), send: t("taskPage.composer.reopen") });
    const html = render(<Composer interrupt={false} reopen onSend={() => Promise.resolve()} words={composerWordsOf(reopen, { ...running, running: false, interrupt: false })} files={null} />);
    expect(elementAt(html, 'data-action="reopen"')).toContain(`aria-label="${t("taskPage.composer.reopen")}"`);
  });
});
