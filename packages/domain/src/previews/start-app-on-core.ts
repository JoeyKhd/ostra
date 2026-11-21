import { createHmac, timingSafeEqual } from "node:crypto";

import { memberIdSchema, organizationIdSchema, parseJson, taskIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { loadMemberScopeInTx } from "../starts/bulk.ts";
import { startApp } from "./start-app.ts";
import type { StartAppDeps } from "./start-app.ts";

// "Start the app" runs on core (milestone 8, F-141, Q300, ADR 0068). Core holds the agent adapters
// and dispatches every task, so it holds what the dispatch reads beyond the rows: whether the
// task's agent imports a session archive, the levels it sends, the personal runners' slots. The box
// the app starts in then restores the agent's session as a reopen's would, and a member's message
// there resumes it instead of the rebuild template. The panel (the pane's button, the CLI's start
// route) checks the member can open the task, then asks core with a token: an HMAC under the
// secrets key over the organization, the member and the task, a minute long (modelled on
// `panel-blob-token.ts`). Core reads the member's scope again and runs `startApp`; its answer is the
// use case's own. Never logged: the token, whose prefix the logger redacts (`ostra-panel-`).

/** Where core takes the panel's "Start the app": `POST`, the token in `Authorization`, no body. */
export const PANEL_START_APP_PATH = "/panel/v1/previews/start-app";

/** The token's prefix. */
export const PANEL_START_APP_TOKEN_PREFIX = "ostra-panel-app-";

/** How long a token lives: the panel asks core the moment it has made one. */
export const PANEL_START_APP_TOKEN_TTL_MS = 60_000;

const claimsSchema = z.strictObject({
  v: z.literal(1),
  o: organizationIdSchema,
  m: memberIdSchema,
  t: taskIdSchema,
  x: z.number().int(),
});

/** What the panel asks core for: one member starting one task's app, within a minute. */
export type PanelStartAppClaims = {
  readonly organizationId: OrganizationId;
  readonly memberId: MemberId;
  readonly taskId: TaskId;
  /** Epoch ms: no good from then on. */
  readonly expiresAt: number;
};

export type PanelStartAppTokens = {
  readonly issue: (claims: PanelStartAppClaims) => string;
  /** The token's claims, or `null` when it's forged, malformed, past its deadline or longer-lived than the panel makes one. */
  readonly verify: (token: string, now: number) => PanelStartAppClaims | null;
};

export const createPanelStartAppTokens = (secret: string): PanelStartAppTokens => {
  // Its own context in the MAC, so another panel token under the same key can't pass for one.
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(`panel-start-app\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(JSON.stringify({ v: 1, o: claims.organizationId, m: claims.memberId, t: claims.taskId, x: claims.expiresAt })).toString("base64url");
      return `${PANEL_START_APP_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (token, now) => {
      if (!token.startsWith(PANEL_START_APP_TOKEN_PREFIX) || token.length > 2048) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(PANEL_START_APP_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0) {
        return null;
      }
      const given = Buffer.from(mac, "base64url");
      const wanted = sign(body);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? claimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true || claims.data.x <= now || claims.data.x - now > PANEL_START_APP_TOKEN_TTL_MS) {
        return null;
      }
      const { o, m, t, x } = claims.data;
      return { organizationId: o, memberId: m, taskId: t, expiresAt: x };
    },
  };
};

/** Why the app didn't start: `startApp`'s refusals, `no-runner` and `runner-needs-upgrade` meaning nothing was written. */
export const startAppRefusalSchema = z.enum(["forbidden", "not-found", "no-app-processes", "no-runner", "runner-needs-upgrade", "runner-cannot-preview"]);

/** Core's answer to the panel: `startApp`'s own result. A format ostra owns, so it's strict. */
export const startAppAnswerSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), state: z.enum(["starting", "running"]) }),
  z.strictObject({ ok: z.literal(false), error: startAppRefusalSchema, message: z.string() }),
]);
export type StartAppAnswer = z.infer<typeof startAppAnswerSchema>;

/**
 * Core's side of the panel's request: the member as they are now (one removed since gets no start),
 * then `startApp` with core's own dispatch settings in `deps`.
 */
export const startAppForMember = async (deps: StartAppDeps, request: Omit<PanelStartAppClaims, "expiresAt">): Promise<StartAppAnswer> => {
  const scope = await loadMemberScopeInTx(deps.db, request.organizationId, request.memberId);
  if (scope === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  return startApp(deps, scope, { taskId: request.taskId });
};
