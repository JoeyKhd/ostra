"use client";

import { DropdownMenu as Menu } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's dropdown menu, restyled to graphite: a `--raise` panel, `--line-2` border, 26px rows.
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export const DropdownMenuContent = ({ className, sideOffset = 4, ...props }: ComponentProps<typeof Menu.Content>) => (
  <Menu.Portal>
    <Menu.Content
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[200px] rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none",
        className,
      )}
      {...props}
    />
  </Menu.Portal>
);

export const DropdownMenuItem = ({ className, ...props }: ComponentProps<typeof Menu.Item>) => (
  <Menu.Item
    className={cn(
      "flex h-[28px] cursor-default select-none items-center gap-[9px] rounded-sm px-2 text-text outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-sel [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
      className,
    )}
    {...props}
  />
);

export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof Menu.Label>) => (
  <Menu.Label className={cn("px-2 pb-1 pt-1.5 text-xs font-medium text-faint", className)} {...props} />
);

export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof Menu.Separator>) => (
  <Menu.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />
);
