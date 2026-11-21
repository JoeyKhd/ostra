"use client";

import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";

import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// The organization's "Allow public preview links" (milestone 8, ticket 26, F-142;
// `instance-preview-domain.md`, "Public preview links"): one component for every page that shows it.
// Off by default. Turning it on asks first, since a public link opens a preview for anyone who has
// it; turning it off saves at once and ends every public link. Only an admin of the organization
// sees the switch; anyone else reads whose choice it is.

export type PublicLinksSettingProps = {
  readonly organizationName: string;
  /** An admin of the organization: the switch; anyone else, the words. */
  readonly admin: boolean;
  readonly enabled: boolean;
  /** `OSTRA_PREVIEW_LINK_MAX_DAYS`, for the switch's off words. */
  readonly linkMaxDays: number;
  /** After a save: the owner reads its data again. */
  readonly onSaved: () => void;
};

export const PublicLinksSetting = ({ organizationName, admin, enabled, linkMaxDays, onSaved }: PublicLinksSettingProps) => {
  const trpc = useTRPC();
  const labelId = useId();
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState(enabled);
  const save = useMutation(
    trpc.organization.setPublicPreviewLinks.mutationOptions({
      onSuccess: (answer) => {
        setShown(answer.enabled);
        setAsking(false);
        onSaved();
      },
    }),
  );
  if (!admin) {
    return (
      <p className="mt-1.5 text-sm text-muted" data-testid="public-links-not-admin">
        {t("instance.previews.public.notAdmin", { organization: organizationName })}
      </p>
    );
  }
  return (
    <div data-testid="public-links-setting">
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui max-lg:min-h-11">
        <Switch
          ref={switchRef}
          checked={shown}
          aria-labelledby={labelId}
          disabled={save.isPending}
          onCheckedChange={(next) => {
            if (next) setAsking(true);
            else save.mutate({ enabled: false });
          }}
          data-testid="public-links-switch"
        />
        <span id={labelId}>{t("instance.previews.public.label")}</span>
        <span className="text-sm text-faint">{shown ? t("instance.previews.public.on") : t("instance.previews.public.off", { days: linkMaxDays })}</span>
      </div>
      <p className="mt-2 max-w-[720px] text-sm text-faint">{t("instance.previews.public.help")}</p>
      {save.error === null || asking ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(save.error)}</p>}
      <AlertDialog open={asking} onOpenChange={(open) => { if (!open && !save.isPending) setAsking(false); }}>
        <AlertDialogContent
          title={t("instance.previews.public.confirmTitle", { organization: organizationName })}
          body={t("instance.previews.public.confirmBody")}
          cancel={t("instance.previews.public.cancel")}
          action={t("instance.previews.public.confirm")}
          onAction={() => { save.mutate({ enabled: true }); }}
          pending={{ busy: save.isPending, label: t("instance.previews.public.confirm"), error: save.error === null ? null : errorText(save.error) }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            switchRef.current?.focus();
          }}
        />
      </AlertDialog>
    </div>
  );
};
