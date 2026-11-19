import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthFrame } from "@/components/auth/auth-frame";
import { SignInForm } from "@/components/auth/sign-in-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("signIn.title") };

const SignInPage = async () => {
  const { signedIn } = await getServerApi();
  if (signedIn) redirect("/");
  return (
    <AuthFrame>
      <h1 className="page-title text-text">{t("signIn.title")}</h1>
      <p className="mt-[3px] text-lede text-muted">{t("signIn.lede")}</p>
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthFrame>
  );
};

export default SignInPage;
