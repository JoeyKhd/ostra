"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { buttonVariants } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ErrorLine, LinearBody, LinearProperties } from "./linear-panel";
import type { LinearActions } from "./linear-panel";
import { linearWorkspaceUrl } from "./linear-status";

/** A callback error from the URL, cut to 300 characters (connect-linear.md, "Back from Linear"). */
const callbackError = (value: string | null): string | null => (value === null || value === "" ? null : value.slice(0, 300));

/**
 * Organization › Linear (F-005, F-042; connect-linear.md): connect the organization's own Linear
 * app in three steps, then see whether its events arrive and its token is healthy. Admins only.
 */
export const LinearView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const [mounted] = useState(() => Date.now());
  const me = useQuery(trpc.me.get.queryOptions());
  const status = useQuery({ ...trpc.linear.status.queryOptions(), refetchInterval: 30_000 });
  const now = status.dataUpdatedAt === 0 ? mounted : status.dataUpdatedAt;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.linear.status.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
  };

  const start = useMutation(
    trpc.linear.start.mutationOptions({
      onSuccess: async (result) => {
        window.open(result.manifestUrl, "_blank", "noopener");
        await refresh();
      },
    }),
  );
  const saveApp = useMutation(trpc.linear.saveApp.mutationOptions({ onSuccess: refresh }));
  const authorize = useMutation(
    trpc.linear.authorizeUrl.mutationOptions({
      onSuccess: (result) => {
        window.location.assign(result.authorizeUrl);
      },
    }),
  );
  const disconnect = useMutation(trpc.linear.disconnect.mutationOptions({ onSuccess: refresh }));

  const data = status.data;
  const connectionId = data === undefined || data.state === "none" ? null : data.connectionId;
  const withConnection = (run: (id: NonNullable<typeof connectionId>) => void) => () => {
    if (connectionId !== null) run(connectionId);
  };
  const actions: LinearActions = {
    start: { run: () => { start.mutate(); }, pending: start.isPending, error: errorText(start.error) },
    saveApp: {
      run: (values) => {
        if (connectionId === null) return;
        saveApp.mutate({ connectionId, clientId: values.clientId, clientSecret: values.clientSecret, ...(values.webhookSecret === null ? {} : { webhookSecret: values.webhookSecret }) });
      },
      pending: saveApp.isPending,
      error: errorText(saveApp.error),
    },
    authorize: { run: withConnection((id) => { authorize.mutate({ connectionId: id }); }), pending: authorize.isPending || authorize.isSuccess, error: errorText(authorize.error) },
    // "Start again" ends the pending row and starts a fresh one (ticket 27).
    startAgain: {
      run: withConnection((id) => {
        disconnect.mutate({ connectionId: id }, { onSuccess: () => { start.mutate(); } });
      }),
      pending: disconnect.isPending || start.isPending,
      error: errorText(disconnect.error),
    },
    disconnect: { run: withConnection((id) => { disconnect.mutate({ connectionId: id }); }), pending: disconnect.isPending, error: errorText(disconnect.error) },
  };
  const connected = data !== undefined && data.state !== "none" && data.state !== "pending";
  const error = callbackError(params.get("error"));

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("linear.title") }]}
      actions={
        connected ? (
          <a href={linearWorkspaceUrl(data.workspaceKey)} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
            <ExternalLinkIcon className="stroke-[1.75]" />
            {t("linear.openInLinear")}
          </a>
        ) : undefined
      }
      properties={<LinearProperties status={data} />}
    >
      <PageHeading title={t("linear.title")} lede={t("linear.lede")} />
      {error === null ? null : <ErrorLine className="mt-3">{error}</ErrorLine>}
      {status.isError ? <ErrorLine className="mt-6">{errorText(status.error)}</ErrorLine> : null}
      <LinearBody status={data} actions={actions} now={now} justConnected={params.get("connected") === "1"} />
    </PageFrame>
  );
};
