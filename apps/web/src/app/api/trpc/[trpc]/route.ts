import { appRouter, createContext } from "@ostra/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { getApiDeps } from "@/server/deps";

// tRPC 11 over the fetch adapter: batched queries and mutations, and subscriptions over SSE
// (ADR 0035). The context resolves the better-auth session per request.
const handler = async (req: Request): Promise<Response> => {
  const deps = await getApiDeps();
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: ({ resHeaders }) => createContext(deps, { headers: req.headers, resHeaders }),
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        // IDs and the path only: never the input, which can hold a token.
        deps.logger.error("api.internal_error", { path: path ?? null, name: error.cause?.name ?? error.name });
      }
    },
  });
};

export const dynamic = "force-dynamic";
export { handler as GET, handler as POST };
