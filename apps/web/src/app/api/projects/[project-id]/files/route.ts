import { createContext, serveMessageFileUpload } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A member's file from the message box (F-148, ticket 14): one file a request, as `FormData` (`file`,
// and `taskId` on a task's page). Who may send it, its size against the limit, the member's unsent
// count, and the hand-over to core (which stores it and reads a document's text) are
// `serveMessageFileUpload`'s. The answer is core's view of the file, or a refusal's code and words
// (`@ostra/domain/file-uploads`).

export const dynamic = "force-dynamic";

export const POST = async (request: Request, context: { readonly params: Promise<{ readonly "project-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return serveMessageFileUpload(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), request, params["project-id"]);
};
