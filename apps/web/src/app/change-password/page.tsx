import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthFrame } from "@/components/auth/auth-frame";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { safeNext } from "@/components/auth/safe-next";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("changePassword.title") };

/**
 * "Choose a new password" (F-001): the first sign-in of an admin seeded with the default password
 * lands here, and the panel sends it back here until it has one. The warning banner links here too
 * when an install allows the default password. Sign-in's frame, so it reads as sign-in's next step.
 */
const ChangePasswordPage = async () => {
  const { caller, signedIn } = await getServerApi();
  if (!signedIn) redirect("/sign-in?next=%2Fchange-password");
  const me = await caller.me.get();
  if (me.passwordChange === "none") {
    const path = (await headers()).get("x-ostra-path") ?? "/";
    redirect(safeNext(new URL(path, "http://panel.invalid").searchParams.get("next")));
  }
  return (
    <AuthFrame>
      <h1 className="page-title text-text">{t("changePassword.title")}</h1>
      <p className="mt-[3px] text-lede text-muted">{t("changePassword.lede")}</p>
      <Suspense>
        <ChangePasswordForm email={me.email} />
      </Suspense>
    </AuthFrame>
  );
};

export default ChangePasswordPage;
