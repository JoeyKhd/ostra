"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ConnectionId } from "@ostra/protocol";

import { PageFrame, Section } from "@/components/shell/page-frame";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ConnectionHeader } from "./connection-header";
import { JiraConnect } from "./jira/jira-connect";
import { JiraSettingsPage } from "./jira/jira-settings";
import { LinearView } from "./linear/linear-view";
import { type TrackerDetail, agoText, modeWord, rowStatus } from "./tracker-words";
import { TrackerPanel } from "./trackers-panel";

type LinearDetail = Extract<TrackerDetail, { readonly kind: "linear" }>;

/** A Linear connection's page for a member: its state and events, with no token, webhook URL or action. */
const LinearMemberPage = ({ detail, now }: { readonly detail: LinearDetail; readonly now: number }) => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const status = rowStatus(detail);
  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: detail.name }]}
      properties={<TrackerPanel connection={detail} detail={detail} canManage={false} now={now} link={false} />}
    >
      <ConnectionHeader connectionId={detail.id} kind="linear" name={detail.name} site={detail.site} lede={t("trackers.memberPage.lede")} admin={false} />
      <Section title={t("trackers.linear.connection.title")}>
        <ul className="rows">
          <li className="flex min-h-10 items-center gap-4 py-1.5" data-testid="linear-connection">
            <Status tone={status.kind === "connected" ? "green" : status.kind === "failed" || status.kind === "silent" || status.kind === "expiring" ? "red" : "grey"} {...(status.kind === "connected" ? { className: "text-green" } : status.kind === "failed" ? { className: "text-red" } : {})}>
              {status.kind === "connected"
                ? t("trackers.linear.connection.connected")
                : status.kind === "failed"
                  ? t("trackers.linear.connection.failed")
                  : status.kind === "pending"
                    ? t("trackers.linear.connection.pending")
                    : t("trackers.linear.connection.connected")}
            </Status>
            <span className="font-mono text-text">{detail.site ?? ""}</span>
          </li>
        </ul>
      </Section>
      <Section title={t("trackers.linear.events.title")}>
        <ul className="rows">
          <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2 text-body sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:py-0">
            <span className="col-span-2 text-sm text-muted sm:col-span-1 sm:text-body">{t("trackers.linear.events.mode")}</span>
            <span className="text-text">{modeWord(detail.webhookMode)}</span>
            <span />
          </li>
          <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2 text-body sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:py-0">
            <span className="col-span-2 text-sm text-muted sm:col-span-1 sm:text-body">{t("trackers.linear.events.lastEvent")}</span>
            <span className="text-text">{detail.lastEventAt === null ? <span className="text-faint">{t("trackers.linear.events.noneYet")}</span> : agoText(detail.lastEventAt, now)}</span>
            <span />
          </li>
        </ul>
      </Section>
      <Section title={t("trackers.linear.agentMode.title")} note={t("trackers.linear.agentMode.linearOnly")} noteClassName="text-faint">
        <ul className="rows">
          <li className="flex min-h-10 items-center gap-4 py-1.5">
            <span className="w-[160px] shrink-0 text-body text-muted">{t("trackers.linear.agentMode.state")}</span>
            <Status tone={detail.agentModeAt === null ? "grey" : "green"} {...(detail.agentModeAt === null ? {} : { className: "text-green" })}>
              {detail.agentModeAt === null ? t("trackers.linear.agentMode.off") : t("trackers.linear.agentMode.on")}
            </Status>
          </li>
        </ul>
      </Section>
    </PageFrame>
  );
};

/**
 * A tracker connection's page, `/organization/trackers/<id>` (F-152, choice 13): Linear's connect
 * steps and page, Jira's steps while pending, and each connected connection's settings
 * (connection-settings.md). A member reads the same page without the webhook URL and secret, the
 * token's controls, Rotate, Replace or Disconnect.
 */
export const ConnectionPage = ({ connectionId, admin }: { readonly connectionId: ConnectionId; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const [mounted] = useState(() => Date.now());
  const me = useQuery(trpc.me.get.queryOptions());
  const detail = useQuery(trpc.trackers.get.queryOptions({ id: connectionId }));
  const data = detail.data;
  const now = detail.dataUpdatedAt === 0 ? mounted : detail.dataUpdatedAt;
  if (data?.kind === "linear") {
    if (!admin) return <LinearMemberPage detail={data} now={now} />;
    return <LinearView connectionId={connectionId} name={data.name} site={data.site} boards={data.boards} />;
  }
  if (data?.kind === "jira") {
    if (admin && data.state === "pending") return <JiraConnect connectionId={connectionId} />;
    return <JiraSettingsPage detail={data} canManage={admin} now={now} />;
  }
  return (
    <PageFrame crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: t("trackers.title") }]}>
      {detail.isError ? (
        <p role="alert" className="mt-6 text-sm text-red">
          {errorText(detail.error)}
        </p>
      ) : (
        <SkeletonRows rows={3} />
      )}
    </PageFrame>
  );
};
