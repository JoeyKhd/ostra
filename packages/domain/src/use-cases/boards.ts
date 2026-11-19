import type { Tx } from "@ostra/db";
import { boardIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { boardMappingSchema } from "../tickets/board-mapping.ts";
import type { BoardMapping } from "../tickets/board-mapping.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";
import type { ConnectionTracker } from "./linear-connection.ts";

// F-007, F-031: a project admin attaches a tracker's team to the project as a board, and edits its
// status mapping (spec section 3, step 2). Attaching reads the team's statuses and the GitHub
// integration check through the tracker adapter, drafts the mapping (`draftBoardMapping`) and
// saves the board; the admin can change any of the four targets, `doneBy` and the magic word.
// Bodies: ticket 28. The tracker calls happen before the transaction; the board is written in it.

export const attachBoardInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The tracker's ID of the team (`listBoards`). */
  teamExternalId: z.string().min(1).max(256),
});
export type AttachBoardInput = z.infer<typeof attachBoardInputSchema>;

export type AttachBoardResult = UseCaseResult<
  { readonly boardId: BoardId; readonly mapping: BoardMapping; readonly integrationInstalled: boolean },
  | "not-found"
  | "forbidden"
  | "no-connection"
  | "already-attached"
  | "no-started-status"
  | "no-done-status"
  /** The tracker didn't answer, or refused: words, never its body. */
  | "tracker-failed"
>;

export type AttachBoardDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  readonly tracker: ConnectionTracker;
};

export type AttachBoard = (deps: AttachBoardDeps, input: AttachBoardInput) => Promise<AttachBoardResult>;

export const attachBoard: AttachBoard = () => notYet("28");

export const saveBoardMappingInputSchema = z.strictObject({
  boardId: boardIdSchema,
  mapping: boardMappingSchema,
});
export type SaveBoardMappingInput = z.infer<typeof saveBoardMappingInputSchema>;

export type SaveBoardMappingResult = UseCaseResult<
  { readonly mapping: BoardMapping },
  "not-found" | "forbidden" | "unknown-status" | "tracker-failed"
>;

export type SaveBoardMapping = (deps: AttachBoardDeps, input: SaveBoardMappingInput) => Promise<SaveBoardMappingResult>;

export const saveBoardMapping: SaveBoardMapping = () => notYet("28");
