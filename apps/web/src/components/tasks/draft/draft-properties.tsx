"use client";

import { useQuery } from "@tanstack/react-query";

import type { TaskId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { cn } from "@/lib/cn";
import { formatClock, formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { onLinearRows, versionWho } from "./draft-words";
import type { WriteState } from "./draft-words";

// The task panel's Draft and On Linear groups for a refine task (refine-draft.md, "Properties
// panel"): how many versions, whose is the latest, and once applied, what was written to the
// ticket and where each write stands.

const tone: Record<WriteState, string> = { done: "text-green", pending: "text-muted", failed: "text-red" };
const stateKey = { done: "draft.done", pending: "draft.pending", failed: "draft.failed" } as const;

export const DraftProperties = ({ taskId, meId, readyStatusName, moveState, now }: {
  readonly taskId: TaskId;
  readonly meId: string | null;
  readonly readyStatusName: string | null;
  /** The ticket outbox's write that moves the ticket to ready, once "Mark ready" sent it. */
  readonly moveState: WriteState | null;
  readonly now: number;
}) => {
  const trpc = useTRPC();
  const draft = useQuery(trpc.drafts.get.queryOptions({ taskId, version: null }));
  const data = draft.data;
  if (data === undefined || data.draft === null) return null;
  const versions = data.versions;
  const latest = versions.at(-1);
  const newestAgent = versions.findLast((version) => version.source === "agent");
  const applied = versions.findLast((version) => version.appliedAt !== null);
  const readyAt = versions.findLast((version) => version.readyAt !== null)?.readyAt ?? null;
  const latestWho = latest === undefined ? null : versionWho(latest, meId);
  const rows = onLinearRows({
    appliedAt: applied?.appliedAt ?? null,
    written: data.written,
    images: data.draft.images,
    subTickets: data.draft.fields.subTickets.length,
    createdTicket: data.ticket === null,
    move: readyAt === null ? null : { state: moveState ?? "pending", status: readyStatusName ?? t("draft.readyStatus") },
    failed: data.applyFailed?.part ?? null,
  });
  return (
    <>
      <PropGroup title={t("draft.group")}>
        <PropRow label={t("draft.versions")}><span className="font-mono">{versions.length}</span></PropRow>
        {applied === undefined ? (
          <>
            {latest === undefined || latestWho === null ? null : (
              <PropRow label={t("draft.latest")}>
                <span className="truncate">
                  {latestWho.kind === "agent"
                    ? t("draft.latestAgent", { n: latest.version })
                    : latestWho.kind === "you"
                      ? t("draft.latestYou", { age: formatElapsed(latest.createdAt, now) })
                      : t("draft.latestMember", { name: latestWho.name, age: formatElapsed(latest.createdAt, now) })}
                </span>
              </PropRow>
            )}
            {newestAgent === undefined ? null : (
              <PropRow label={t("draft.fromAgent")}><span className="font-mono">{t("draft.versionShort", { n: newestAgent.version })}</span></PropRow>
            )}
          </>
        ) : (
          <>
            <PropRow label={t("draft.appliedRow")}>
              <span className="truncate">{t("draft.appliedValue", { n: applied.version, time: applied.appliedAt === null ? "" : formatClock(applied.appliedAt), name: applied.appliedBy?.name ?? t("taskPage.someone") })}</span>
            </PropRow>
            {readyAt === null ? null : <PropRow label={t("draft.readyRow")}><span className="font-mono">{formatClock(readyAt)}</span></PropRow>}
          </>
        )}
      </PropGroup>
      <PropGroup title={t("draft.onLinear")}>
        {rows.length === 0 ? (
          <p className="text-sm text-faint">{t("draft.nothingYet")}</p>
        ) : (
          <ul data-testid="draft-sync">
            {rows.map((row) => (
              <li key={row.id} className="flex min-h-[26px] items-center justify-between gap-3 text-ui" data-row={row.id} data-state={row.state}>
                <span className="truncate text-text">{row.label}</span>
                <span className={cn("shrink-0 text-sm", tone[row.state])}>{t(stateKey[row.state])}</span>
              </li>
            ))}
          </ul>
        )}
      </PropGroup>
    </>
  );
};
