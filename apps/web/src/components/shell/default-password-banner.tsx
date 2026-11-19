import { TriangleAlertIcon } from "lucide-react";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

/**
 * F-001: the warning across the top of the panel while the signed-in account still has the
 * default password it was seeded with. Shown until the password changes; with
 * OSTRA_ALLOW_DEFAULT_PASSWORD off the panel asks for the change before this is ever seen.
 */
export const DefaultPasswordBanner = ({ passwordChange }: { readonly passwordChange: RouterOutputs["me"]["get"]["passwordChange"] }) =>
  passwordChange === "none" ? null : (
    <div role="alert" data-testid="default-password-banner" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber/40 bg-amber/10 px-3 py-2 text-sm text-text sm:px-[18px]">
      <TriangleAlertIcon className="size-4 shrink-0 text-amber" aria-hidden />
      <span className="min-w-0 flex-1">{t("defaultPassword.banner")}</span>
      <a href="/change-password" className="font-medium text-amber underline-offset-2 hover:underline">
        {t("defaultPassword.action")}
      </a>
    </div>
  );
