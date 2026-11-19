import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The boards page's pure parts (project-boards.md, F-007, F-031): the team's statuses grouped the
// way Linear orders them, the mapping's problems, and what the next task will do on the ticket.

export type BoardsData = RouterOutputs["boards"]["get"];
export type BoardView = BoardsData["boards"][number];
export type BoardStatus = NonNullable<BoardView["statusGroups"]>[number]["statuses"][number];
export type Mapping = NonNullable<BoardView["mapping"]>;

/** Linear's status types, in Linear's order; the pickers group by them. */
export const statusTypes = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type StatusType = (typeof statusTypes)[number] | "other";

/** Linear's type for a status; its `duplicate` type sits with the canceled ones. */
export const statusTypeOf = (status: BoardStatus): StatusType =>
  status.vendorType === "duplicate" ? "canceled" : (statusTypes.find((type) => type === status.vendorType) ?? "other");

const typeLabel: Readonly<Record<StatusType, MessageKey>> = {
  triage: "boards.type.triage",
  backlog: "boards.type.backlog",
  unstarted: "boards.type.unstarted",
  started: "boards.type.started",
  completed: "boards.type.completed",
  canceled: "boards.type.canceled",
  other: "boards.type.other",
};

export const statusTypeLabel = (type: StatusType): string => t(typeLabel[type]);

export type StatusGroup = { readonly type: StatusType; readonly statuses: readonly BoardStatus[] };

/** Every status of the team, grouped by its type in Linear's order, each group by position. */
export const groupStatuses = (board: BoardView): readonly StatusGroup[] => {
  const all = (board.statusGroups ?? []).flatMap((group) => group.statuses);
  const order: readonly StatusType[] = [...statusTypes, "other"];
  return order
    .map((type) => ({ type, statuses: all.filter((status) => statusTypeOf(status) === type).sort((a, b) => a.position - b.position) }))
    .filter((group) => group.statuses.length > 0);
};

/** A status's name, or its ID when the team no longer has it. */
export const statusName = (board: BoardView, id: string): string =>
  (board.statusGroups ?? []).flatMap((group) => group.statuses).find((status) => status.id === id)?.name ?? id;

/** Whether the team still has a status (a gone one is shown struck through, in red). */
export const statusExists = (board: BoardView, id: string): boolean =>
  board.statusGroups === null || board.statusGroups.some((group) => group.statuses.some((status) => status.id === id));

/** The step a status is mapped to, for the panel's list. */
export const mappedStep = (mapping: Mapping | null, id: string): string => {
  if (mapping === null) return "–";
  if (mapping.done === id) return t("boards.mapping.done");
  if (mapping.inReview === id) return t("boards.mapping.inReview");
  if (mapping.started === id) return t("boards.mapping.started");
  if (mapping.open.includes(id)) return t("boards.mapping.open");
  return "–";
};

/** What stops a mapping from being saved: an empty Open, or a status the team no longer has. */
export const mappingProblems = (board: BoardView, mapping: Mapping): { readonly openEmpty: boolean; readonly gone: ReadonlySet<string> } => {
  const ids = [...mapping.open, mapping.started, mapping.inReview, mapping.done];
  return { openEmpty: mapping.open.length === 0, gone: new Set(ids.filter((id) => !statusExists(board, id))) };
};

export const mappingSavable = (board: BoardView, mapping: Mapping): boolean => {
  const problems = mappingProblems(board, mapping);
  return !problems.openEmpty && problems.gone.size === 0;
};

export const sameMapping = (a: Mapping | null, b: Mapping | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One sentence per step: what the next task does on the ticket, from the (unsaved) mapping. */
export const nextTaskLines = (board: BoardView, mapping: Mapping): readonly { readonly text: string; readonly status: string }[] => {
  const name = (id: string) => statusName(board, id);
  return [
    { text: t("boards.next.started"), status: name(mapping.started) },
    { text: mapping.inReview === mapping.started ? t("boards.next.inReviewSame") : t("boards.next.inReview"), status: name(mapping.inReview) },
    { text: mapping.doneBy === "integration" ? t("boards.next.doneIntegration") : t("boards.next.doneOstra"), status: name(mapping.done) },
  ];
};

/** `2m`, `40s`, `3h`: the short ages the board rows show. */
export const shortAge = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
};

/** A magic line's sample: `Closes CALC-142`. */
export const magicSample = (mapping: Mapping, key: string | null): string => `${mapping.magicWord} ${key ?? "KEY"}-142`;
