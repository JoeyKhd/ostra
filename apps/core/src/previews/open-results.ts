import type { Logger } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import { closeRefusedViewsInTx } from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox } from "@ostra/domain";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";

// A box's answer to a view's `preview.open` (ADR 0068's note of 2026-11-21): a refused open
// (`not-a-preview`, `too-many-pages`, ...) closes the view at once, in the transaction that records
// the runner's results, instead of leaving it `opening` for the 2-minute sweep. The view keeps the
// box's reason, and the pane's stream ends with it (`previews.ts`). IDs and reasons are logged.

export type PreviewOpenResultsDeps = {
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
};

/** The gateway's hook for the views: each `preview.open` the runner (or a box's sidecar) refused closes its view. */
export const applyPreviewOpenResultsInTx = async (deps: PreviewOpenResultsDeps, tx: Tx, runner: RunnerRef, results: readonly AckedCommand[]): Promise<void> => {
  const closed = await closeRefusedViewsInTx(deps, tx, runner.organizationId, results);
  for (const view of closed) {
    deps.logger.info("preview.view-refused", { viewId: view.viewId, runnerId: runner.runnerId, refusal: view.refusal });
  }
};
