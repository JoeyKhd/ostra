"use client";

import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's popover, graphite: a `--raise` panel with a `--line-2` border, for a picker that
// needs more than a select (the boards page's open statuses).
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = ({ className, align = "start", sideOffset = 4, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      className={cn("z-50 max-h-[min(360px,var(--radix-popover-content-available-height))] overflow-y-auto rounded-lg border border-line-2 bg-raise p-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)] outline-none", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
);
