import { getServerApi } from "./api";

/** Whether the signed-in member is an admin of their organization. */
export const isAdmin = async (): Promise<boolean> => {
  const { caller, signedIn } = await getServerApi();
  if (!signedIn) return false;
  const me = await caller.me.get();
  return me.organization?.role === "admin";
};
