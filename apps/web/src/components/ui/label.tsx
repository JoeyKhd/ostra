"use client";

import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

export const Label = ({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) => (
  <LabelPrimitive.Root className={cn("mb-1.5 block text-sm font-medium text-muted", className)} {...props} />
);
