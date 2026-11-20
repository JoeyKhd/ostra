"use client";

import { useQuery } from "@tanstack/react-query";

import { projectIdSchema } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { HomeBoard } from "./home-board";
import type { BoardLoad } from "./home-board";
import type { BoardCard, BoardColumnData, BoardColumnId, BoardData, CardStatus, RunningActivity } from "./board-words";
import type { NeedsYouDetail } from "./home-words";

// Ticket 44 wired (home-board.md; F-062): `home.board` drawn by the board's parts. The API's cards
// are read here once into the board's own view of them.

type Board = RouterOutputs["home"]["board"];
type ApiCard = Board["columns"][number]["cards"][number];
type ApiStatus = ApiCard["status"];
type Reason = NonNullable<Extract<ApiStatus, { kind: "needs-you" }>["reason"]>;

/** A reason's line with nothing more known than the reason itself. */
export const bareDetail = (reason: Reason): NeedsYouDetail => {
  switch (reason) {
    case "question":
      return { reason, question: null };
    case "approval":
      return { reason, command: null, subject: null, ruleName: null };
    case "plan":
      return { reason, steps: null };
    case "draft_ready":
      return { reason, prNumber: null };
    case "setup_failed":
      return { reason, exitCode: null };
    case "stalled":
      return { reason, minutes: 0 };
    case "ticket_closed":
      return { reason, status: null };
    case "no_provider_for_model":
      // The board's status carries no model name; the needs-you list has it.
      return { reason, modelName: null, provider: null };
    case "crashed":
    case "environment_proposal":
    case "files_outside_repos":
    case "runner_awaiting_approval":
    case "no_changes":
    case "restore_conflict":
    case "round_cap":
    case "spend_cap":
    case "unstorable_event":
    case "waiting_for_reviewer":
      return { reason };
    default:
      return reason satisfies never;
  }
};

const activityOf = (doing: Extract<ApiStatus, { kind: "running" }>["doing"]): RunningActivity | null => {
  const detail = doing?.detail ?? null;
  if (doing === null || detail === null) return null;
  switch (doing.toolKind) {
    case "execute":
      return { verb: "running", subject: detail };
    case "edit":
      return { verb: "editing", subject: detail };
    case "read":
      return { verb: "reading", subject: detail };
    case "delete":
    case "fetch":
    case "move":
    case "other":
    case "search":
    case "switch_mode":
    case "think":
    case null:
      return null;
    default:
      return doing.toolKind satisfies never;
  }
};

export const cardStatusOf = (status: ApiStatus): CardStatus => {
  switch (status.kind) {
    case "needs-you":
      return { kind: "needs-you", detail: status.view?.detail ?? bareDetail(status.reason ?? "crashed") };
    case "queued":
      return { kind: "queued", on: status.runner?.personal === true ? { kind: "personal" } : { kind: "pool", name: status.pools[0] ?? status.runner?.name ?? "" } };
    case "running":
      return { kind: "running", activity: activityOf(status.doing) };
    case "preparing":
      return { kind: "preparing", step: null };
    case "in-review":
      return { kind: "in-review", prs: status.prNumbers, step: null };
    case "finished":
      return status.outcome === "merged"
        ? { kind: "merged", prs: status.prNumbers }
        : status.outcome === "done"
          ? { kind: "done" }
          : { kind: "stopped", reason: status.stopReason === "spend_cap" ? { kind: "spend-cap" } : status.stoppedBy !== null ? { kind: "by", name: status.stoppedBy.name } : null };
    default:
      return status satisfies never;
  }
};

export const boardCardOf = (card: ApiCard): BoardCard => ({
  taskId: card.taskId,
  project: card.project,
  key: card.key,
  title: card.title,
  driver: card.driver?.name ?? null,
  since: card.enteredAt,
  status: cardStatusOf(card.status),
});

export const boardDataOf = (board: Board): BoardData => {
  const columnOf = (id: BoardColumnId): BoardColumnData => {
    const page = board.columns.find((column) => column.column === id);
    return { total: page?.total ?? 0, cards: (page?.cards ?? []).map(boardCardOf), next: page?.nextCursor ?? null };
  };
  return { "needs-you": columnOf("needs-you"), queued: columnOf("queued"), running: columnOf("running"), "in-review": columnOf("in-review"), finished: columnOf("finished") };
};

export const HomeBoardView = ({ projectId, projectName, now }: { readonly projectId: string | null; readonly projectName: string | null; readonly now: number }) => {
  const trpc = useTRPC();
  const board = useQuery({ ...trpc.home.board.queryOptions(projectId === null ? {} : { projectId: projectIdSchema.parse(projectId) }), refetchInterval: 30_000 });
  const load: BoardLoad =
    board.data !== undefined ? { kind: "ready", data: boardDataOf(board.data) } : board.isError ? { kind: "error", retry: () => void board.refetch() } : { kind: "loading" };
  return <HomeBoard load={load} now={now} onMore={() => undefined} projectName={projectName} />;
};

