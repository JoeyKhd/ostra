"use client";

import { ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { waitingText } from "./attach-words";
import type { SendState } from "./attach-words";

// The message box with its attachments (composer-attachments.md, "The box", "Narrow and phone
// width"). On a desktop: the words, the tray 12px under them, the note line 10px under that, then
// the controls row (the paperclip, the hint, the buttons) in one bordered box. Below 768 the box
// docks under the chat: the tray and its note above, then one row of the 44px paperclip, the field
// in its own border and the 44px send. One DOM for both: the row's parts move by their `order`.

export const ComposerBox = ({ field, tray, note, attach, hint, actions, phoneSend, focused = false, className, ...rest }: {
  /** The words' field (assistant-ui's input on the task page, a textarea elsewhere). */
  readonly field: ReactNode;
  readonly tray: ReactNode;
  readonly note: ReactNode;
  /** The paperclip, or nothing for a member who can't send. */
  readonly attach: ReactNode;
  readonly hint: ReactNode;
  /** `Interrupt and send`, `Send`, `Reopen`: a desktop's buttons. */
  readonly actions: ReactNode;
  /** The dock's 44px send; `null` keeps the desktop's buttons in the dock (Reopen, which says what it does). */
  readonly phoneSend: ReactNode | null;
  /** Draws the focus ring as if the field had it (a still render). */
  readonly focused?: boolean;
  readonly className?: string;
  readonly "data-part"?: string;
}) => (
  <div
    {...rest}
    className={cn(
      "focus-box flex flex-wrap items-center rounded-lg border border-control-line bg-surface px-3.5 py-3",
      "max-md:items-end max-md:gap-x-2 max-md:rounded-none max-md:border-0 max-md:border-t max-md:border-line max-md:bg-bg max-md:px-2.5 max-md:pb-3.5 max-md:pt-2.5 max-md:outline-none",
      focused && "outline-2 outline-offset-1 outline-teal max-md:outline-none",
      className,
    )}
  >
    <div
      className={cn(
        "order-1 w-full min-w-0",
        "max-md:order-5 max-md:w-auto max-md:flex-1 max-md:rounded-[10px] max-md:border max-md:border-control-line max-md:bg-surface max-md:px-3 max-md:py-[10px] max-md:has-[:focus-visible]:outline-2 max-md:has-[:focus-visible]:outline-offset-1 max-md:has-[:focus-visible]:outline-teal max-md:[&_textarea]:text-[15px] max-md:[&_textarea]:leading-[21px]",
        focused && "max-md:outline-2 max-md:outline-offset-1 max-md:outline-teal",
      )}
    >
      {field}
    </div>
    <div className="order-2 w-full min-w-0 md:has-[[role=list]]:mt-3 max-md:order-1">{tray}</div>
    <div className="order-3 w-full min-w-0 empty:hidden md:mt-2.5 max-md:order-2 max-md:mb-2.5 max-md:pl-0.5">{note}</div>
    <div className="order-4 mt-2 flex w-full min-w-0 items-center gap-2 max-md:contents">
      <span className="flex shrink-0 max-md:order-4">{attach}</span>
      <span className="flex min-w-0 flex-1 max-md:hidden">{hint}</span>
      <span className={cn("flex shrink-0 items-center gap-2", phoneSend === null ? "max-md:order-6" : "max-md:hidden")}>{actions}</span>
      {phoneSend === null ? null : <span className="hidden shrink-0 max-md:order-6 max-md:flex">{phoneSend}</span>}
    </div>
  </div>
);

/** Send's face: the arrow and `Send`, or, while it waits for uploads, the spinner and `Uploading 1 of 2…`. */
export const SendFace = ({ state, label }: { readonly state: SendState; readonly label: string }) =>
  state.kind === "waiting" ? (
    <>
      <span aria-hidden className="inline-block size-[13px] shrink-0 animate-spin rounded-full border-[1.75px] border-current border-r-transparent opacity-80" />
      {waitingText(state)}
    </>
  ) : (
    <>
      <ArrowUpIcon aria-hidden />
      {label}
    </>
  );

/** The dock's 44px send: the arrow alone, the spinner while it waits. */
export const PhoneSendButton = ({ state, onPress }: { readonly state: SendState; readonly onPress: () => void }) => (
  <Button
    type="button"
    variant="primary"
    aria-label={state.kind === "waiting" ? waitingText(state) : t("task.composer.send")}
    disabled={state.kind === "empty" || state.kind === "blocked"}
    onClick={onPress}
    className="size-11 rounded-[10px] p-0 [&_svg]:size-[19px]"
    data-action="send-phone"
  >
    {state.kind === "waiting" ? (
      <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent opacity-80" />
    ) : (
      <ArrowUpIcon aria-hidden />
    )}
  </Button>
);
