"use client";

import { XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// shadcn/ui's sheet: a drawer from the left (the sidebar at phone width), the right (a form) or the
// bottom (a popover's contents at phone width: take it local).
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export type SheetContentProps = ComponentProps<typeof Dialog.Content> & {
  readonly side?: "left" | "right" | "bottom";
  readonly title: string;
  /** The close button in the corner. The sidebar drawer leaves it out: its own header sits there. */
  readonly closeButton?: boolean;
  readonly children: ReactNode;
};

export const SheetContent = ({ side = "right", title, closeButton = true, className, children, ...props }: SheetContentProps) => (
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
    <Dialog.Content
      aria-describedby={undefined}
      className={cn(
        "fixed z-50 flex flex-col border-line bg-side shadow-xl focus:outline-none",
        side === "bottom" ? "inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[10px] border-t" : "inset-y-0 w-[min(340px,88vw)]",
        side === "left" ? "left-0 border-r" : side === "right" ? "right-0 border-l" : null,
        className,
      )}
      {...props}
    >
      <Dialog.Title className="sr-only">{title}</Dialog.Title>
      {children}
      {closeButton ? (
        <Dialog.Close
          className="absolute right-3 top-3 rounded-sm p-1 text-faint hover:text-text"
          aria-label={t("common.close")}
        >
          <XIcon className="size-4" />
        </Dialog.Close>
      ) : null}
    </Dialog.Content>
  </Dialog.Portal>
);
