import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names, letting a later Tailwind class win over an earlier one (shadcn/ui's `cn`). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
