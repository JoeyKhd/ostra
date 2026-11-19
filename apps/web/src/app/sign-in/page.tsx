import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("signIn.title") };

const SignInPage = async () => {
  const { signedIn } = await getServerApi();
  if (signedIn) redirect("/");
  return (
    <AuthCard title={t("signIn.title")} lede={t("signIn.lede")}>
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthCard>
  );
};

export default SignInPage;
