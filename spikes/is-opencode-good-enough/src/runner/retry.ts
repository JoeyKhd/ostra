// Which recorded runs are infrastructure failures rather than results: a run
// that ended `error` or `agent-crashed`, or one that was cut short while the
// model endpoint was answering 429, 5xx or 4xx. The scorer counts every run in
// the denominator, so one of these kept in a set reads as an unmergeable pull
// request when it is really a rate limit or a bad key. `--retry-failed` deletes
// them so the next resume runs them again.

import type { RunRecord } from "./schemas.ts";

export const hadModelErrors = (record: RunRecord): boolean => record.modelErrors.rateLimited + record.modelErrors.serverErrors + record.modelErrors.clientErrors > 0;

export const needsRetry = (record: RunRecord): boolean => record.outcome === "error" || record.outcome === "agent-crashed" || (record.outcome !== "completed" && hadModelErrors(record));
