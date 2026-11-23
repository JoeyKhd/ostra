"use client";

import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import type { ReactNode } from "react";

import type { BoardId } from "@ostra/protocol";

import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { tNodes } from "@/lib/message-nodes";

import { promptTicketsState } from "./board-words";
import type { BoardView, BoardsData } from "./board-words";

// F-097/c2 (Q31, prompt-tickets.md): the Boards page's "Prompt tasks" section. One switch makes a
// ticket for every task a member starts from a prompt, on one of the boards attached just above;
// with several, a picker names it. Both apply at once, as "Start from Linear" does: `Save mapping`
// stays the mapping's. Members read it; nothing here waits on anyone, so nothing is amber.

/** A board as the picker and its read-only twin name it: its tracker's mark, the name, ` · ` and the key in mono. */
const BoardName = ({ board }: { readonly board: BoardView }) => (
  <>
    <TrackerMark kind={board.connection.kind} size={trackerMarkAt.boardSelect.size} label={false} />
    <span className="truncate">{board.name}</span>
    {board.key === null ? null : <span className="font-mono text-sm text-muted">· {board.key}</span>}
  </>
);

const Bold = ({ children }: { readonly children: ReactNode }) => <b className="font-medium text-text">{children}</b>;

export type PromptTicketsProps = {
  readonly view: BoardsData;
  /** The board selected on the page (`?board=`, else the first attached): turning it on picks it. */
  readonly selected: BoardView | undefined;
  /** Saves the setting: a board, or `null` for off. */
  readonly onSet: (boardId: BoardId | null) => void;
  /** `setPromptTickets` hasn't answered: the switch and the picker rest until it has. */
  readonly pending: boolean;
  /** The server's reason a save failed, shown under the row; the row shows what's saved. */
  readonly error: string | null;
  /** An organization admin, who gets `Reconnect Linear →` while the connection isn't active. */
  readonly organizationAdmin: boolean;
};

/** The setting's row: the switch, its label and the sentence that says what happens to the next prompt task. */
export const PromptTickets = ({ view, selected, onSet, pending, error, organizationAdmin }: PromptTicketsProps) => {
  const id = useId();
  const state = promptTicketsState(view);
  const on = state.kind === "on" || state.kind === "paused";
  const board = state.kind === "on" || state.kind === "paused" ? state.board : undefined;
  const several = view.boards.length > 1;
  const explanation = ((): ReactNode => {
    switch (state.kind) {
      case "none":
        return t("boards.promptTickets.none");
      case "off":
        return tNodes("boards.promptTickets.off", { createTicket: <Bold>{t("taskPage.createTicket")}</Bold> });
      case "on":
        return tNodes("boards.promptTickets.on", { board: <Bold>{state.board.name}</Bold> });
      case "paused":
        return (
          <>
            {tNodes("boards.promptTickets.paused", { board: <Bold>{state.board.name}</Bold> })}
            {organizationAdmin ? (
              <>
                {" "}
                <Link href="/organization/trackers" className="inline-flex items-center gap-1 whitespace-nowrap text-teal hover:underline">
                  {t("boards.promptTickets.reconnect")}
                  <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                </Link>
              </>
            ) : null}
          </>
        );
      default:
        return state satisfies never;
    }
  })();

  return (
    <div data-testid="prompt-tickets" data-state={state.kind}>
      <div className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 border-y border-line px-2 pb-3.5 pt-[13px] max-sm:grid-cols-[34px_minmax(0,1fr)] max-sm:px-0.5 max-sm:py-3.5">
        <Switch
          id={`${id}-switch`}
          className="mt-0.5"
          checked={on}
          disabled={!view.canEdit || state.kind === "none" || pending}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-explain`}
          onCheckedChange={(checked) => {
            const pick = selected ?? view.boards[0];
            if (!checked) onSet(null);
            else if (pick !== undefined) onSet(pick.id);
          }}
        />
        <div className="min-w-0">
          <label id={`${id}-label`} htmlFor={`${id}-switch`} className={cn("block text-body leading-[22px] font-medium max-sm:text-[15px]", state.kind === "none" ? "text-muted" : "text-text")}>
            {t("boards.promptTickets.label")}
          </label>
          <p id={`${id}-explain`} className="mt-0.5 max-w-[620px] text-[13.5px] leading-normal text-muted max-sm:text-ui">
            {explanation}
          </p>
          {board === undefined || !several ? null : (
            <div className="mt-2.5 flex items-center gap-3 max-sm:mt-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-1.5">
              <span className="text-[13.5px] text-muted max-sm:text-ui">{t("boards.promptTickets.board")}</span>
              {view.canEdit ? (
                <Select value={board.id} disabled={pending || state.kind === "paused"} onValueChange={(value) => { const next = view.boards.find((item) => item.id === value); if (next !== undefined && next.id !== board.id) onSet(next.id); }}>
                  <SelectTrigger aria-label={t("boards.promptTickets.boardAria")} className="w-[240px] bg-surface max-sm:h-11 max-sm:w-full max-sm:text-[15px]">
                    <SelectValue>
                      <span className="flex min-w-0 items-center gap-2">
                        <BoardName board={board} />
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    {view.boards.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        <BoardName board={item} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="flex min-w-0 items-center gap-2 text-ui text-text [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]" data-testid="prompt-tickets-board">
                  <BoardName board={board} />
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2 flex items-start gap-2 text-[13.5px] text-red">
          <TriangleAlertIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75]" />
          {error}
        </p>
      )}
    </div>
  );
};
