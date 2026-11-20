import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's button, restyled to graphite (graphite.css `.btn`):
// - `outline` (the default): `--surface` with a `--control-line` border (3:1, ticket 17), for every ordinary action.
// - `primary`: the Shell fill, at most one per page.
// - `amber`: only the one action that answers what needs you (an approval), never anything else.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-50 [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline: "border-control-line bg-surface text-text hover:bg-sel",
        primary: "border-primary bg-primary font-semibold text-on-primary hover:border-primary/88 hover:bg-primary/88",
        amber: "border-amber bg-amber font-semibold text-on-amber hover:brightness-95",
        danger: "border-control-line bg-surface text-red hover:bg-sel",
        ghost: "border-transparent bg-transparent text-muted hover:bg-sel hover:text-text",
        link: "h-auto border-transparent bg-transparent p-0 text-teal hover:underline",
      },
      size: {
        default: "h-[30px] px-3 text-ui",
        sm: "h-[26px] rounded-sm px-2.5 text-sm",
        lg: "h-[34px] px-3.5 text-body",
        // The auth pages' one full-width button (sign-in.md): 36px.
        xl: "h-[36px] px-[14px] text-body",
        icon: "size-[30px] p-0",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { readonly asChild?: boolean };

export const Button = ({ className, variant, size, asChild = false, ...props }: ButtonProps) => {
  const Component = asChild ? Slot.Root : "button";
  // `data-slot`: a link drawn as a button is a control too (the touch size in globals.css, F-075).
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
};
