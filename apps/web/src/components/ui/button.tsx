import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's button, restyled to graphite (app-design.md): at most one primary (Shell) per page.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-50 [&_svg]:size-[14px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-line-2 bg-surface text-text hover:bg-sel",
        primary: "border-shell bg-shell font-semibold text-ink hover:bg-[#e6e2d8]",
        amber: "border-amber bg-amber font-semibold text-ink hover:brightness-95",
        danger: "border-line-2 bg-surface text-red hover:bg-sel",
        ghost: "border-transparent bg-transparent text-muted hover:bg-sel hover:text-text",
        link: "h-auto border-transparent bg-transparent p-0 text-teal hover:underline",
      },
      size: {
        default: "h-7 px-[11px] text-[12.5px]",
        sm: "h-6 rounded-sm px-[9px] text-sm",
        lg: "h-8 px-3.5 text-body",
        icon: "size-7 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { readonly asChild?: boolean };

export const Button = ({ className, variant, size, asChild = false, ...props }: ButtonProps) => {
  const Component = asChild ? Slot.Root : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
};
