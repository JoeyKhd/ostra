import { getApiDeps } from "@/server/deps";

// better-auth, mounted at /api/auth/* (ADR 0003, ticket 30). Its configuration lives in
// packages/api, so core checks a device session with the same code.
const handler = async (req: Request): Promise<Response> => {
  const deps = await getApiDeps();
  return deps.auth.handler(req);
};

export const dynamic = "force-dynamic";
export { handler as GET, handler as POST };
