"use client";

import { AlertDialog as Dialog } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { buttonVariants } from "./button";

// shadcn/ui's alert dialog, graphite: a confirmation before something that can't be undone. The
// action is `--red` text on `--surface` (the `danger` button), never a filled red.
export const AlertDialog = Dialog.Root;
export const AlertDialogTrigger = Dialog.Trigger;

export type AlertDialogContentProps = {
  readonly title: string;
  readonly body: ReactNode;
  readonly cancel: string;
  readonly action: string;
  readonly onAction: () => void;
  /**
   * The action runs while the dialog stays open (members.md, "Remove"): the action reads `busy`'s
   * label, both buttons are disabled, and `error` shows inside. The caller closes it on success.
   */
  readonly pending?: { readonly busy: boolean; readonly label: string; readonly error: string | null };
};

export const AlertDialogContent = ({ title, body, cancel, action, onAction, pending }: AlertDialogContentProps) => (
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none">
      <Dialog.Title className="text-[16.5px] font-semibold text-text">{title}</Dialog.Title>
      <Dialog.Description asChild>
        <div className="mt-1.5 text-body text-muted">{body}</div>
      </Dialog.Description>
      {pending?.error === null || pending?.error === undefined ? null : (
        <p role="alert" className="mt-3 text-sm text-red">{pending.error}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Dialog.Cancel className={buttonVariants()} disabled={pending?.busy === true}>{cancel}</Dialog.Cancel>
        <Dialog.Action
          className={cn(buttonVariants({ variant: "danger" }))}
          disabled={pending?.busy === true}
          onClick={(event) => {
            if (pending !== undefined) event.preventDefault();
            onAction();
          }}
        >
          {pending?.busy === true ? pending.label : action}
        </Dialog.Action>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
);
