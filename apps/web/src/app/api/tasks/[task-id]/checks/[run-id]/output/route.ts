import { createContext, serveCheckOutput } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A check's full output (F-054, ticket 39): plain text, as an attachment, to a member who can open
// the task's project. The access check and the blob read are `serveCheckOutput`'s.

export const dynamic = "force-dynamic";

export const GET = async (request: Request, context: { readonly params: Promise<{ readonly "task-id": string; readonly "run-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return serveCheckOutput(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), params["task-id"], params["run-id"]);
};
