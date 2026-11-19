"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's select, restyled to graphite: a 28px trigger with a `--line-2` border and a 7px
// radius, and the dropdown menu's `--raise` panel for its list.
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) => (
  <SelectPrimitive.Trigger
    className={cn(
      "inline-flex h-7 min-w-0 items-center gap-2 rounded-md border border-line-2 bg-transparent px-2.5 text-left text-body text-text outline-none hover:bg-raise focus-visible:border-faint disabled:opacity-50 data-[placeholder]:text-faint [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDownIcon aria-hidden className="ml-auto text-muted" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
);

export const SelectContent = ({ className, children, position = "popper", sideOffset = 4, ...props }: ComponentProps<typeof SelectPrimitive.Content>) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      position={position}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
);

export const SelectItem = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) => (
  <SelectPrimitive.Item
    className={cn(
      "relative flex h-7 cursor-default select-none items-center gap-2 rounded-sm pl-2 pr-7 text-text outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-sel [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText asChild>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
      <CheckIcon aria-hidden />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
);

export const SelectSeparator = ({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) => (
  <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />
);
