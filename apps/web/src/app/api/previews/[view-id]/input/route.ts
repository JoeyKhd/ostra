import { createContext, servePreviewInput } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A batch of a viewer's input (milestone 8, F-141, F-142, ADR 0068): `{ events }`, relayed to core
// for the view. A watch-only viewer's input stops here, before core and the runner. The checks and
// the relay are `servePreviewInput`'s, tested in `@ostra/api`.

export const dynamic = "force-dynamic";

export const POST = async (request: Request, context: { readonly params: Promise<{ readonly "view-id": string }> }): Promise<Response> => {
  const params = await context.params;
  const deps = await getApiDeps();
  return servePreviewInput(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), request, params["view-id"]);
};
