import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import { createPanelStartAppTokens, PANEL_START_APP_PATH, startAppForMember } from "@ostra/domain";
import type { PanelStartAppTokens, StartAppDeps } from "@ostra/domain";

import { bearerToken } from "../gateway/access-token.ts";
import { sendError, sendJson } from "../http.ts";

// "Start the app" on core (milestone 8, F-141, Q300, ADR 0068): `POST /panel/v1/previews/start-app`
// with the panel's token for one member and one task (`start-app-on-core.ts`), and no body. Core
// runs `startApp` with its own dispatch settings (`start.dispatch`: each agent adapter's session
// archive capability, the levels it sends, the personal runners' slots), the ones every other
// dispatch reads, so the app's box restores the agent's session as a reopen's would and a member's
// message there resumes it. The answer is the use case's own, `200` either way; a bad token is
// `401`. Lines carry the task and the member, never the token.

export type StartAppEndpointDeps = {
  readonly start: StartAppDeps;
  /** The secrets key's text, read when first needed: the key the panel signs with. */
  readonly secret: () => Promise<string>;
  readonly logger: Logger;
};

export const handlePanelStartApp = (deps: StartAppEndpointDeps) => {
  const logger = deps.logger.child({ component: "panel-start-app" });
  let tokens: Promise<PanelStartAppTokens> | undefined;
  const tokensOnce = (): Promise<PanelStartAppTokens> => (tokens ??= deps.secret().then(createPanelStartAppTokens));
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== PANEL_START_APP_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      sendError(response, 404, "not-found", "no such route");
      return true;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : (await tokensOnce()).verify(token, deps.start.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a valid panel token is required");
      return true;
    }
    const answer = await startAppForMember(deps.start, claims);
    if (!answer.ok) {
      logger.info("app.start-refused", { taskId: claims.taskId, memberId: claims.memberId, code: answer.error });
    }
    sendJson(response, 200, answer);
    return true;
  };
};
