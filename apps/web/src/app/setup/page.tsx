import { redirect } from "next/navigation";

import { getServerApi } from "@/server/api";

/**
 * The old first-run page. The server seeds the first admin at start now (F-001, which supersedes
 * Q117's setup token), so nobody creates one here: signed in, the first-run checklist is on Home;
 * signed out, sign in (demo@demo.com / demo on a fresh install).
 */
const SetupPage = async () => {
  const { signedIn } = await getServerApi();
  redirect(signedIn ? "/" : "/sign-in");
};

export default SetupPage;
