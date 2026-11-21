"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { clientMessageIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { PreviewSpinner } from "./preview-state";

// The steer bar over the expanded preview (task-preview.md, "Expanded"; `task-preview-expanded`,
// approved over the folded thread): what the agent is doing now, and a one-line composer whose
// message lands in the thread as the composer's would. It follows the composer's rules: no driver
// right, no field; a member who isn't the driver sees `Take over` instead.

export type SteerBarProps = {
  readonly taskId: TaskId;
  readonly agent: string;
  /** The agent's activity now (`Editing src/history/panel.css`), or empty. */
  readonly activity: string;
  readonly working: boolean;
  /** `CALC-192 · Running`. */
  readonly status: string;
  readonly canSend: boolean;
  /** A member who isn't the driver: `Take over`; `null` when they can't either. */
  readonly takeOver: { readonly run: () => void; readonly pending: boolean } | null;
};

export const PreviewSteerBar = ({ taskId, agent, activity, working, status, canSend, takeOver }: SteerBarProps) => {
  const trpc = useTRPC();
  const send = useMutation(trpc.tasks.send.mutationOptions());
  const [text, setText] = useState("");
  const submit = () => {
    const words = text.trim();
    if (words === "" || send.isPending) return;
    send.mutate(
      { taskId, clientMessageId: clientMessageIdSchema.parse(crypto.randomUUID()), text: words, delivery: "queue" },
      { onSuccess: () => { setText(""); } },
    );
  };
  return (
    <div
      data-testid="preview-steer-bar"
      className="absolute bottom-[46px] left-1/2 z-[3] w-[760px] max-w-[calc(100%-32px)] -translate-x-1/2 rounded-xl border border-line-2 bg-raise py-2.5 pl-3.5 pr-2.5 shadow-(--shadow-palette)"
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 text-[13.5px] text-muted">
        {working ? <PreviewSpinner /> : null}
        <span className="min-w-0 truncate">
          {agent}
          {activity === "" ? null : <> · <span className="text-text">{activity}</span></>}
        </span>
        <span className="ml-auto shrink-0 text-faint">{status}</span>
      </div>
      {canSend ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            value={text}
            onChange={(event) => { setText(event.target.value); }}
            placeholder={t("task.preview.steer.placeholder")}
            aria-label={t("task.preview.steer.placeholder")}
            data-part="composer"
            className="h-9 min-w-0 flex-1 rounded-lg border border-control-line bg-surface px-3 text-body text-text placeholder:text-faint"
          />
          <Button type="submit" variant="primary" disabled={send.isPending || text.trim() === ""}>
            <ArrowUpIcon aria-hidden /> {t("task.preview.steer.send")}
          </Button>
        </form>
      ) : takeOver === null ? null : (
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] text-muted">{t("task.preview.steer.notDriver")}</span>
          <Button className="ml-auto" onClick={takeOver.run} disabled={takeOver.pending} data-action="take-over">{t("taskPage.takeOver")}</Button>
        </div>
      )}
      {send.error === null ? null : <p role="alert" className="mt-1.5 text-[12.5px] text-red">{errorText(send.error)}</p>}
    </div>
  );
};
