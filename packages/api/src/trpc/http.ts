import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "../routers/app-router.ts";
import { foreignOriginRefusal, fromPanelOrigin } from "../services/panel-origin.ts";
import { createContext } from "./context.ts";
import type { ApiDeps } from "./context.ts";

/**
 * The panel's tRPC endpoint (`/api/trpc`), over the fetch adapter: batched queries and mutations,
 * and subscriptions over SSE (ADR 0035). A mutation from any origin but the panel's own is refused
 * before a session is read (ticket 25, ADR 0068 "The panel's own defences"), so a page on a preview
 * host, even one on the panel's site, changes nothing with the member's cookie.
 */
export const handleTrpcRequest = async (deps: ApiDeps, request: Request): Promise<Response> => {
  if (!fromPanelOrigin(request, deps.settings.publicUrl)) {
    deps.logger.info("api.foreign-origin-refused", { method: request.method });
    return foreignOriginRefusal();
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: ({ resHeaders }) => createContext(deps, { headers: request.headers, resHeaders }),
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        // IDs and the path only: never the input, which can hold a token.
        deps.logger.error("api.internal_error", { path: path ?? null, name: error.cause?.name ?? error.name });
      }
    },
  });
};
