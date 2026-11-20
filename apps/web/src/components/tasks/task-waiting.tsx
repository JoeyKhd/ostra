"use client";

import { useQuery } from "@tanstack/react-query";
import { HourglassIcon } from "lucide-react";

import type { ProjectId } from "@ostra/protocol";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { boxWaitText, waitLine } from "./task-waiting-words";
import type { QueuePlace, Waiting } from "./task-waiting-words";

/**
 * The task's waiting line (F-067, F-069, F-093; milestone 5's ticket 33): its place in its pool's
 * queue and why it waits, a box waiting for a node, or who cancelled it from the queue. Every word
 * from `messages/en.json`; the server sends codes and IDs only (F-083).
 */
export const TaskWaiting = ({ projectId, project, waiting, queue, boxWaiting, runnerId, cancelledBy, now }: {
  readonly projectId: ProjectId;
  readonly project: string;
  readonly waiting: Waiting | null;
  readonly queue: QueuePlace | null;
  readonly boxWaiting: { readonly reason: "node" | "image-pull"; readonly since: number } | null;
  /** The personal runner the task was sent to, if any. */
  readonly runnerId: string | null;
  /** `undefined` when it wasn't cancelled; `null` when its canceller isn't known by name. */
  readonly cancelledBy: string | null | undefined;
  readonly now: number;
}) => {
  const trpc = useTRPC();
  const waits = waiting !== null || queue !== null;
  const runners = useQuery({ ...trpc.projects.runners.queryOptions({ projectId }), enabled: waits });
  const names = useQuery({ ...trpc.pools.names.queryOptions(), enabled: waits });
  const personal = waiting?.kind === "no-runner" && waiting.reason.code === "personal-runner-unavailable";
  const mine = useQuery({ ...trpc.runners.mine.queryOptions(), enabled: personal });
  const runner = mine.data?.find((item) => item.id === runnerId);
  const line = waitLine(waiting, queue, {
    project,
    poolNames: runners.data?.pools.map((pool) => pool.name) ?? [],
    poolName: (poolId) => names.data?.find((pool) => pool.id === poolId)?.name ?? (queue?.poolId === poolId ? queue.poolName : ""),
    personal: runner === undefined ? null : { name: runner.name, busy: runner.busy, slots: runner.capacity },
  });
  if (cancelledBy !== undefined) {
    return (
      <p className="mt-1.5 text-ui text-muted" data-testid="task-wait-line">
        {cancelledBy === null ? t("waitLine.cancelledBySomeone") : t("waitLine.cancelledBy", { name: cancelledBy })}
      </p>
    );
  }
  if (boxWaiting !== null) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-ui text-muted" data-testid="task-box-waiting">
        <HourglassIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-faint" />
        {boxWaitText(boxWaiting, now)}
      </p>
    );
  }
  // Until the project's name has loaded, a line that names it would read "· is at its share".
  return line === null || project === "" ? null : <p className="mt-1.5 text-ui text-muted" data-testid="task-wait-line">{line}</p>;
};
