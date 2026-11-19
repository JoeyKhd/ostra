import { parseServerSettings } from "@ostra/domain";
import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";

import { AuthFrame } from "@/components/auth/auth-frame";
import { AuthMessage } from "@/components/auth/auth-message";
import { ResetRequestForm } from "@/components/auth/reset-request-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("reset.title"), robots: { index: false, follow: false } };

/** `/reset` (F-002, reset-password.md): the request by mail, or, without email, who to ask. */
const ResetPage = async () => {
  const { caller } = await getServerApi();
  const email = await caller.email.on();
  const parsed = parseServerSettings(process.env);
  const hours = parsed.ok ? parsed.settings.resetLinkHours : 24;
  return (
    <AuthFrame>
      {email.on ? (
        <ResetRequestForm hours={hours} />
      ) : (
        <AuthMessage icon={KeyRoundIcon} title={t("reset.offTitle")} help={<p><Link href="/sign-in" className="font-medium text-teal hover:underline">{t("reset.back")}</Link></p>}>
          {t("reset.offLede", { hours })}
        </AuthMessage>
      )}
    </AuthFrame>
  );
};

export default ResetPage;
