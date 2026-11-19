import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { fetchTaskRepoDiff } from "@ostra/domain";
import type { ChangeNotices, Clock, DiffLimits, ServerAdapters } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// `diff.fetch` (F-027, ticket 22): one compare of a task repo's base and pushed head through the
// App, stored in `DiffCache` by repo and head, so every viewer of the Changes tab reads the row and
// a head that hasn't changed is never fetched again. Then the comments written on older heads are
// checked against it and marked outdated where their line changed. Logs carry IDs and outcomes,
// never the diff's code or a comment's text.

export type DiffFetchDeps = {
  readonly db: Db;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: ServerAdapters;
  readonly limits: DiffLimits;
  readonly logger: Logger;
};

export const diffFetchHandler =
  (deps: DiffFetchDeps): JobHandler<"diff.fetch"> =>
  async (context) => {
    const { organizationId, taskId, repoId, baseSha, headSha } = context.payload;
    const result = await fetchTaskRepoDiff(
      { db: deps.db, notices: deps.notices, clock: deps.clock, adapters: deps.adapters, limits: deps.limits },
      { organizationId, taskId, repoId, baseSha, headSha },
    );
    if (result.ok) {
      context.logger.info("diff.fetched", { taskId, repoId, outcome: result.outcome, outdated: result.outdated });
      return;
    }
    context.logger.warn("diff.fetch-failed", { taskId, repoId, error: result.error, retry: result.retry });
    if (result.retry) {
      // The queue retries with backoff: the host was down or rate limited.
      throw new Error(`diff.fetch: ${result.error}`);
    }
  };
