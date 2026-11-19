import type { Db } from "@ostra/db";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { releaseBox } from "../use-cases/cleanup.ts";
import { loadProviderList } from "./provider-lists.ts";

// `providers.release-boxes` (F-135, ADR 0065, ticket 48): after a list change, a project's boxes
// that hold a key it no longer allows are released, so no later turn can use that key. An idle box
// goes at once; a box whose turn is running is left until the turn ends, and the job runs again
// for it. A queued task whose first session recorded a provider the list dropped records nothing
// again, so its dispatch resolves through the list as it is now.

export type ReleaseProviderBoxesDeps = Pick<Ports, "outbox" | "jobs" | "notices" | "clock"> & { readonly db: Db };

export type ReleaseProviderBoxesResult = {
  /** Boxes released now. */
  readonly released: number;
  /** Boxes still running a turn on a removed key: released once the turn ends. */
  readonly waiting: number;
  /** Queued sessions that will resolve their provider again. */
  readonly reset: number;
};

/** The box states that hold a key: it has fetched, or may fetch, the session's credentials. */
const HOLDING_STATES = ["ready", "idle", "stopped"] as const;

export const releaseProviderBoxes = async (
  deps: ReleaseProviderBoxesDeps,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
): Promise<ReleaseProviderBoxesResult> => {
  const { db } = deps;
  const state = await loadProviderList(db, input.organizationId, input.projectId);
  if (state === null) {
    return { released: 0, waiting: 0, reset: 0 };
  }
  const allowed = new Set<string>(state.list);
  const boxes = await db.box.findMany({
    where: { organizationId: input.organizationId, projectId: input.projectId, state: { in: [...HOLDING_STATES] } },
    select: { id: true, taskId: true },
    orderBy: { id: "asc" },
  });
  let released = 0;
  let waiting = 0;
  for (const box of boxes) {
    const session = await db.session.findFirst({
      where: { boxId: box.id, organizationId: input.organizationId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { providerId: true, state: true },
    });
    const providerId = session?.providerId ?? null;
    if (session === null || providerId === null || allowed.has(providerId)) {
      continue;
    }
    if (session.state === "running") {
      // A running turn finishes on the key it started with (ADR 0065); its box goes after it.
      waiting += 1;
      continue;
    }
    const result = await db.$transaction((tx) =>
      releaseBox(
        { tx, outbox: deps.outbox, jobs: deps.jobs, notices: deps.notices, clock: deps.clock },
        { organizationId: input.organizationId, taskId: taskIdSchema.parse(box.taskId), boxId: boxIdSchema.parse(box.id), reason: "requested" },
      ),
    );
    if (result.ok && result.outcome !== "already") {
      released += 1;
    }
  }
  const stale = await db.session.updateMany({
    where: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      state: "starting",
      boxId: null,
      providerId: { not: null, notIn: [...allowed] },
    },
    data: { providerId: null, modelId: null },
  });
  return { released, waiting, reset: stale.count };
};
