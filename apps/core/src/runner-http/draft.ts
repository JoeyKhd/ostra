import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { saveDraft } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, AuditLog } from "@ostra/domain";
import { draftRequestSchema, RUNNER_PATH_PREFIX, taskIdSchema } from "@ostra/protocol";
import type { DraftResponse } from "@ostra/protocol";

import type { AccessTokens } from "../gateway/access-token.ts";
import type { TaskTokens } from "../gateway/task-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { authorizeTaskCall } from "../memory/endpoints.ts";

// `POST /runner/v1/tasks/:taskId/draft` (F-099, ADR 0028; milestone 6's ticket 15): what the
// sidecar's `submit_draft` calls, on behalf of one task, with its task token (a `host` lease's runner
// with its own access token), checked as the memory endpoints check it. Only a refine task takes a
// draft (`wrong-kind` for any other); the body is the protocol's draft schema (`invalid` when it
// doesn't fit); each call is a new version (`limit-reached` past the cap). A refusal's code is what
// the tool tells the agent. The draft's text never reaches a log line: the task and the version do.

const draftPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/draft$`);

/** The largest draft body read: the schema's own caps sum to less. */
const DRAFT_BODY_MAX_BYTES = 1024 * 1024;

export type DraftEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
};

const refuse = (
  response: ServerResponse,
  code: Extract<DraftResponse, { readonly code: string }>["code"],
): void => {
  sendJson(response, code === "invalid" ? 400 : 409, { code } satisfies DraftResponse);
};

export const handleDraftEndpoint =
  (deps: DraftEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = draftPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method-not-allowed" }, { allow: "POST" });
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
    const body = await readJsonBody(request, DRAFT_BODY_MAX_BYTES);
    const draft = body.ok ? draftRequestSchema.safeParse(body.value) : null;
    const logger = deps.logger.child({
      organizationId: context.organizationId,
      taskId: context.taskId,
    });
    const saved = await deps.db.$transaction(async (tx) => {
      const kind = await tx.task.findFirst({
        where: { id: context.taskId, organizationId: context.organizationId },
        select: { kind: true },
      });
      // The kind first: a code task's token gets `wrong-kind` whatever it sends.
      if (kind?.kind !== "refine") {
        return { ok: false, error: "wrong-kind", message: "not a refine task" } as const;
      }
      if (draft?.success !== true) {
        return { ok: false, error: "invalid", message: "the draft doesn't parse" } as const;
      }
      return saveDraft(
        { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock },
        { organizationId: context.organizationId, taskId: context.taskId, draft: draft.data },
      );
    });
    if (!saved.ok) {
      logger.info("draft.refused", { code: saved.error });
      refuse(response, saved.error);
      return true;
    }
    logger.info("draft.saved", { draftId: saved.draftId, version: saved.version });
    sendJson(response, 200, {
      draftId: saved.draftId,
      version: saved.version,
    } satisfies DraftResponse);
    return true;
  };
