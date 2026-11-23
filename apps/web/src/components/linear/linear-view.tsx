"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { ConnectionId } from "@ostra/protocol";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { buttonVariants } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AgentModeSections, AgentSessionsGroup } from "./agent-mode";
import { ErrorLine, LinearBody, LinearProperties } from "./linear-panel";
import type { LinearActions } from "./linear-panel";
import { linearWorkspaceUrl } from "./linear-status";

/** A callback error from the URL, cut to 300 characters (connect-linear.md, "Back from Linear"). */
const callbackError = (value: string | null): string | null => (value === null || value === "" ? null : value.slice(0, 300));

/**
 * One Linear connection's page (F-005, F-042; connect-linear.md), at `/organization/trackers/<id>`
 * since milestone 11 (F-152; ticket 12 moved it there from `/organization/linear`, ticket 14 gives
 * it the targets' header): connect the organization's own Linear app in three steps, then see
 * whether its events arrive and its token is healthy. Each call names this connection
 * (`trackers.linear.*`, `trackers.disconnect`). A connection just made in the picker (`?new=1`)
 * opens at step 1, whose button makes the app in Linear from the pre-filled link. Admins only.
 */
export const LinearView = ({ connectionId, name }: { readonly connectionId: ConnectionId; readonly name: string }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const [mounted] = useState(() => Date.now());
  const [fresh, setFresh] = useState(() => params.get("new") === "1");
  const me = useQuery(trpc.me.get.queryOptions());
  const status = useQuery({ ...trpc.trackers.linear.status.queryOptions({ connectionId }), refetchInterval: 30_000 });
  const now = status.dataUpdatedAt === 0 ? mounted : status.dataUpdatedAt;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.trackers.pathKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
  };

  const saveApp = useMutation(trpc.trackers.linear.saveApp.mutationOptions({ onSuccess: refresh }));
  const authorize = useMutation(
    trpc.trackers.linear.authorizeUrl.mutationOptions({
      onSuccess: (result) => {
        window.location.assign(result.authorizeUrl);
      },
    }),
  );
  const create = useMutation(
    trpc.trackers.create.mutationOptions({
      onSuccess: async (made) => {
        await refresh();
        router.replace(`/organization/trackers/${made.connectionId}?new=1`);
      },
    }),
  );
  const disconnect = useMutation(trpc.trackers.disconnect.mutationOptions());

  const data = status.data;
  const actions: LinearActions = {
    // Step 1: the app made in Linear from the pre-filled link, in a new tab, from this press itself.
    start: {
      run: () => {
        if (data?.manifestUrl !== null && data?.manifestUrl !== undefined) window.open(data.manifestUrl, "_blank", "noopener");
        setFresh(false);
        router.replace(`/organization/trackers/${connectionId}`, { scroll: false });
      },
      pending: false,
      error: null,
    },
    saveApp: {
      run: (values) => {
        saveApp.mutate({ connectionId, clientId: values.clientId, clientSecret: values.clientSecret, ...(values.webhookSecret === null ? {} : { webhookSecret: values.webhookSecret }) });
      },
      pending: saveApp.isPending,
      error: errorText(saveApp.error),
    },
    authorize: { run: () => { authorize.mutate({ connectionId }); }, pending: authorize.isPending || authorize.isSuccess, error: errorText(authorize.error) },
    // "Start again" ends this pending connection and starts a fresh one (ticket 27).
    startAgain: {
      run: () => {
        disconnect.mutate({ id: connectionId }, { onSuccess: () => { create.mutate({ kind: "linear" }); } });
      },
      pending: disconnect.isPending || create.isPending,
      error: errorText(disconnect.error) ?? errorText(create.error),
    },
    disconnect: {
      run: () => {
        disconnect.mutate(
          { id: connectionId },
          {
            onSuccess: () => {
              void refresh();
              router.push("/organization/trackers");
            },
          },
        );
      },
      pending: disconnect.isPending,
      error: errorText(disconnect.error),
    },
  };
  const connected = data !== undefined && data.state !== "pending";
  const error = callbackError(params.get("error"));

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: name }]}
      actions={
        connected ? (
          <a href={linearWorkspaceUrl(data.workspaceKey)} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
            <ExternalLinkIcon className="stroke-[1.75]" />
            {t("linear.openInLinear")}
          </a>
        ) : undefined
      }
      properties={<LinearProperties status={data} sessions={data?.agentMode?.on === true ? <AgentSessionsGroup agent={data.agentMode} /> : null} />}
    >
      <PageHeading title={name} lede={t("linear.lede")} />
      {error === null ? null : <ErrorLine className="mt-3">{error}</ErrorLine>}
      {status.isError ? <ErrorLine className="mt-6">{errorText(status.error)}</ErrorLine> : null}
      <LinearBody
        status={data}
        actions={actions}
        now={now}
        justConnected={params.get("connected") === "1"}
        appMade={!(fresh && data?.state === "pending" && !data.appSaved)}
        agentMode={data === undefined ? undefined : <AgentModeSections status={data} now={now} justTurnedOn={params.get("agent-mode") === "1"} />}
      />
    </PageFrame>
  );
};
