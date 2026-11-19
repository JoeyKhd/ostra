import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

export type DefaultPasswordBannerProps = {
  readonly passwordChange: RouterOutputs["me"]["get"]["passwordChange"];
  /** The page it's on, so `Change it` comes back here afterwards. */
  readonly path: string;
};

/**
 * F-001: the band under the top bar while the signed-in account still has the default password it
 * was seeded with (change-password.md, "The banner"). Neutral, not amber: it's an account notice, not
 * work that waits. No close button; it goes once the password changes. With
 * OSTRA_ALLOW_DEFAULT_PASSWORD off the panel asks for the change before this is ever seen.
 */
export const DefaultPasswordBanner = ({ passwordChange, path }: DefaultPasswordBannerProps) =>
  passwordChange === "none" ? null : (
    <div
      role="region"
      aria-label={t("banner.defaultPassword.label")}
      data-testid="default-password-banner"
      className="flex h-9 shrink-0 items-center gap-2.5 overflow-hidden border-b border-line bg-raise pl-4 pr-4 text-body sm:pl-10 sm:pr-[18px]"
    >
      <KeyRoundIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-text" />
      <p className="flex min-w-0 flex-1 items-baseline gap-1 whitespace-nowrap">
        <span className="min-w-0 truncate font-medium text-text">{t("banner.defaultPassword.lead")}</span>
        <span className="hidden shrink-[2] truncate text-muted sm:inline">{t("banner.defaultPassword.detail")}</span>
      </p>
      <Link
        href={path === "/" ? "/change-password" : `/change-password?next=${encodeURIComponent(path)}`}
        className="shrink-0 font-medium text-teal underline-offset-2 hover:underline"
      >
        {t("banner.defaultPassword.action")}
      </Link>
    </div>
  );
