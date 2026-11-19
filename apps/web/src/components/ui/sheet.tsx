"use client";

import { XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// shadcn/ui's sheet: a drawer from the left (the sidebar at phone width) or the right (a form).
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export type SheetContentProps = ComponentProps<typeof Dialog.Content> & {
  readonly side?: "left" | "right";
  readonly title: string;
  /** The close button in the corner. The sidebar drawer leaves it out: its own header sits there. */
  readonly closeButton?: boolean;
  readonly children: ReactNode;
};

export const SheetContent = ({ side = "right", title, closeButton = true, className, children, ...props }: SheetContentProps) => (
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
    <Dialog.Content
      aria-describedby={undefined}
      className={cn(
        "fixed inset-y-0 z-50 flex w-[min(340px,88vw)] flex-col border-line bg-side shadow-xl focus:outline-none",
        side === "left" ? "left-0 border-r" : "right-0 border-l",
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
