"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

export const Switch = ({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) => (
  <SwitchPrimitive.Root
    className={cn(
      "inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-line-2 bg-surface transition-colors data-[state=checked]:border-green data-[state=checked]:bg-green disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-3 translate-x-[2px] rounded-full bg-text transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-on-primary" />
  </SwitchPrimitive.Root>
);
