"use client";

import { CircleXIcon, PauseCircleIcon } from "lucide-react";

import type { TurnFailure, TurnNotice } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { useThreadParts } from "./thread-context";
import { failureWords, noticeWords } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a failure the turn didn't recover from, and a stop that
// isn't an error, parts.md part 7). Ticket 09's stubs, with their final props: the red line and
// the quiet one, their words from `words.ts`. Ticket 10 adds `details ›` and the notices' teal actions
// (`Keep working`, `Open spend`); until then the needs-you block at the thread's end holds them.

/** A failure's own line: `circle-x` and the words in `--red`, the subject mono, what happened `--muted`. */
export const FailureLine = ({ failure, retried = false }: { readonly failure: TurnFailure; readonly retried?: boolean }) => {
  const { agent } = useTaskContext();
  const words = failureWords(failure, t, { agent: agent.name, retried });
  return (
    <div data-part="failure" data-cause={failure.cause} className="-mt-0.5 mb-2 flex min-h-7 items-center gap-2 text-ui text-muted">
      <CircleXIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-red">{words.title}</span>
        {words.subject === null ? null : <span className="min-w-0 truncate font-mono text-[13px] text-text-2" title={words.subject}>{words.subject}</span>}
        {words.detail === null ? null : <span className="min-w-0 truncate text-muted">· {words.detail}</span>}
      </span>
    </div>
  );
};

/** A stop that isn't an error (`.notice`): a session limit, a budget hold, an approval nobody answered in time. */
export const NoticeLine = ({ notice }: { readonly notice: TurnNotice }) => {
  const { project, capMicroUsd } = useThreadParts();
  const words = noticeWords(notice, t, { project, capMicroUsd });
  return (
    <div data-part="notice" data-cause={notice.cause} className="mb-2 mt-0.5 flex min-h-7 items-center gap-2 text-ui text-muted">
      <PauseCircleIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-muted" />
      <span className="min-w-0 truncate">{words.text}</span>
    </div>
  );
};
