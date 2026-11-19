"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's radio group, restyled to graphite: a 14px ring in `--faint`; checked, a `--text`
// ring with a filled centre.
export const RadioGroup = RadioGroupPrimitive.Root;

export const RadioGroupItem = ({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) => (
  <RadioGroupPrimitive.Item
    className={cn(
      "inline-grid size-3.5 shrink-0 place-items-center rounded-full border border-faint bg-surface outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:opacity-50 data-[state=checked]:border-text",
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="size-1.5 rounded-full bg-text" />
  </RadioGroupPrimitive.Item>
);
