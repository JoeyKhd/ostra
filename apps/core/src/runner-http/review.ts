import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { submitReview } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue } from "@ostra/domain";
import { RUNNER_PATH_PREFIX, reviewRequestSchema, taskIdSchema } from "@ostra/protocol";
import type { ReviewResponse } from "@ostra/protocol";

import type { AccessTokens } from "../gateway/access-token.ts";
import type { TaskTokens } from "../gateway/task-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { authorizeTaskCall } from "../memory/endpoints.ts";

// `POST /runner/v1/tasks/:taskId/review` (F-100, ADR 0058; milestone 6's ticket 17): the sidecar's
// `submit_review`, on behalf of one task, with its task token (a `host` lease's runner calls with
// its own access token), checked as the memory tools' calls are. A review task only, whose run is
// running while its code task waits for it; the findings checked by the protocol's schema and
// capped. A refusal is a `200` with its code, which the tool's words turn into the agent's reply.
// The summary and the findings' text never reach a log line: the lines name the task and count.

const reviewPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/review$`);

/** The most a review's body may weigh: 30 findings of 4 KiB and their fields, with room. */
const REVIEW_BODY_MAX_BYTES = 256 * 1024;

export type ReviewEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `OSTRA_REVIEW_FINDINGS_MAX`. */
  readonly findingsMax?: number;
};

export const handleReviewEndpoint =
  (deps: ReviewEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = reviewPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    if (request.method !== "POST") {
      sendError(response, 404, "not-found", "no such route");
      return true;
    }
    const taskId = taskIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
    if (!taskId.success) {
      sendError(response, 404, "not-found", "no such task");
      return true;
    }
    const context = await authorizeTaskCall(deps, request, response, taskId.data);
    if (context === null) {
      return true;
    }
    const logger = deps.logger.child({ component: "review-endpoint", taskId: context.taskId });
    const body = await readJsonBody(request, REVIEW_BODY_MAX_BYTES);
    const parsed = body.ok ? reviewRequestSchema.safeParse(body.value) : undefined;
    if (parsed?.success !== true) {
      logger.info("review.refused", { code: "invalid" });
      const refusal: ReviewResponse = { code: "invalid" };
      sendJson(response, 200, refusal);
      return true;
    }
    const result = await deps.db.$transaction(
      (tx) =>
        submitReview(
          { tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, logger, ...(deps.findingsMax === undefined ? {} : { findingsMax: deps.findingsMax }) },
          { organizationId: context.organizationId, reviewTaskId: context.taskId, review: parsed.data },
        ),
      { timeout: 20_000 },
    );
    if (!result.ok) {
      logger.info("review.refused", { code: result.error });
      const refusal: ReviewResponse = { code: result.error };
      sendJson(response, 200, refusal);
      return true;
    }
    const answer: ReviewResponse = { reviewRunId: result.reviewRunId };
    sendJson(response, 200, answer);
    return true;
  };
