import { parseServerSettings } from "@ostra/domain";
import { TRPCError } from "@trpc/server";

import { AuthFrame } from "@/components/auth/auth-frame";
import { ResetNewForm } from "@/components/auth/reset-new-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

// The token is a bearer secret: never indexed, never sent on as a Referer.
export const metadata = { title: t("reset.newTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> };

/** `/reset/new?token=…` (F-002, reset-password.md): the link's page, from `accounts.resetPreview`. */
const ResetNewPage = async ({ searchParams }: Props) => {
  const query = await searchParams;
  const token = typeof query["token"] === "string" ? query["token"] : "";
  const { caller } = await getServerApi();
  const [email, preview] = await Promise.all([
    caller.email.on(),
    token === ""
      ? Promise.resolve({ state: "unknown" } as const)
      : caller.accounts
          .resetPreview({ token })
          .catch((error: unknown) => (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS" ? ({ state: "too-many" } as const) : ({ state: "unknown" } as const))),
  ]);
  const parsed = parseServerSettings(process.env);
  return (
    <AuthFrame>
      <ResetNewForm token={token} preview={preview} emailOn={email.on} hours={parsed.ok ? parsed.settings.resetLinkHours : 24} />
    </AuthFrame>
  );
};

export default ResetNewPage;
