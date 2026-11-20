"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's toggle group, graphite: a segmented control, `--surface` with a `--control-line` border;
// the chosen option is `--sel` with `--text`, the others `--muted`.
export const ToggleGroup = ({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) => (
  <ToggleGroupPrimitive.Root className={cn("inline-flex h-[30px] items-stretch rounded-md border border-control-line bg-surface p-0.5", className)} {...props} />
);

export const ToggleGroupItem = ({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) => (
  <ToggleGroupPrimitive.Item
    className={cn(
      "rounded-sm px-3 text-ui text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-teal disabled:opacity-60 data-[state=on]:bg-sel data-[state=on]:text-text data-[state=on]:shadow-[inset_0_0_0_1px_var(--line-2)]",
      className,
    )}
    {...props}
  />
);
