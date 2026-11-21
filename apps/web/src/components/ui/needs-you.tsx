"use client";

import { HandIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

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

export const NeedsYou = ({ title, children, actions, footer, className, item, need, tone = "amber", icon, focusOnAppear = false, ...rest }: NeedsYouProps) => {
  const node = useFocusOnAppear<HTMLDivElement>(focusOnAppear);
  const titleId = useId();
  return (
    <div
      ref={node}
      role="group"
      aria-labelledby={titleId}
      tabIndex={focusOnAppear ? -1 : undefined}
      className={cn("border-l-(length:--rule-needs-you) pl-3 focus:outline-2 focus:outline-offset-2 focus:outline-teal", tone === "amber" ? "border-amber" : "border-line-2", className)}
      data-testid={rest["data-testid"] ?? "needs-you"}
      data-item={item}
      data-need={need}
      data-limit={rest["data-limit"]}
    >
      <div id={titleId} className={cn("flex items-center gap-2 text-body font-semibold [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]", tone === "amber" ? "text-amber-text" : "text-muted")}>
        {icon ?? <HandIcon aria-hidden />}
        {title}
      </div>
      {children === undefined ? null : <div className="mt-1 text-body text-text">{children}</div>}
      {actions === undefined ? null : <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
      {footer === undefined ? null : <div className="mt-2.5 text-sm text-faint">{footer}</div>}
    </div>
  );
};
