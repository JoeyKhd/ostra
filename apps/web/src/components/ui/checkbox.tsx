"use client";

import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's checkbox, restyled to graphite: 14px, a `--faint` border (a `--line-2` one is lost on `--surface`). Checked, it's filled
// `--shell` with an `--ink` tick (`tone="shell"`, the default) or `--teal` (`tone="teal"`, the
// environment's "during setup"). Never amber.
export const Checkbox = ({ className, tone = "shell", ...props }: ComponentProps<typeof CheckboxPrimitive.Root> & { readonly tone?: "shell" | "teal" }) => (
  <CheckboxPrimitive.Root
    className={cn(
      "peer inline-grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-faint bg-surface text-on-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:cursor-default disabled:opacity-50",
      tone === "shell" ? "data-[state=checked]:border-primary data-[state=checked]:bg-primary" : "data-[state=checked]:border-teal data-[state=checked]:bg-teal",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <CheckIcon aria-hidden className="size-[11px] stroke-[3]" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
);
