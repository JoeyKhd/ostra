"use client";

import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's dropdown menu, restyled to graphite: a `--raise` panel, `--line-2` border, 28px rows.
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export const DropdownMenuContent = ({ className, sideOffset = 4, ...props }: ComponentProps<typeof Menu.Content>) => (
  <Menu.Portal>
    <Menu.Content
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[200px] rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-(--shadow-pop) focus:outline-none",
        className,
      )}
      {...props}
    />
  </Menu.Portal>
);

export const DropdownMenuItem = ({ className, ...props }: ComponentProps<typeof Menu.Item>) => (
  <Menu.Item
    className={cn(
      "flex h-[28px] cursor-default select-none items-center gap-[9px] rounded-sm px-2 text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-teal data-[disabled]:opacity-50 data-[highlighted]:bg-sel [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
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

export const DropdownMenuRadioGroup = Menu.RadioGroup;

/** A choice of one (members.md, the row menu's role): its label, and a check at the right on the current one. */
export const DropdownMenuRadioItem = ({ className, children, ...props }: ComponentProps<typeof Menu.RadioItem>) => (
  <Menu.RadioItem
    className={cn(
      "flex h-[28px] cursor-default select-none items-center gap-[9px] rounded-sm px-2 text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-teal data-[disabled]:opacity-50 data-[highlighted]:bg-sel [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
      className,
    )}
    {...props}
  >
    {children}
    <Menu.ItemIndicator className="ml-auto flex">
      <CheckIcon aria-hidden className="text-text" />
    </Menu.ItemIndicator>
  </Menu.RadioItem>
);

/** A submenu (the member menu's Theme): its row opens a second panel beside the first. */
export const DropdownMenuSub = Menu.Sub;

export const DropdownMenuSubTrigger = ({ className, children, ...props }: ComponentProps<typeof Menu.SubTrigger>) => (
  <Menu.SubTrigger
    className={cn(
      "flex h-[28px] cursor-default select-none items-center gap-[9px] rounded-sm px-2 text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-teal data-[disabled]:opacity-50 data-[highlighted]:bg-sel data-[state=open]:bg-sel [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRightIcon aria-hidden className="ml-auto" />
  </Menu.SubTrigger>
);

export const DropdownMenuSubContent = ({ className, sideOffset = 6, ...props }: ComponentProps<typeof Menu.SubContent>) => (
  <Menu.Portal>
    <Menu.SubContent
      sideOffset={sideOffset}
      className={cn("z-50 min-w-[180px] rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-(--shadow-pop) focus:outline-none", className)}
      {...props}
    />
  </Menu.Portal>
);
