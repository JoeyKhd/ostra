import { handleAuthRequest } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// better-auth, mounted at /api/auth/* (ADR 0003, ticket 30). Its configuration lives in
// packages/api, so core checks a device session with the same code. A change from any origin but
// the panel's own is refused first (`handleAuthRequest`, ticket 25).
const handler = async (req: Request): Promise<Response> => handleAuthRequest(await getApiDeps(), req);

export const dynamic = "force-dynamic";
export { handler as GET, handler as POST };
