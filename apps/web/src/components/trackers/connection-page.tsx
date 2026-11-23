"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ConnectionId } from "@ostra/protocol";

import { LinearView } from "@/components/linear/linear-view";
import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { SkeletonRows } from "@/components/ui/skeleton";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { kindWord } from "./tracker-words";
import { TrackerPanel } from "./trackers-panel";

/**
 * A tracker connection's page, `/organization/trackers/<id>` (F-152, choice 13), where the list's
 * `Open <name> →`, a phone's card, `Enter` on a row and the picker's `Continue` lead. Until tickets
 * 13 and 14 build its targets (`jira-connect.md`, `connection-settings.md`): a Linear connection
 * shows Linear's page under its connection, as Organization › Linear did, to its admins; every
 * other reader, and a Jira connection, sees the connection's detail as the list's panel shows it.
 */
export const ConnectionPage = ({ connectionId, admin }: { readonly connectionId: ConnectionId; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const [mounted] = useState(() => Date.now());
  const me = useQuery(trpc.me.get.queryOptions());
  const detail = useQuery(trpc.trackers.get.queryOptions({ id: connectionId }));
  const data = detail.data;
  if (data?.kind === "linear" && admin) return <LinearView connectionId={connectionId} name={data.name} />;
  const crumbs = [{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: data?.name ?? t("trackers.title") }];
  return (
    <PageFrame crumbs={crumbs}>
      <PageHeading title={data?.name ?? t("trackers.title")} {...(data === undefined ? {} : { lede: kindWord(data.kind) })} />
      {detail.isError ? (
        <p role="alert" className="mt-6 text-sm text-red">{errorText(detail.error)}</p>
      ) : data === undefined ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="mt-2 max-w-[420px]">
          <TrackerPanel connection={data} detail={data} canManage={admin} now={detail.dataUpdatedAt === 0 ? mounted : detail.dataUpdatedAt} link={false} />
        </div>
      )}
    </PageFrame>
  );
};
