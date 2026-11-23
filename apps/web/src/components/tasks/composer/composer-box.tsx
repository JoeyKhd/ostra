"use client";

import { ArrowUpIcon } from "lucide-react";

import { waitingText } from "./attach-words";
import type { SendState } from "./attach-words";

// Send's face on the boxes that start a task (the new task's and a project's): the arrow and its
// words, or the spinner and `Uploading 1 of 2…` while Send waits for uploads (composer-attachments.md,
// "The box"). The task page's box is milestone 10's one box (`task/thread/composer.tsx`).

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
