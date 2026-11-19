import { createContext, serveSkillFileUpload } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// A skill's file, from the profile editor (F-021, ticket 42): the bytes of one file, to an
// organization admin. The size, the access check and the hand-over to core's blob service are
// `serveSkillFileUpload`'s.

export const dynamic = "force-dynamic";

export const POST = async (request: Request): Promise<Response> => {
  const deps = await getApiDeps();
  return serveSkillFileUpload(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), request);
};
