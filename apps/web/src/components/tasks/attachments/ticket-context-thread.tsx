"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SendIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { TicketContextView } from "@ostra/api";
import type { MessageFileId, TaskId } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { trackerName } from "@/components/tasks/task-ticket";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { useTaskContext } from "@/task/task-context";

import { useAttachments } from "./attachments-context";
import { TicketContextMessage, TicketContextRow } from "./ticket-context-message";
import { updatesAnswerOf, updatesAnswerText } from "./ticket-context-words";

// The ticket's context on the task page (F-149, ticket 16): "What the agent got" in the thread, the
// Ticket group's `Context` row, and the driver's two presses, Retry and "Send ticket updates". A
// press answers at once with the round it follows; its answer is the next round, which the page
// reads again until it lands ("nothing new" among them).

/** The tracker's name, from its kind (`linear`); the ticket's own name when it's gone. */
export const trackerLabel = (view: Pick<TicketContextView, "tracker">): string => (view.tracker === null ? t("taskPage.fromTicket") : trackerName(view.tracker));

/** How often the page reads the ticket's context again while a press waits for its round, and for how long. */
const PRESS_POLL_MS = 1500;
const PRESS_WAIT_MS = 120_000;

/**
 * A press of Retry or "Send ticket updates": the call, then the ticket's context read again until
 * the round after `afterRound` lands. `answered` is that round's number once it has.
 */
export const useTicketPress = (taskId: TaskId, press: "retry" | "updates") => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [after, setAfter] = useState<{ readonly round: number; readonly since: number } | null>(null);
  const procedure = press === "retry" ? trpc.tasks.retryTicketFiles : trpc.tasks.ticketUpdates;
  const mutation = useMutation(procedure.mutationOptions({ onSuccess: (answer) => { setAfter({ round: answer.afterRound, since: Date.now() }); } }));
  const context = useQuery(
    trpc.tasks.ticketContext.queryOptions(
      { taskId },
      { refetchInterval: (query) => (after !== null && (query.state.data?.rounds.length ?? 0) <= after.round && Date.now() - after.since < PRESS_WAIT_MS ? PRESS_POLL_MS : false) },
    ),
  );
  const rounds = context.data?.rounds ?? [];
  const landed = after !== null && rounds.some((round) => round.round > after.round);
  useEffect(() => {
    if (!landed) return;
    // The round's files (a Retry's fetched ones, an update's): read the task's files again.
    void queryClient.invalidateQueries({ queryKey: trpc.tasks.files.queryKey({ taskId }) });
  }, [landed, queryClient, trpc, taskId]);
  return {
    run: () => { mutation.mutate({ taskId }); },
    pending: mutation.isPending || (after !== null && !landed && Date.now() - after.since < PRESS_WAIT_MS),
    after: after?.round ?? null,
    error: mutation.error === null ? null : (errorText(mutation.error) ?? t("errors.unknown")),
  };
};

/** A file of the task by its ID, from `tasks.files`. */
const useFileOf = (): ((fileId: MessageFileId) => MessageFileView | undefined) => {
  const context = useAttachments();
  const files = context?.files ?? [];
  return (fileId) => files.find((file) => file.fileId === fileId);
};

/**
 * "What the agent got" in the thread, from the task's ticket context: the first bubble (milestone
 * 10), with the member its message is written as and its time over it, and the ticket's title.
 */
export const ThreadTicketContext = ({ taskId, now, by = null, at = null, title = null }: {
  readonly taskId: TaskId;
  readonly now: number;
  readonly by?: string | null;
  readonly at?: number | null;
  readonly title?: string | null;
}) => {
  const context = useAttachments();
  const { agent } = useTaskContext();
  const fileOf = useFileOf();
  const retry = useTicketPress(taskId, "retry");
  const view = context?.ticketContext ?? null;
  if (view === null) return null;
  const first = view.rounds[0];
  // Retry's answer, read out once: the files it loaded, or that they failed again.
  const retried = retry.after === null ? null : (first?.attachments.filter((one) => one.state === "failed" && one.retry !== null) ?? []);
  const loaded = retried?.filter((one) => one.state === "failed" && one.retry?.state === "ready").length ?? 0;
  return (
    <>
      <TicketContextMessage
        view={view}
        tracker={trackerLabel(view)}
        agent={agent.name}
        now={now}
        retry={view.isDriver && (view.canRetry || retry.pending) ? { run: retry.run, pending: retry.pending } : null}
        fileOf={fileOf}
        onOpenImage={context === null ? null : context.openFile}
        by={by}
        at={at}
        title={title}
      />
      {retry.error === null ? null : <p role="alert" className="-mt-3 mb-3 text-right text-sm text-red">{retry.error}</p>}
      <p className="sr-only" aria-live="polite" data-testid="ticket-retry-live">
        {retried === null || retry.pending ? "" : loaded > 0 ? plural(loaded, "task.ticketContext.loadedOne", "task.ticketContext.loaded") : t("task.ticketContext.loadedNone")}
      </p>
    </>
  );
};

/** The Ticket group's rows for the context: `Context`, and "Send ticket updates" with its answer for the driver. */
export const TicketContextRows = ({ taskId, agent }: { readonly taskId: TaskId; readonly agent: string }) => {
  const trpc = useTRPC();
  const files = useQuery(trpc.tasks.files.queryOptions({ taskId }));
  const ticket = useQuery(trpc.tasks.ticketContext.queryOptions({ taskId }));
  const updates = useTicketPress(taskId, "updates");
  const view = ticket.data ?? null;
  const first = view?.rounds[0];
  if (view === null || first === undefined) return null;
  const fileOf = (fileId: MessageFileId) => files.data?.files.find((file) => file.fileId === fileId);
  const answer = updates.after === null ? null : updatesAnswerOf(view.rounds, updates.after);
  return (
    <>
      <TicketContextRow round={first} fileOf={fileOf} onShow={() => { document.getElementById("ticket-context")?.scrollIntoView({ block: "start", behavior: "smooth" }); }} />
      {view.canSendUpdates || updates.after !== null ? (
        <div className="mt-1.5" data-testid="ticket-updates">
          <Button variant="link" className="h-auto gap-1.5 px-0 text-ui" disabled={updates.pending || !view.canSendUpdates} onClick={updates.run} data-action="send-ticket-updates">
            <SendIcon aria-hidden className="size-[14px]" />
            {updates.pending ? t("task.ticketContext.sendingUpdates") : t("task.ticketContext.sendUpdates")}
          </Button>
          {answer === null ? null : (
            <p className="mt-1 text-sm text-muted" aria-live="polite" data-testid="ticket-updates-answer" data-answer={answer.kind}>
              {updatesAnswerText(answer, agent, trackerLabel(view))}
            </p>
          )}
          {updates.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{updates.error}</p>}
        </div>
      ) : null}
    </>
  );
};
