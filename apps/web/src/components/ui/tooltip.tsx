"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactNode } from "react";

/**
 * shadcn/ui's tooltip, graphite: a `--raise` panel with a `--line-2` border, 13px text. It repeats
 * what the page already says elsewhere (an `aria-describedby`, a title): it never holds the only copy.
 */
export const Tooltip = ({
  content,
  children,
  side,
  delay = 300,
  suppressed = false,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  /** Where it opens: Radix's choice (above) unless given; the rail's open to the right. */
  readonly side?: "top" | "right" | "bottom" | "left";
  /** How long a hover waits; focus opens it at once. */
  readonly delay?: number;
  /** Kept closed while something else already says it (the rail's peek shows the space's panel). */
  readonly suppressed?: boolean;
}) => (
  <TooltipPrimitive.Provider delayDuration={delay}>
    <TooltipPrimitive.Root {...(suppressed ? { open: false } : {})}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          {...(side === undefined ? {} : { side })}
          sideOffset={6}
          className="z-50 max-w-[280px] rounded-md border border-line-2 bg-raise px-2.5 py-1.5 text-sm text-text shadow-(--shadow-pop)"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
);
