import { HandIcon } from "lucide-react";
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
};

/**
 * The needs-you block (task.md, device.md): a 2px amber rule on the left, no fill and no box. An
 * approval is a rule, not a card (app-design.md, rule 3). The task page, the device approval and
 * any other place that asks the member to decide use this one markup.
 */
export const NeedsYou = ({ title, children, actions, footer, className, ...rest }: NeedsYouProps) => (
  <div className={cn("border-l-2 border-amber pl-3", className)} data-testid={rest["data-testid"] ?? "needs-you"}>
    <div className="flex items-center gap-2 text-body font-semibold text-amber">
      <HandIcon aria-hidden className="size-[14px] stroke-[1.75]" />
      {title}
    </div>
    {children === undefined ? null : <div className="mt-1 text-body text-text">{children}</div>}
    {actions === undefined ? null : <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    {footer === undefined ? null : <div className="mt-2.5 text-sm text-faint">{footer}</div>}
  </div>
);
