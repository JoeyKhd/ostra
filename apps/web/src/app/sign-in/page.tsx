import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("signIn.title") };

const SignInPage = async () => {
  const { caller, signedIn } = await getServerApi();
  const state = await caller.setup.state();
  if (state.needsFirstAdmin) redirect("/setup");
  if (signedIn) redirect("/");
  return (
    <AuthCard title={t("signIn.title")} lede={t("signIn.lede")}>
      <SignInForm />
    </AuthCard>
  );
};

export default SignInPage;
