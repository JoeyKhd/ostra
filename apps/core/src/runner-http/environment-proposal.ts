import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { proposeEnvironment } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue } from "@ostra/domain";
import { environmentProposalRequestSchema, RUNNER_PATH_PREFIX, runnerLimits, taskIdSchema } from "@ostra/protocol";
import type { EnvironmentProposalResponse } from "@ostra/protocol";

import type { AccessTokens } from "../gateway/access-token.ts";
import type { TaskTokens } from "../gateway/task-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { authorizeTaskCall } from "../memory/endpoints.ts";

// `POST /runner/v1/tasks/:taskId/environment-proposal` (F-113, ADR 0038 amended; milestone 6's
// ticket 21): the sidecar's `propose_environment`, on behalf of one task, with its task token (a
// `host` lease's runner calls with its own access token), checked as the memory tools' calls are.
// An onboarding task only (else `wrong-kind`); the body checked by the protocol's schema; milestone
// 4's secret scan over the scripts and notes and the organization's secret values (a hit refuses
// with `secret-found`, naming the kind). A refusal is a `200` with its code, which the tool's words
// turn into the agent's reply. The proposal's text never reaches a log line.

const proposalPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/environment-proposal$`);

/** The most a proposal's request may weigh: the proposal's own cap, with room for its JSON. */
const PROPOSAL_BODY_MAX_BYTES = runnerLimits.environmentProposalMaxBytes + 16 * 1024;

export type EnvironmentProposalEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly secretStore: SecretStoreAdapter;
  readonly logger: Logger;
};

export const handleEnvironmentProposalEndpoint =
  (deps: EnvironmentProposalEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = proposalPath.exec(url.pathname);
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
    const logger = deps.logger.child({ component: "environment-proposal-endpoint", taskId: context.taskId });
    const body = await readJsonBody(request, PROPOSAL_BODY_MAX_BYTES);
    const parsed = body.ok ? environmentProposalRequestSchema.safeParse(body.value) : undefined;
    if (parsed?.success !== true) {
      logger.info("environment.proposal-refused", { code: "invalid" });
      const refusal: EnvironmentProposalResponse = { code: "invalid" };
      sendJson(response, 200, refusal);
      return true;
    }
    const result = await proposeEnvironment(
      { db: deps.db, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, adapters: { secretStore: deps.secretStore }, logger },
      { organizationId: context.organizationId, taskId: context.taskId, proposal: parsed.data },
    );
    if (!result.ok) {
      logger.info("environment.proposal-refused", { code: result.error });
      const refusal: EnvironmentProposalResponse = result.error === "secret-found" ? { code: "secret-found", found: result.found.slice(0, 20) } : { code: result.error };
      sendJson(response, 200, refusal);
      return true;
    }
    const answer: EnvironmentProposalResponse = { proposalId: result.proposalId };
    sendJson(response, 200, answer);
    return true;
  };
