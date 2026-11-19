"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, PlusIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { CopyLink } from "./copy-link";
import { NewPoolSheet } from "./new-pool-sheet";
import { PoolProperties } from "./pool-properties";
import { PoolsTable } from "./pools-table";
import { MyRunnerRows, RunnerRows } from "./runner-rows";
import { adminLede } from "./runner-words";

type Runner = RouterOutputs["runners"]["mine"][number];

/** A runner's kind as the panel says it: a personal `host` runner is "personal, not isolated" (ADR 0029). */
export const RunnerKind = ({ runner }: { readonly runner: Pick<Runner, "kind" | "executor" | "isolated"> }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    <Chip>{runner.kind === "personal" ? t("runners.personal") : t("runners.pool")}</Chip>
    <Chip className="font-mono">{runner.executor}</Chip>
    {/* Amber means only "needs you" (app-design.md): not being isolated is a fact, said in --muted. */}
    {runner.isolated ? null : <Chip><TriangleAlertIcon aria-hidden className="stroke-[1.75]" />{t("runners.notIsolated")}</Chip>}
  </span>
);

/** Which runners the Runners section shows: every one, one pool's, or members' personal ones. */
type Filter = { readonly kind: "all" } | { readonly kind: "pool"; readonly poolId: string } | { readonly kind: "personal" };

const RunnerSkeleton = () => <SkeletonRows rows={3} bars={["w-[90px]", "w-[80px]", "w-[110px]", "w-[60px]", "w-[70px]"]} />;

/** Your machine: the member's own runners, then the command that connects one (everyone sees it). */
const YourMachine = ({ corePublicUrl, mine, now }: { readonly corePublicUrl: string; readonly mine: readonly Runner[] | undefined; readonly now: number }) => {
  const command = `pnpm ostra runner --server ${corePublicUrl}`;
  const windows = mine?.some((runner) => runner.os?.platform === "win32") === true;
  return (
    <Section title={t("runners.yourMachine")} {...(mine === undefined ? {} : { count: mine.length })}>
      <div className="overflow-x-auto">
        <div className="min-w-[800px]">{mine === undefined ? <RunnerSkeleton /> : <MyRunnerRows runners={mine} now={now} />}</div>
      </div>
      <p className="mb-3 mt-4 text-[12.5px] text-muted">{mine !== undefined && mine.length > 0 ? t("runners.connectAnother") : t("runners.connectFirst")}</p>
      <div className="flex min-h-10 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-text">{command}</code>
        <CopyLink text={command} />
      </div>
      <p className="mt-3 flex items-start gap-2 text-sm text-faint">
        <ShieldIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
        <span>
          {t("runners.hostNote")}
          {windows ? t("runners.hostNoteWindows") : ""}
        </span>
      </p>
    </Section>
  );
};

/**
 * Organization › Runners (F-013, F-014, F-091, F-092): for admins the pools, every runner and the
 * selected pool's join tokens; for everyone their own machine and the command that connects it.
 */
export const RunnersView = ({ corePublicUrl, admin }: { readonly corePublicUrl: string; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const mine = useQuery({ ...trpc.runners.mine.queryOptions(), refetchInterval: (query) => (query.state.data?.some((r) => r.state === "online") === true ? 15_000 : 2_000) });
  const runners = useQuery({ ...trpc.runners.list.queryOptions(), enabled: admin, refetchInterval: 5_000 });
  const pools = useQuery({ ...trpc.pools.list.queryOptions(), enabled: admin, refetchInterval: 5_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState<{ readonly poolId: string; readonly token: string } | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [creating, setCreating] = useState(false);
  const now = Date.now();

  const poolList = pools.data ?? [];
  const selected = poolList.find((pool) => pool.id === picked) ?? poolList.find((pool) => pool.isDefault) ?? poolList[0];
  const myIds = new Set((mine.data ?? []).map((runner) => runner.id));
  // The admin's own personal runners are listed under Your machine, not here.
  const others = (runners.data ?? []).filter((runner) => !myIds.has(runner.id));
  const listed = others.filter((runner) =>
    filter.kind === "all" ? true : filter.kind === "personal" ? runner.kind === "personal" : runner.pool?.id === filter.poolId,
  );
  const filterLabel =
    filter.kind === "all"
      ? t("runners.allPools")
      : filter.kind === "personal"
        ? t("runners.personalFilter")
        : (poolList.find((pool) => pool.id === filter.poolId)?.name ?? t("runners.allPools"));

  const ownMachine = (mine.data?.length ?? 0) > 0;
  const lede = !admin
    ? t("runners.ledeMember")
    : runners.data === undefined || pools.data === undefined || mine.data === undefined
      ? undefined
      : adminLede(runners.data, pools.data.length, ownMachine);

  const pickPool = (poolId: string) => {
    setPicked(poolId);
    if (shown !== null && shown.poolId !== poolId) setShown(null);
  };

  const properties =
    selected === undefined ? (
      pools.isPending ? null : <p className="text-body text-muted">{t("runners.noPoolSelected")}</p>
    ) : (
      <PoolProperties
        key={selected.id}
        pool={selected}
        shown={shown?.poolId === selected.id ? shown.token : null}
        onShown={(token) => { setShown({ poolId: selected.id, token }); }}
      />
    );

  return (
    <Sheet open={creating} onOpenChange={setCreating}>
      <PageFrame
        crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.runners") }]}
        {...(admin
          ? {
              actions: (
                <Button variant="primary" onClick={() => { setCreating(true); }}>
                  <PlusIcon className="stroke-[1.75]" /> {t("runners.newPool")}
                </Button>
              ),
              properties,
            }
          : {})}
      >
        <PageHeading title={t("runners.title")} {...(lede === undefined ? {} : { lede })} />
        {lede === undefined ? <div className="h-5" aria-hidden /> : null}
        {admin ? (
          <>
            <Section title={t("runners.pools")} {...(pools.data === undefined ? {} : { count: pools.data.length })}>
              {pools.data === undefined ? <SkeletonRows rows={2} height="h-10" /> : <PoolsTable pools={pools.data} selectedId={selected?.id ?? null} onSelect={pickPool} />}
            </Section>
            <Section
              title={t("runners.runnersSection")}
              {...(runners.data === undefined ? {} : { count: others.length })}
              end={
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex items-center gap-1 text-[12.5px] text-muted hover:text-text" aria-label={t("runners.filter")}>
                    {filterLabel} <ChevronDownIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <DropdownMenuItem onSelect={() => { setFilter({ kind: "all" }); }}>{t("runners.allPools")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {poolList.map((pool) => (
                      <DropdownMenuItem key={pool.id} onSelect={() => { setFilter({ kind: "pool", poolId: pool.id }); }}>
                        {pool.name}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onSelect={() => { setFilter({ kind: "personal" }); }}>{t("runners.personalFilter")}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <div className="overflow-x-auto">
                <div className="min-w-[800px]">
                  {runners.data === undefined ? (
                    <RunnerSkeleton />
                  ) : listed.length === 0 ? (
                    <p className="flex h-10 items-center border-y border-line px-2 text-muted">{t("runners.noRunners")}</p>
                  ) : (
                    <RunnerRows runners={listed} now={now} />
                  )}
                </div>
              </div>
            </Section>
          </>
        ) : null}
        <YourMachine corePublicUrl={corePublicUrl} mine={mine.data} now={now} />
      </PageFrame>
      {admin ? <NewPoolSheet key={creating ? "open" : "closed"} onCreated={(poolId) => { setCreating(false); pickPool(poolId); }} /> : null}
    </Sheet>
  );
};
