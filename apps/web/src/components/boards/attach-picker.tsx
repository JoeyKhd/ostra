"use client";

import { SquareKanbanIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import type { AttachableConnection } from "./board-words";

// The attach picker (boards-mixed.md, F-152/c4): one select of every connection's teams or projects,
// grouped by connection, each group headed by its mark and name. A board already attached to this
// project is faint and unpickable; a pending or failed connection's head says so, with the line that
// says where to finish it. Typing filters across every group (Radix's typeahead), and a disabled
// item is skipped.

const groupWord = (connection: Pick<AttachableConnection, "kind">): string => t(connection.kind === "jira" ? "boards.attach.projects" : "boards.attach.teams");

/** A connection's head in the picker: its mark, name, and the word for what it lists (or its state). */
export const ConnectionHead = ({ connection }: { readonly connection: AttachableConnection }) => (
  <SelectLabel className="flex h-[26px] items-center gap-2 px-2 pt-0">
    <TrackerMark kind={connection.kind} size={trackerMarkAt.attachGroup.size} label={false} />
    <span className="min-w-0 truncate text-xs font-medium text-faint">{connection.name}</span>
    <span className={cn("ml-auto font-mono text-[11.5px] font-normal", connection.state === "active" ? "text-faint" : "text-muted")}>
      {connection.state === "active" ? groupWord(connection) : t(connection.state === "pending" ? "boards.attach.pendingState" : "boards.attach.failedState")}
    </span>
  </SelectLabel>
);

/** Every connection's boards, grouped, as the attach picker and Create a project both list them. */
export const BoardGroups = ({ connections }: { readonly connections: readonly AttachableConnection[] }) => (
  <>
    {connections.map((connection) => (
      <SelectGroup key={connection.id}>
        <ConnectionHead connection={connection} />
        {connection.state === "active" ? null : (
          <SelectItem value={`${connection.id}:${connection.state}`} disabled className="h-[26px] text-[13px] text-faint">
            {t(connection.state === "pending" ? "boards.attach.pending" : "boards.attach.failed")}
          </SelectItem>
        )}
        {connection.items.map((board) => (
          <SelectItem
            key={`${connection.id}:${board.externalId}`}
            value={`${connection.id}:${board.externalId}`}
            disabled={board.attachedHere}
            className={cn(board.attachedHere && "text-faint")}
          >
            <SquareKanbanIcon aria-hidden />
            <span className="truncate">{board.name}</span>
            <span className="font-mono text-sm text-muted">· {board.key}</span>
            {board.attachedHere ? (
              <span className="ml-auto text-sm text-faint">{t("boards.attach.attached")}</span>
            ) : board.alsoOn[0] === undefined ? null : (
              <span className="ml-auto truncate text-sm text-faint">{t("boards.attached.alsoOn", { name: board.alsoOn[0].name })}</span>
            )}
          </SelectItem>
        ))}
      </SelectGroup>
    ))}
  </>
);

/** The board a picked value names: `<connectionId>:<externalId>`, and only when it can be attached. */
const pickedBoard = (connections: readonly AttachableConnection[], value: string): { readonly connectionId: string; readonly externalId: string; readonly name: string; readonly key: string; readonly kind: AttachableConnection["kind"] } | undefined => {
  for (const connection of connections) {
    for (const board of connection.items) {
      if (`${connection.id}:${board.externalId}` === value && !board.attachedHere) {
        return { connectionId: connection.id, externalId: board.externalId, name: board.name, key: board.key, kind: connection.kind };
      }
    }
  }
  return undefined;
};

export type AttachPickerProps = {
  readonly connections: readonly AttachableConnection[] | undefined;
  readonly onAttach: (connectionId: string, externalId: string) => void;
  readonly pending: boolean;
  readonly error: string | null;
};

/** The Attach line: one select of every connection's boards, then Attach. */
export const AttachPicker = ({ connections, onAttach, pending, error }: AttachPickerProps) => {
  const [picked, setPicked] = useState("");
  const listed = connections ?? [];
  const free = listed.flatMap((connection) => connection.items.filter((board) => !board.attachedHere));
  const chosen = pickedBoard(listed, picked);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ui text-muted">{t("boards.attach.label")}</span>
        <Select value={chosen === undefined ? "" : picked} onValueChange={setPicked} disabled={connections === undefined || free.length === 0 || pending}>
          <SelectTrigger aria-label={t("boards.attach.label")} className="h-[30px] w-[300px]">
            <SelectValue placeholder={connections !== undefined && free.length === 0 ? t("boards.attach.none") : t("boards.attach.pick")}>
              {chosen === undefined ? undefined : (
                <>
                  <TrackerMark kind={chosen.kind} size={trackerMarkAt.boardSelect.size} label={false} />
                  <span className="truncate">{chosen.name}</span>
                  <span className="font-mono text-sm text-muted">· {chosen.key}</span>
                </>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start" className="w-[330px]">
            <BoardGroups connections={listed} />
          </SelectContent>
        </Select>
        <Button disabled={chosen === undefined || pending} onClick={() => { if (chosen !== undefined) onAttach(chosen.connectionId, chosen.externalId); }}>
          {pending ? t("boards.attach.attaching") : t("boards.attach.action")}
        </Button>
      </div>
      {error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{error}</p>}
    </div>
  );
};
