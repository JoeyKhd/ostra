import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthFrame } from "@/components/auth/auth-frame";
import { SignInForm } from "@/components/auth/sign-in-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("signIn.title") };

const SignInPage = async () => {
  const { caller, signedIn } = await getServerApi();
  if (signedIn) redirect("/");
  const email = await caller.email.on();
  return (
    <AuthFrame>
      <h1 className="page-title text-text">{t("signIn.title")}</h1>
      <p className="mt-[3px] text-lede text-muted">{t("signIn.lede")}</p>
      <Suspense>
        <SignInForm />
      </Suspense>
      {/*
        reset-password.md: a link with email set up; without it, who makes reset links, on one line
        as sign-in.md draws it: Plex Sans sets it 339px wide against the block's 332px, so it's
        tightened by the title's -0.015em to about 328px.
      */}
      <p className="mt-[16px] text-[12px] leading-[18px] tracking-[-0.015em] text-faint">
        {email.on ? <Link href="/reset" className="font-medium text-teal hover:underline">{t("signIn.forgot")}</Link> : t("signIn.forgotOff")}
      </p>
    </AuthFrame>
  );
};

export default SignInPage;
