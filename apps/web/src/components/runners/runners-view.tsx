"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, KeyRoundIcon, LaptopIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { runnerStateText, runnerTone } from "@/components/runners/runner-words";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Chip, Code, Status } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

type Runner = RouterOutputs["runners"]["mine"][number];

/** A runner's kind as the panel says it: a personal `host` runner is "personal, not isolated" (ADR 0029). */
export const RunnerKind = ({ runner }: { readonly runner: Pick<Runner, "kind" | "executor" | "isolated"> }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    <Chip>{runner.kind === "personal" ? t("runners.personal") : t("runners.pool")}</Chip>
    <Chip className="font-mono">{runner.executor}</Chip>
    {runner.isolated ? null : <Chip className="text-amber">{t("runners.notIsolated")}</Chip>}
  </span>
);

const CopyButton = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      <CopyIcon /> {copied ? t("common.copied") : t("common.copy")}
    </Button>
  );
};

const RunnerRow = ({ runner, owner }: { readonly runner: Runner; readonly owner?: string | null }) => (
  <li data-runner={runner.name} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
    {runner.kind === "personal" ? <LaptopIcon className="size-[15px] text-muted" /> : <ServerIcon className="size-[15px] text-muted" />}
    <span className="font-mono">{runner.name}</span>
    <RunnerKind runner={runner} />
    {owner === undefined || owner === null ? null : <span className="text-sm text-muted">{owner}</span>}
    <span className="ml-auto flex items-center gap-3 text-sm">
      <span className="font-mono text-faint">{t("runners.capacity", { n: runner.capacity })}</span>
      <span className="font-mono text-faint">v{runner.version}</span>
      <Status tone={runnerTone(runner.state)}>
        {runner.state === "online" || runner.lastSeenAt === null ? runnerStateText(runner.state) : t("runners.seenAgo", { state: runnerStateText(runner.state), age: formatAge(runner.lastSeenAt) })}
      </Status>
    </span>
  </li>
);

const JoinTokens = ({ poolId }: { readonly poolId: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tokens = useQuery(trpc.pools.joinTokens.queryOptions({ poolId }));
  const [shown, setShown] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.pools.joinTokens.queryKey({ poolId }) });
  const create = useMutation(trpc.pools.createJoinToken.mutationOptions({ onSuccess: async (made) => { setShown(made.token); await invalidate(); } }));
  const revoke = useMutation(trpc.pools.revokeJoinToken.mutationOptions({ onSettled: invalidate }));
  return (
    <div className="mt-2 pl-7">
      {shown === null ? null : (
        <div className="mb-2" data-testid="join-token">
          <p className="mb-1 text-sm text-amber">{t("runners.tokenOnce")}</p>
          <div className="flex items-start gap-2">
            <Code className="min-w-0 flex-1">{shown}</Code>
            <CopyButton text={shown} />
          </div>
        </div>
      )}
      <ul className="text-sm">
        {tokens.data?.map((token) => (
          <li key={token.id} className="flex min-h-8 items-center gap-2">
            <KeyRoundIcon className="size-3 text-faint" />
            <span className="text-muted">{token.label ?? t("runners.joinToken")}</span>
            {token.expiresAt === null ? null : <span className="font-mono text-faint">{t("runners.expires", { date: new Date(token.expiresAt).toISOString().slice(0, 10) })}</span>}
            <Button size="sm" variant="ghost" className="ml-auto" disabled={revoke.isPending} onClick={() => { revoke.mutate({ joinTokenId: token.id }); }}>
              {t("runners.revoke")}
            </Button>
          </li>
        ))}
      </ul>
      {create.error === null ? null : <p role="alert" className="text-sm text-red">{errorText(create.error)}</p>}
      <Button size="sm" onClick={() => { create.mutate({ poolId, expiresInDays: 30 }); }} disabled={create.isPending}>
        <KeyRoundIcon /> {t("runners.newJoinToken")}
      </Button>
    </div>
  );
};

const AdminSections = () => {
  const trpc = useTRPC();
  const runners = useQuery({ ...trpc.runners.list.queryOptions(), refetchInterval: 5_000 });
  const pools = useQuery(trpc.pools.list.queryOptions());
  return (
    <>
      <Section title={t("runners.pools")} count={pools.data?.length ?? 0}>
        <ul className="rows">
          {pools.data?.map((pool) => (
            <li key={pool.id} className="py-2">
              <div className="flex min-h-8 items-center gap-3">
                <ServerIcon className="size-[15px] text-muted" />
                <span className="font-medium">{pool.name}</span>
                {pool.isDefault ? <Chip>{t("runners.defaultPool")}</Chip> : null}
                <span className="ml-auto font-mono text-sm text-muted">{t("runners.onlineCount", { online: pool.onlineCount, total: pool.runnerCount })}</span>
              </div>
              <JoinTokens poolId={pool.id} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t("runners.all")} count={runners.data?.length ?? 0}>
        <ul className="rows">
          {runners.data?.map((runner) => <RunnerRow key={runner.id} runner={runner} owner={runner.owner?.name ?? null} />)}
        </ul>
      </Section>
    </>
  );
};

/**
 * Organization › Runners (F-013, F-014, F-091's first slice): the command that connects a personal
 * runner, the member's runners appearing online, and for admins the pools and their join tokens.
 */
export const RunnersView = ({ corePublicUrl, admin }: { readonly corePublicUrl: string; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const mine = useQuery({ ...trpc.runners.mine.queryOptions(), refetchInterval: (query) => (query.state.data?.some((r) => r.state === "online") === true ? 15_000 : 2_000) });
  const command = `pnpm ostra runner --server ${corePublicUrl}`;
  return (
    <PageFrame crumbs={[{ label: t("shell.organization") }, { label: t("shell.runners") }]}>
      <PageHeading title={t("runners.title")} lede={t("runners.lede")} />
      <Section title={t("runners.connect")}>
        <p className="mb-2 text-muted">{t("runners.connectBody")}</p>
        <div className="flex items-start gap-2">
          <Code className="min-w-0 flex-1" >{command}</Code>
          <CopyButton text={command} />
        </div>
        <p className="mt-2 text-sm text-faint">{t("runners.connectAfter")}</p>
        <p className="mt-2 flex items-start gap-1.5 text-sm text-amber">
          <TriangleAlertIcon className="mt-0.5 size-[13px] shrink-0" />
          {t("runners.hostWarning")}
        </p>
      </Section>
      <Section title={t("runners.mine")} count={mine.data?.length ?? 0}>
        {mine.data?.length === 0 ? <p className="border-t border-line py-3 text-muted">{t("runners.noneYet")}</p> : null}
        <ul className="rows" data-testid="my-runners">
          {mine.data?.map((runner) => <RunnerRow key={runner.id} runner={runner} />)}
        </ul>
      </Section>
      {admin ? <AdminSections /> : null}
    </PageFrame>
  );
};
