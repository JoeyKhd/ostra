import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/** A keyboard shortcut hint: mono, faint, no box. */
export const Kbd = ({ className, ...props }: ComponentProps<"kbd">) => (
  <kbd className={cn("font-mono text-xs font-medium text-faint", className)} {...props} />
);
