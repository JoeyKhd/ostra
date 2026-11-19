import { createContext, serveAuditExport } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// The audit log as CSV (F-073, ticket 25): the list's query and access check, streamed page by page,
// with the list's filters as query parameters. `serveAuditExport` does both.

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> => {
  const deps = await getApiDeps();
  return serveAuditExport(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), new URL(request.url));
};
