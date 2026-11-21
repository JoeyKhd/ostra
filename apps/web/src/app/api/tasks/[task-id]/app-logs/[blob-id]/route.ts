import { createContext, serveTaskAppLog } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// An app process's log tail (F-140, milestone 8's ticket 17): the blob as plain text, never as a
// page, to a member who can open the task, for "Show log". The access check and the blob read are
// `serveTaskAppLog`'s.

export const dynamic = "force-dynamic";

export const GET = async (request: Request, context: { readonly params: Promise<{ readonly "task-id": string; readonly "blob-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return serveTaskAppLog(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), params["task-id"], params["blob-id"]);
};
