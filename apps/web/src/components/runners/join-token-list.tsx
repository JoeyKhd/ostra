"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { isoDate, shortDate } from "./runner-words";

type JoinToken = RouterOutputs["joinTokens"]["list"][number];

/** A token's second line: `expires 2026-12-19 · used 3h ago · 2 runners`, `expired 2026-11-20 · …`, or `revoked 12 Nov`. */
export const tokenDetail = (token: Pick<JoinToken, "expiresAt" | "lastUsedAt" | "revokedAt" | "uses">, now: number = Date.now()): string => {
  if (token.revokedAt !== null) return t("runners.revokedOn", { date: shortDate(token.revokedAt) });
  const expires =
    token.expiresAt === null ? t("runners.neverExpires") : token.expiresAt <= now ? t("runners.expiredOn", { date: isoDate(token.expiresAt) }) : t("runners.expires", { date: isoDate(token.expiresAt) });
  const age = token.lastUsedAt === null ? null : formatAge(token.lastUsedAt, now);
  const used = age === null ? t("runners.neverUsed") : age === "now" ? t("runners.usedJustNow") : t("runners.usedAgo", { age });
  const runners = token.uses === 0 ? null : token.uses === 1 ? t("runners.join.oneRunner") : t("runners.join.runners", { n: token.uses });
  return [expires, used, runners].filter((part): part is string => part !== null).join(" · ");
};

/**
 * A pool's join tokens, newest first, with `Revoke` (pool.md, pool-join.md): never the token itself,
 * which exists only in the answer that made it.
 */
export const JoinTokenList = ({ poolId, onRevoked }: { readonly poolId: string; readonly poolName: string; readonly onRevoked?: (joinTokenId: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tokens = useQuery(trpc.joinTokens.list.queryOptions({ poolId }));
  const revoke = useMutation(
    trpc.joinTokens.revoke.mutationOptions({
      onSuccess: (result) => { onRevoked?.(result.joinTokenId); },
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.joinTokens.list.queryKey({ poolId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.pools.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.pools.get.queryKey({ poolId }) }),
        ]),
    }),
  );
  const active = tokens.data?.filter((token) => token.state === "active").length;
  const now = Date.now();
  return (
    <div data-testid="join-tokens">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-xs font-medium text-faint">{t("runners.joinTokens")}</h3>
        {active === undefined ? null : <span className="font-mono text-[12.5px] text-faint">{active}</span>}
      </div>
      {revoke.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(revoke.error)}</p>}
      {tokens.isPending ? (
        <div aria-busy className="space-y-3 pt-2">
          <Skeleton className="w-3/4" />
          <Skeleton className="w-1/2" />
        </div>
      ) : null}
      <ul className="divide-y divide-line border-b border-line">
        {tokens.data?.map((token) => {
          // An expired token joins nothing more, as a revoked one: struck through, with no Revoke.
          const revoked = token.revokedAt !== null || token.state === "expired";
          return (
            <li key={token.id} data-token={token.label ?? t("runners.joinToken")} className="flex min-h-[54px] items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className={cn("truncate font-mono text-body", revoked ? "text-faint line-through" : "text-text")}>{token.label ?? t("runners.joinToken")}</div>
                <div className="font-mono text-[12.5px] leading-[1.5] text-faint">{tokenDetail(token, now)}</div>
              </div>
              {revoked ? null : (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="-mr-1.5 px-1.5" disabled={revoke.isPending}>{t("runners.revoke")}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    title={t("runners.revokeTitle")}
                    body={t("runners.revokeBody")}
                    cancel={t("common.cancel")}
                    action={t("runners.revoke")}
                    onAction={() => { revoke.mutate({ tokenId: token.id }); }}
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
