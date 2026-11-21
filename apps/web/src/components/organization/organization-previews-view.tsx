"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PublicLinksSetting } from "@/components/instance/public-links-setting";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// Organization › Previews (milestone 8, F-142; the lead's polish of 2026-11-21): the organization's
// "Allow public preview links", for its admins. An organization admin may not be the instance admin,
// so may never reach Instance › Previews, which shows the same switch: one component
// (`PublicLinksSetting`), the same words, the same audited `organization.setPublicPreviewLinks`.

export const OrganizationPreviewsView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.organization.previews.queryOptions());
  const data = query.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.organization.previews.queryKey() });

  return (
    <PageFrame crumbs={[{ label: t("shell.organization") }, { label: t("organizationPreviews.title") }]}>
      <div className="max-w-[744px]" data-testid="organization-previews">
        <PageHeading title={t("organizationPreviews.title")} lede={t("organizationPreviews.lede")} />
        {data === undefined ? (
          <div aria-busy="true" className="mt-[26px] flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
          <Section title={t("instance.previews.public.title")} note={t("instance.previews.public.note", { organization: data.name })}>
            <PublicLinksSetting organizationName={data.name} admin enabled={data.publicPreviewLinks} linkMaxDays={data.linkMaxDays} onSaved={() => { void refresh(); }} />
          </Section>
        )}
      </div>
    </PageFrame>
  );
};
