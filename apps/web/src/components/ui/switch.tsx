"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/**
 * A switch. On, it's teal in both themes (app-design.md, decided 2026-11-21): a `--teal` track and
 * edge with an `--on-primary` knob, above 3:1 against the track and the track against every
 * surface it sits on. Off, a `--surface` track with a `--control-line` edge and a `--text` knob.
 */
export const Switch = ({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) => (
  <SwitchPrimitive.Root
    className={cn(
      "inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-control-line bg-surface transition-colors data-[state=checked]:border-teal data-[state=checked]:bg-teal disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-3 translate-x-[2px] rounded-full bg-text transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-on-primary" />
  </SwitchPrimitive.Root>
);
