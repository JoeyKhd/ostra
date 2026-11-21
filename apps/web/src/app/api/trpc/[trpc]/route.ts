import { handleTrpcRequest } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// tRPC 11 over the fetch adapter: batched queries and mutations, and subscriptions over SSE
// (ADR 0035). The context resolves the better-auth session per request, and a mutation from any
// origin but the panel's own is refused first (`handleTrpcRequest`, ticket 25).
const handler = async (req: Request): Promise<Response> => handleTrpcRequest(await getApiDeps(), req);

export const dynamic = "force-dynamic";
export { handler as GET, handler as POST };
