import { createContext, serveTaskAttachment } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A task's screenshot or recording (F-121, milestone 8's ticket 16): the blob as a file of its kind's
// fixed type, never as a page, to a member who can open the task. The access check and the blob read
// are `serveTaskAttachment`'s.

export const dynamic = "force-dynamic";

export const GET = async (request: Request, context: { readonly params: Promise<{ readonly "task-id": string; readonly "attachment-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return serveTaskAttachment(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), params["task-id"], params["attachment-id"]);
};
