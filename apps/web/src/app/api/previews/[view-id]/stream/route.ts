import { createContext, servePreviewStream } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A view's frames (milestone 8, F-141, ADR 0068): core's stream for the view, relayed as a streamed
// response. The pane and the viewer page read it with `fetch`'s body reader. A member's session, or
// the viewer page's link token in `x-ostra-preview-link`; the checks and the relay are
// `servePreviewStream`'s, tested in `@ostra/api`.

export const dynamic = "force-dynamic";

export const GET = async (request: Request, context: { readonly params: Promise<{ readonly "view-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return servePreviewStream(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), request, params["view-id"]);
};
