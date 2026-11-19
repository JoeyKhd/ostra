import { handleCliRequest } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// The `ostra` CLI's HTTP (F-103, ADR 0051, ticket 39): `ostra login`'s device-code grant, `ostra
// checkout`'s branches and `ostra logout`. One handler in `@ostra/api` answers every path under
// `/api/cli/v1/`, so the routes are tested without this server. The CLI's session is its own
// credential (a bearer token), not a login cookie, and no tRPC procedure accepts it.

export const dynamic = "force-dynamic";

const handler = async (request: Request): Promise<Response> => handleCliRequest(await getApiDeps(), request);

export { handler as GET, handler as POST, handler as DELETE };
