"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";

import { PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/messages";

import { JoinTokenList } from "./join-token-list";
import type { Pool } from "./pools-table";

/** `calculator, +2`: the first project's name, then how many more. */
const projectsText = (pool: Pool): string => {
  if (pool.firstProjectName === null) return t("runners.noProjects");
  return pool.projectCount > 1 ? t("runners.moreProjects", { name: pool.firstProjectName, n: pool.projectCount - 1 }) : pool.firstProjectName;
};

const Sep = () => <div className="my-3.5 h-px bg-line" />;

/**
 * The selected pool's summary in the Runners page's panel, and its join tokens. `New token` opens
 * the pool sheet's short form; the token itself is shown once there (pool-join.md), never here.
 */
export const PoolProperties = ({ pool, onNewToken }: { readonly pool: Pool; readonly onNewToken: () => void }) => (
  <div data-testid="pool-properties">
    <div className="mb-2 flex items-center">
      <h3 className="text-xs font-medium text-faint">{pool.name}</h3>
      <Link href={`/organization/runners/pools/${pool.id}`} className="ml-auto text-ui text-teal hover:underline">{t("runners.pool.open")}</Link>
    </div>
    <PropRow label={t("runners.prop.executor")}><span className="font-mono">{pool.executors.length === 0 ? "—" : pool.executors.join(", ")}</span></PropRow>
    <PropRow label={t("runners.prop.runners")}><span className="font-mono">{t("runners.onlineCount", { online: pool.onlineCount, total: pool.runnerCount })}</span></PropRow>
    <PropRow label={t("runners.prop.busy")}><span className="font-mono">{t("runners.boxesOf", { busy: pool.busy, slots: pool.slots })}</span></PropRow>
    <PropRow label={t("runners.pool.queueKey")}>{pool.queueLength === 0 ? t("runners.pool.nothingWaiting") : <span className="font-mono">{t("runners.pool.waiting", { n: pool.queueLength })}</span>}</PropRow>
    <PropRow label={t("runners.prop.projects")}><span className="truncate">{projectsText(pool)}</span></PropRow>
    <PropRow label={t("runners.prop.approval")}>{pool.requiresApproval ? t("runners.approvalRequired") : t("runners.approvalNotRequired")}</PropRow>
    <PropRow label={t("runners.prop.maxBoxes")}>{pool.maxBoxes === null ? t("runners.noLimit") : <span className="font-mono">{pool.maxBoxes}</span>}</PropRow>
    <Sep />
    <div className="mb-1 flex justify-end">
      <Button size="sm" onClick={onNewToken}>
        <PlusIcon className="stroke-[1.75]" /> {t("runners.newToken")}
      </Button>
    </div>
    <JoinTokenList poolId={pool.id} poolName={pool.name} />
  </div>
);
