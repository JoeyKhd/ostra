import { createContext, serveTaskFile } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A file of a task's message, a member's or the ticket's (F-148, ticket 14): always a download, an
// image with its detected type and anything else as bytes, never a page, to a member who can open
// the task. The access check, the blob read and the headers are `serveTaskFile`'s.

export const dynamic = "force-dynamic";

export const GET = async (request: Request, context: { readonly params: Promise<{ readonly "task-id": string; readonly "file-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return serveTaskFile(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), params["task-id"], params["file-id"]);
};
