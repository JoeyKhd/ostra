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
  /** The item it answers, on `data-item`, for the shortcuts to find its controls (F-081). */
  readonly item?: string;
  /**
   * Ticket 16: the block takes the focus when it appears, unless the member is typing somewhere,
   * so Tab goes on to its buttons in order.
   */
  readonly focusOnAppear?: boolean;
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

export const NeedsYou = ({ title, children, actions, footer, className, item, focusOnAppear = false, ...rest }: NeedsYouProps) => {
  const node = useFocusOnAppear<HTMLDivElement>(focusOnAppear);
  const titleId = useId();
  return (
    <div
      ref={node}
      role="group"
      aria-labelledby={titleId}
      tabIndex={focusOnAppear ? -1 : undefined}
      className={cn("border-l-2 border-amber pl-3 focus:outline-2 focus:outline-offset-2 focus:outline-teal", className)}
      data-testid={rest["data-testid"] ?? "needs-you"}
      data-item={item}
    >
      <div id={titleId} className="flex items-center gap-2 text-body font-semibold text-amber">
        <HandIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {title}
      </div>
      {children === undefined ? null : <div className="mt-1 text-body text-text">{children}</div>}
      {actions === undefined ? null : <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
      {footer === undefined ? null : <div className="mt-2.5 text-sm text-faint">{footer}</div>}
    </div>
  );
};
