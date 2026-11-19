"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import { PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { CopyLink } from "./copy-link";
import type { Pool } from "./pools-table";

type JoinToken = RouterOutputs["pools"]["joinTokens"][number];

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const shortDate = (ms: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(ms));

/** A token's second line: `expires 2026-12-19 · used 20m ago`, or `revoked 18 Nov`. */
export const tokenDetail = (token: Pick<JoinToken, "expiresAt" | "lastUsedAt" | "revokedAt">, now: number = Date.now()): string => {
  if (token.revokedAt !== null) return t("runners.revokedOn", { date: shortDate(token.revokedAt) });
  const expires = token.expiresAt === null ? t("runners.neverExpires") : t("runners.expires", { date: isoDate(token.expiresAt) });
  const age = token.lastUsedAt === null ? null : formatAge(token.lastUsedAt, now);
  const used = age === null ? t("runners.neverUsed") : age === "now" ? t("runners.usedJustNow") : t("runners.usedAgo", { age });
  return `${expires} · ${used}`;
};

/** `calculator, +2`: the first project's name, then how many more. */
const projectsText = (pool: Pool): string => {
  if (pool.firstProjectName === null) return t("runners.noProjects");
  return pool.projectCount > 1 ? t("runners.moreProjects", { name: pool.firstProjectName, n: pool.projectCount - 1 }) : pool.firstProjectName;
};

const Sep = () => <div className="my-3.5 h-px bg-line" />;

/**
 * The selected pool in the properties panel: its settings, then its join tokens. A token just
 * made is shown here once, in full, and is never fetched again (Q48, Q94).
 */
export const PoolProperties = ({ pool, shown, onShown }: { readonly pool: Pool; readonly shown: string | null; readonly onShown: (token: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tokens = useQuery(trpc.pools.joinTokens.queryOptions({ poolId: pool.id }));
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.pools.joinTokens.queryKey({ poolId: pool.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.pools.list.queryKey() }),
    ]);
  const create = useMutation(trpc.pools.createJoinToken.mutationOptions({ onSuccess: async (made) => { onShown(made.token); await invalidate(); } }));
  const revoke = useMutation(trpc.pools.revokeJoinToken.mutationOptions({ onSettled: invalidate }));
  const active = tokens.data?.filter((token) => token.revokedAt === null).length;
  const failure = create.error ?? revoke.error;
  const now = Date.now();

  return (
    <div data-testid="pool-properties">
      <h3 className="mb-2 text-xs font-medium text-faint">{pool.name}</h3>
      <PropRow label={t("runners.prop.executor")}><span className="font-mono">{pool.executors.length === 0 ? "—" : pool.executors.join(", ")}</span></PropRow>
      <PropRow label={t("runners.prop.runners")}><span className="font-mono">{t("runners.onlineCount", { online: pool.onlineCount, total: pool.runnerCount })}</span></PropRow>
      <PropRow label={t("runners.prop.busy")}><span className="font-mono">{t("runners.boxesOf", { busy: pool.busy, slots: pool.slots })}</span></PropRow>
      <PropRow label={t("runners.prop.projects")}><span className="truncate">{projectsText(pool)}</span></PropRow>
      <PropRow label={t("runners.prop.approval")}>{pool.requiresApproval ? t("runners.approvalRequired") : t("runners.approvalNotRequired")}</PropRow>
      <PropRow label={t("runners.prop.maxBoxes")}>{pool.maxBoxes === null ? t("runners.noLimit") : <span className="font-mono">{pool.maxBoxes}</span>}</PropRow>
      <Sep />
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12.5px] text-muted">{t("runners.joinTokens")}</h3>
        {active === undefined ? null : <span className="font-mono text-[11.5px] text-faint">{active}</span>}
        <Button size="sm" className="ml-auto" disabled={create.isPending} onClick={() => { create.mutate({ poolId: pool.id, expiresInDays: 30 }); }}>
          <PlusIcon className="stroke-[1.75]" /> {t("runners.newToken")}
        </Button>
      </div>
      {failure === null ? null : <p role="alert" className="mb-2 text-[12.5px] text-red">{errorText(failure)}</p>}
      {shown === null ? null : (
        <div className="mb-3" data-testid="join-token">
          <div className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[12.5px] leading-[1.6] text-text">{shown}</code>
            <CopyLink text={shown} />
          </div>
          <p className="mt-1.5 text-sm text-muted">{t("runners.shownOnce")}</p>
        </div>
      )}
      {tokens.isPending ? (
        <div aria-busy className="space-y-3 pt-1">
          <Skeleton className="w-3/4" />
          <Skeleton className="w-1/2" />
        </div>
      ) : null}
      <ul className="rows">
        {tokens.data?.map((token) => {
          const revoked = token.revokedAt !== null;
          return (
            <li key={token.id} className="flex min-h-[50px] items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className={cn("truncate", revoked ? "text-faint line-through" : "text-text")}>{token.label ?? t("runners.joinToken")}</div>
                <div className="font-mono text-[11.5px] leading-[1.5] text-faint">{tokenDetail(token, now)}</div>
              </div>
              {revoked ? null : (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="px-1.5" disabled={revoke.isPending}>{t("runners.revoke")}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    title={t("runners.revokeTitle")}
                    body={t("runners.revokeBody")}
                    cancel={t("common.cancel")}
                    action={t("runners.revoke")}
                    onAction={() => { revoke.mutate({ joinTokenId: token.id }); }}
                  />
                </AlertDialog>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
