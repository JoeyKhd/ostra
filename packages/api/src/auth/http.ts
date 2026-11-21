import { foreignOriginRefusal, fromPanelOrigin } from "../services/panel-origin.ts";
import type { ApiDeps } from "../trpc/context.ts";

/**
 * better-auth's routes (`/api/auth/*`, ADR 0003). A request that changes something from any origin
 * but the panel's own is refused before better-auth reads it (ticket 25, ADR 0068 "The panel's own
 * defences"): better-auth checks `Origin` itself on a request with cookies, except under a test
 * runner, and this holds in every environment. A client that isn't a browser names no origin.
 */
export const handleAuthRequest = async (deps: Pick<ApiDeps, "auth" | "settings" | "logger">, request: Request): Promise<Response> => {
  if (!fromPanelOrigin(request, deps.settings.publicUrl)) {
    deps.logger.info("auth.foreign-origin-refused", { method: request.method });
    return foreignOriginRefusal();
  }
  return deps.auth.handler(request);
};
