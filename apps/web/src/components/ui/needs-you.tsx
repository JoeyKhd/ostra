"use client";

import { HandIcon } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * What a block waits on the member viewing it for, on `data-waits`, for the task thread's pill
 * (milestone 10, F-151, parts.md part 11): its question, its plan, an approval, a reply, or
 * anything else. A quiet block (someone else's to answer) waits on nobody here and has none.
 */
export type NeedsYouWaits = "question" | "plan" | "approval" | "reply" | "other";

/**
 * Milestone 10 (F-151, parts.md part 11): the block inside a task's thread, flush with the prose
 * at that part's sizes (`margin: 12px 0 8px`, `padding: 2px 0 2px 14px`, the title 14px). The
 * thread provides it, so every block it holds (the question, the plan, an approval, a limit, a
 * restore conflict, a closed ticket, a reply) takes the same sizes; elsewhere the block is as
 * milestone 1 drew it.
 */
export const NeedsYouInThread = createContext(false);

export type NeedsYouProps = {
  /** The title line, such as `Needs you · approval`. The one amber text where it shows. */
  readonly title: string;
  /** What waits: the message, the command, the question. Body text, `--text`. */
  readonly children?: ReactNode;
  /** The answer: the buttons (Deny first, the one `amber` action last), 12px above. */
  readonly actions?: ReactNode;
  /** A line under the actions, 13px `--faint`: who can answer, or what went wrong. */
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly "data-testid"?: string;
  /** The limit or crash a limit card stands for (task-limits.md). */
  readonly "data-limit"?: string;
  /** The item it answers, on `data-item`, for the shortcuts to find its controls (F-081). */
  readonly item?: string;
  /**
   * Ticket 16: the block takes the focus when it appears, unless the member is typing somewhere,
   * so Tab goes on to its buttons in order.
   */
  readonly focusOnAppear?: boolean;
  /** What waits, on `data-need`, for the thread's cards (`needs-you-card-words.ts`). */
  readonly need?: string;
  /** `quiet`: the same block for someone it doesn't wait on, with a `--line-2` rule and no amber. */
  readonly tone?: "amber" | "quiet";
  /** The title's icon, `hand` by default. */
  readonly icon?: ReactNode;
  /**
   * What it waits on the viewer for (`data-waits`, the thread's pill). By default an amber block in
   * the thread waits for a reply (`need="reply"`) or something else; a quiet one never waits.
   */
  readonly waits?: NeedsYouWaits | null;
};

/** The member is typing: a field, a select or something editable has the focus. */
const typing = (): boolean => {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || active.closest("input, textarea, select") !== null);
};

/**
 * The needs-you block (task.md, device.md): a 2px amber rule on the left, no fill and no box. An
 * approval is a rule, not a card (app-design.md, rule 3). The task page, the device approval and
 * any other place that asks the member to decide use this one markup.
 */
/** Ticket 16: a block that asks the member takes the focus when it appears, unless they are typing. */
export const useFocusOnAppear = <T extends HTMLElement,>(on: boolean) => {
  const node = useRef<T>(null);
  useEffect(() => {
    if (on && !typing()) node.current?.focus({ preventScroll: false });
  }, [on]);
  return node;
};

/** What a block waits on its viewer for, by its tone and its need, when it doesn't say. */
const waitsOf = (inThread: boolean, tone: "amber" | "quiet", need: string | undefined, waits: NeedsYouWaits | null | undefined): NeedsYouWaits | undefined => {
  if (!inThread || tone === "quiet") return undefined;
  if (waits !== undefined) return waits ?? undefined;
  return need === "reply" ? "reply" : "other";
};

export const NeedsYou = ({ title, children, actions, footer, className, item, need, tone = "amber", icon, focusOnAppear = false, waits, ...rest }: NeedsYouProps) => {
  const node = useFocusOnAppear<HTMLDivElement>(focusOnAppear);
  const titleId = useId();
  const inThread = useContext(NeedsYouInThread);
  return (
    <div
      ref={node}
      role="group"
      aria-labelledby={titleId}
      tabIndex={focusOnAppear ? -1 : undefined}
      className={cn(
        "border-l-(length:--rule-needs-you)",
        // In the thread the ring shows for the keyboard only: a block that takes the focus as it appears draws none for a pointer.
        inThread ? "mb-2 mt-3 py-0.5 pl-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal" : "pl-3 focus:outline-2 focus:outline-offset-2 focus:outline-teal",
        tone === "amber" ? "border-amber" : "border-line-2",
        className,
      )}
      data-testid={rest["data-testid"] ?? "needs-you"}
      data-item={item}
      data-need={need}
      data-limit={rest["data-limit"]}
      data-tone={tone}
      data-waits={waitsOf(inThread, tone, need, waits)}
    >
      <div id={titleId} className={cn("flex items-center gap-2 font-semibold [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]", inThread ? "text-ui" : "text-body", tone === "amber" ? "text-amber-text" : "text-muted")}>
        {icon ?? <HandIcon aria-hidden />}
        {title}
      </div>
      {children === undefined ? null : <div className={cn("text-body text-text", inThread ? "mt-[5px] leading-[1.55]" : "mt-1")}>{children}</div>}
      {actions === undefined ? null : <div className={cn("flex flex-wrap items-center gap-2", inThread ? "mt-2.5" : "mt-3")}>{actions}</div>}
      {footer === undefined ? null : <div className={cn("text-sm text-faint", inThread ? "mt-2" : "mt-2.5")}>{footer}</div>}
    </div>
  );
};
