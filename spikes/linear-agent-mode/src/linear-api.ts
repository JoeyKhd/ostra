import { AgentActivitySignal, LinearClient, LinearError, LinearErrorType, RatelimitedLinearError } from "@linear/sdk";
import { z } from "zod";
import type { Failure } from "./retry.ts";
import { ActivityId, AppUserId, OrganizationId } from "./ids.ts";
import type { AgentSessionId } from "./ids.ts";

// ostra's narrow view of the Linear API: what agent mode needs and nothing else. The SDK's
// `LinearClient` does the transport. Calls on a hot path use ostra's own documents through
// `client.client.request`, not the SDK's relation getters, which run a query each (integrations-platform.md 6.1).

/** The activity types an agent may publish. `prompt` is the user's, and `stop` is a user signal. */
export type ActivityContent =
  | { readonly type: "thought"; readonly body: string }
  | { readonly type: "action"; readonly action: string; readonly parameter: string; readonly result?: string }
  | { readonly type: "response"; readonly body: string }
  | { readonly type: "error"; readonly body: string }
  | { readonly type: "elicitation"; readonly body: string };

export type ActivityRequest = {
  readonly sessionId: AgentSessionId;
  /** A client-made UUID v4, the same on every retry of one activity, so a retry cannot post it twice. */
  readonly id?: ActivityId;
  readonly content: ActivityContent;
  /** Only `thought` and `action` may be ephemeral: shown until the next activity replaces them. */
  readonly ephemeral?: boolean;
  /** `continue` on a `response` keeps the session active instead of completing the turn. */
  readonly signal?: "continue";
};

export type SessionUpdate = {
  readonly externalUrls?: readonly { readonly label: string; readonly url: string }[];
  readonly summary?: string;
};

export type ViewerInfo = {
  readonly appUserId: AppUserId;
  readonly name: string;
  /** True when the token belongs to an app user: the install was `actor=app`. */
  readonly isApp: boolean;
  readonly organizationId: OrganizationId;
};

export type LinearApi = {
  postActivity: (request: ActivityRequest) => Promise<{ readonly activityId: ActivityId }>;
  updateSession: (sessionId: AgentSessionId, update: SessionUpdate) => Promise<void>;
  viewer: () => Promise<ViewerInfo>;
  /** Linear's own view of a session's status: pending, active, awaitingInput, complete, error, stale or stopping. */
  sessionStatus: (sessionId: AgentSessionId) => Promise<string>;
};

const VIEWER_DOCUMENT = `query OstraViewer { viewer { id name app } organization { id } }`;

const SESSION_STATUS_DOCUMENT = `query OstraSessionStatus($id: String!) { agentSession(id: $id) { id status } }`;

const sessionStatusSchema = z.object({ agentSession: z.object({ id: z.string(), status: z.string() }) });

const viewerDataSchema = z.object({
  viewer: z.object({ id: z.string().min(1), name: z.string(), app: z.boolean() }),
  organization: z.object({ id: z.string().min(1) }),
});

export const createLinearApi = (options: { readonly apiUrl: string; readonly accessToken: string }): LinearApi => {
  const client = new LinearClient({ accessToken: options.accessToken, apiUrl: options.apiUrl });
  return {
    postActivity: async (request) => {
      const payload = await client.createAgentActivity({
        agentSessionId: request.sessionId,
        ...(request.id === undefined ? {} : { id: request.id }),
        content: request.content,
        ...(request.ephemeral === true ? { ephemeral: true } : {}),
        ...(request.signal === "continue" ? { signal: AgentActivitySignal.Continue } : {}),
      });
      const activityId = ActivityId.safeParse(payload.agentActivityId);
      if (!payload.success || !activityId.success) throw new Error("Linear did not accept the activity");
      return { activityId: activityId.data };
    },
    updateSession: async (sessionId, update) => {
      const payload = await client.updateAgentSession(sessionId, {
        ...(update.externalUrls === undefined
          ? {}
          : { externalUrls: update.externalUrls.map(({ label, url }) => ({ label, url })) }),
        ...(update.summary === undefined ? {} : { summary: update.summary }),
      });
      if (!payload.success) throw new Error("Linear did not accept the session update");
    },
    viewer: async () => {
      const data = viewerDataSchema.parse(await client.client.request(VIEWER_DOCUMENT));
      return {
        appUserId: AppUserId.parse(data.viewer.id),
        name: data.viewer.name,
        isApp: data.viewer.app,
        organizationId: OrganizationId.parse(data.organization.id),
      };
    },
    sessionStatus: async (sessionId) =>
      sessionStatusSchema.parse(await client.client.request(SESSION_STATUS_DOCUMENT, { id: sessionId })).agentSession.status,
  };
};

const failureForType = (type: LinearErrorType | undefined, status: number | undefined): Failure["kind"] => {
  switch (type) {
    case undefined:
      return status !== undefined && status < 500 && status !== 429 ? "permanent" : "transient";
    case LinearErrorType.Ratelimited:
      return "rate-limited";
    case LinearErrorType.NetworkError:
    case LinearErrorType.Unknown:
    case LinearErrorType.InternalError:
    case LinearErrorType.LockTimeout:
    case LinearErrorType.Other:
      return "transient";
    case LinearErrorType.FeatureNotAccessible:
    case LinearErrorType.InvalidInput:
    case LinearErrorType.AuthenticationError:
    case LinearErrorType.Forbidden:
    case LinearErrorType.BootstrapError:
    case LinearErrorType.UserError:
    case LinearErrorType.GraphqlError:
    case LinearErrorType.UsageLimitExceeded:
      return "permanent";
    default:
      return type satisfies never;
  }
};

const rawResponseSchema = z.object({ response: z.object({ status: z.number().int() }) });

/** What to do about an error from the SDK: wait and retry, retry soon, or stop trying. */
export const classifyFailure = (error: unknown): Failure => {
  if (error instanceof RatelimitedLinearError) {
    return { kind: "rate-limited", retryAfterMs: error.retryAfter === undefined ? null : error.retryAfter * 1000 };
  }
  if (error instanceof LinearError) {
    return { kind: failureForType(error.type, error.status), retryAfterMs: null };
  }
  // A request made through the SDK's raw client (`client.request`) throws a plain error carrying the HTTP response, not a
  // LinearError. Its status says whether trying again could help.
  const raw = rawResponseSchema.safeParse(error);
  if (raw.success) return { kind: failureForType(undefined, raw.data.response.status), retryAfterMs: null };
  // A dropped connection or a timeout: nothing says the request is wrong.
  return { kind: "transient", retryAfterMs: null };
};
