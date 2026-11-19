import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The panel's own type sizes (`--text-body`, `--text-lede`, `--text-title` in globals.css). Without
// them tailwind-merge reads `text-body` as a colour, and drops the `text-ink` before it.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["body", "lede", "title"] }] } },
});

/** Joins class names, letting a later Tailwind class win over an earlier one (shadcn/ui's `cn`). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
