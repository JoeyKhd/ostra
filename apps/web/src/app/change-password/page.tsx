import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { safeNext } from "@/components/auth/sign-in-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("changePassword.title") };

/**
 * "Choose a new password" (F-001): the first sign-in of an admin seeded with the default password
 * lands here, and the panel sends it back here until it has one. The warning banner links here too
 * when an install allows the default password.
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
    <AuthCard title={t("changePassword.title")} lede={t("changePassword.lede")}>
      <Suspense>
        <ChangePasswordForm />
      </Suspense>
    </AuthCard>
  );
};

export default ChangePasswordPage;
