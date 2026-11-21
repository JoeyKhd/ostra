"use client";

import { useQuery } from "@tanstack/react-query";
import { EyeIcon } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// F-142 (milestone 8): the previews shared with the member by name, among the Needs you rows, as
// the budget notices are: "Alex Kim shared web :5173 with you", with `Watch` opening the preview's
// own page (`/previews/<id>`). Only while it's still shared with them; nothing of the task.

export type PreviewShare = RouterOutputs["notifications"]["previewShares"][number];

/** The preview as the viewer page names it: `web :5173`. */
export const previewShareName = (share: Pick<PreviewShare, "label" | "port">): string => (share.port === null ? share.label : `${share.label} :${String(share.port)}`);

/** The preview's own page. */
export const previewShareHref = (share: Pick<PreviewShare, "previewId">): string => `/previews/${encodeURIComponent(share.previewId)}`;

export const PreviewShareRows = ({ shares }: { readonly shares: readonly PreviewShare[] }) =>
  shares.length === 0 ? null : (
    <ul className="rows" data-testid="preview-shares" aria-label={t("previewShares.title")}>
      {shares.map((share) => {
        const name = previewShareName(share);
        return (
          <li key={share.notificationId} className="flex min-h-[38px] items-center gap-2.5 border-b border-line py-1.5" data-testid="preview-share" data-read={share.read}>
            <EyeIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
            <span className={cn("min-w-0 flex-1 truncate", share.read ? "text-muted" : "text-text")}>{t("previewShares.line", { who: share.sharedBy ?? t("previewShares.someone"), preview: name })}</span>
            <Link href={previewShareHref(share)} aria-label={t("previewShares.watchLabel", { preview: name })} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 shrink-0 text-ui font-normal")}>
              {t("previewShares.watch")}
            </Link>
          </li>
        );
      })}
    </ul>
  );

/** The previews shared with the member, from `notifications.previewShares`. */
export const usePreviewShares = () => {
  const trpc = useTRPC();
  return useQuery({ ...trpc.notifications.previewShares.queryOptions(), refetchInterval: 30_000 });
};
