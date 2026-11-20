import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

export const fieldClass =
  "w-full rounded-md border border-control-line bg-surface px-2.5 text-body text-text placeholder:text-faint focus-visible:border-faint aria-invalid:border-red disabled:opacity-60";

export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input className={cn(fieldClass, "h-[34px]", className)} {...props} />
);

export const Textarea = ({ className, ...props }: ComponentProps<"textarea">) => (
  <textarea className={cn(fieldClass, "min-h-20 py-2 leading-normal", className)} {...props} />
);
