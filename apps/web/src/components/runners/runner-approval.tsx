"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, CopyIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { AlertDialog as Dialog } from "radix-ui";
import { useState } from "react";
import type { ReactNode } from "react";

import { PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { NeedsYou } from "@/components/ui/needs-you";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { executorNote, fingerprintShort, joinedAt, ownLabels, systemText, versionWord } from "./runner-page-words";

// F-091 (ticket 31, runner-approval.md): a runner waiting to join a pool that requires approval.
// The admin checks the machine (host, system, executor, labels, version, the token it used, when it
// joined, its key's fingerprint, whether it's connected) and answers: Approve (no confirm: the panel
// is the check) or Reject (asks first). Shared by Needs you's panel and the runner's own page.

type Page = RouterOutputs["runners"]["get"];

const invalidateFleet = (queryClient: ReturnType<typeof useQueryClient>, trpc: ReturnType<typeof useTRPC>) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: trpc.runners.pathKey() }),
    queryClient.invalidateQueries({ queryKey: trpc.pools.pathKey() }),
    queryClient.invalidateQueries({ queryKey: trpc.notifications.pathKey() }),
  ]);

/** `SHA256:Xb4N…2kQe`, the whole one in a tooltip, and Copy. */
export const Fingerprint = ({ value }: { readonly value: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <span className="group/key flex min-w-0 items-center gap-2">
      <Tooltip content={value}>
        <span className="truncate font-mono" data-testid="key-fingerprint">{fingerprintShort(value)}</span>
      </Tooltip>
      <button
        type="button"
        aria-label={t("runner.page.copyKey")}
        className="inline-flex shrink-0 items-center gap-1 text-sm text-teal hover:underline xl:hidden xl:group-hover/key:inline-flex xl:group-focus-within/key:inline-flex"
        onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); }); }}
      >
        <CopyIcon aria-hidden className="size-[13px] stroke-[1.75]" />
        {copied ? t("runner.page.copied") : t("runner.page.copy")}
      </button>
    </span>
  );
};

/** The check: what the admin reads before answering (runner-approval.md, item 4). */
const Facts = ({ page, now }: { readonly page: Page | undefined; readonly now: number }) => {
  const v = (node: (page: Page) => ReactNode) => (page === undefined ? <Skeleton className="w-24" /> : node(page));
  return (
    <div className="mt-3">
      <PropRow label={t("runner.page.host")} labelWidth={100}>{v((p) => <span className="truncate font-mono">{p.name}</span>)}</PropRow>
      <PropRow label={t("runner.page.system")} labelWidth={100}>{v((p) => <span className="font-mono">{systemText(p.os)}</span>)}</PropRow>
      <PropRow label={t("runners.col.executor")} labelWidth={100}>
        {v((p) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono">{p.executor}</span>
            {executorNote(p.lines).map((note) => (note.chip ? <Chip key={note.text}>{note.text}</Chip> : <span key={note.text} className="text-sm text-muted">{note.text}</span>))}
          </span>
        ))}
      </PropRow>
      <PropRow label={t("runners.col.labels")} labelWidth={100}>
        {v((p) => {
          const own = ownLabels(p.labels);
          return own.length === 0 ? <span className="text-faint">{t("runner.page.none")}</span> : (
            <span className="flex flex-wrap gap-1.5">{own.map((label) => <Chip key={label} className="font-mono text-[12px] text-text">{label}</Chip>)}</span>
          );
        })}
      </PropRow>
      <PropRow label={t("runners.col.version")} labelWidth={100}>
        {v((p) => (
          <span className="flex items-baseline gap-2">
            <span className="font-mono">v{p.version}</span>
            <span className="text-sm text-faint">{versionWord(p.versionState)}</span>
          </span>
        ))}
      </PropRow>
      <PropRow label={t("runner.page.token")} labelWidth={100}>
        {v((p) =>
          p.joinToken === null ? <span className="text-faint">—</span> : (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate font-mono", p.joinToken.revoked && "text-faint line-through")}>{p.joinToken.label ?? t("runners.joinToken")}</span>
              <span className="shrink-0 text-sm text-faint">
                {p.joinToken.revoked ? t("runner.approval.revokedSince") : p.joinToken.createdBy?.name === null || p.joinToken.createdBy === null ? "" : t("runner.approval.by", { name: p.joinToken.createdBy.name })}
              </span>
            </span>
          ),
        )}
      </PropRow>
      <PropRow label={t("runner.page.joined")} labelWidth={100}>
        {v((p) => (
          <span className="flex items-baseline gap-2">
            <span className="font-mono">{joinedAt(p.createdAt)}</span>
            <span className="text-sm text-faint" suppressHydrationWarning>{t("runner.approval.ago", { age: formatAge(p.createdAt, now) })}</span>
          </span>
        ))}
      </PropRow>
      <PropRow label={t("runner.page.key")} labelWidth={100}>{v((p) => <Fingerprint value={p.keyFingerprint} />)}</PropRow>
      <PropRow label={t("runner.page.connection")} labelWidth={100}>
        {v((p) => (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={cn("inline-block size-[9px] rounded-full", p.connection === null ? "bg-faint" : "bg-green")} />
            {p.connection === null ? t("runner.approval.notConnected") : t("runner.approval.connected")}
          </span>
        ))}
      </PropRow>
    </div>
  );
};

/** Reject asks first: the runner is cut off and the token stays (runner-approval.md). */
const RejectConfirm = ({ name, pool, open, pending, error, onOpenChange, onReject }: {
  readonly name: string;
  readonly pool: string;
  readonly open: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReject: () => void;
}) => (
  <Dialog.Root open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
      <Dialog.Content data-testid="runner-confirm" className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none">
        <Dialog.Title className="text-[16.5px] font-semibold text-text">{t("runner.confirm.rejectTitle", { name })}</Dialog.Title>
        <Dialog.Description className="mt-1.5 text-sm text-muted">{t("runner.confirm.rejectBody", { pool })}</Dialog.Description>
        {error === null ? null : <p role="alert" className="mt-3 text-[12.5px] text-red">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Cancel className={buttonVariants()} disabled={pending}>{t("common.cancel")}</Dialog.Cancel>
          <button type="button" className={buttonVariants({ variant: "danger" })} disabled={pending} onClick={onReject}>
            {pending ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
            {t("runner.reject")}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

type Answered = { readonly kind: "approved"; readonly online: boolean } | { readonly kind: "rejected" };

/**
 * The approval block for one runner. `page` comes from the caller's `runners.get` (the runner's page
 * polls it); without it, the block reads it itself (Needs you's panel).
 */
export const RunnerApproval = ({ runnerId, organization, page: given, now }: { readonly runnerId: string; readonly organization: string; readonly page?: Page; readonly now: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const own = useQuery({ ...trpc.runners.get.queryOptions({ runnerId }), enabled: given === undefined, refetchInterval: 5_000 });
  const page = given ?? own.data;
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [confirm, setConfirm] = useState(false);
  const approve = useMutation(trpc.runners.approve.mutationOptions({ onSettled: () => invalidateFleet(queryClient, trpc) }));
  const reject = useMutation(trpc.runners.reject.mutationOptions({ onSettled: () => invalidateFleet(queryClient, trpc) }));
  const name = page?.name ?? "";
  const pool = page?.pool?.name ?? "";
  const pending = approve.isPending || reject.isPending;
  const failure = approve.error ?? (confirm ? null : reject.error);

  // Answered here, by another admin while open, or revoked elsewhere: the receipt, and the buttons go.
  const receipt = ((): string | null => {
    if (answered?.kind === "approved") return answered.online ? t("runner.approval.approved", { name }) : t("runner.approval.approvedOffline", { name });
    if (answered?.kind === "rejected") return t("runner.approval.rejected", { name });
    if (page === undefined || page.awaitingApproval) return null;
    if (page.state === "revoked") return t("runner.approval.revokedElsewhere", { name });
    return page.approvedBy === null ? t("runner.approval.answered") : t("runner.approval.answeredBy", { name: page.approvedBy.name ?? t("common.unknown"), age: formatAge(page.approvedAt ?? now, now) });
  })();

  return (
    <NeedsYou
      title={t("runner.approval.title")}
      data-testid="runner-approval"
      {...(receipt === null
        ? {
            actions: (
              <>
                <Button disabled={pending || page === undefined} onClick={() => { reject.reset(); setConfirm(true); }}>
                  {reject.isPending ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
                  {reject.isPending ? t("runner.approval.rejecting") : t("runner.reject")}
                </Button>
                <Button
                  variant="amber"
                  disabled={pending || page === undefined}
                  onClick={() => {
                    approve.mutate({ runnerId }, { onSuccess: () => { setAnswered({ kind: "approved", online: page?.connection !== null && page?.connection !== undefined }); } });
                  }}
                >
                  {approve.isPending ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
                  {approve.isPending ? t("runner.approval.approving") : t("runner.approve")}
                </Button>
              </>
            ),
            footer: (
              <>
                {failure === null ? null : (
                  <span role="alert" className="mb-2 flex items-center gap-1.5 text-[12.5px] text-red">
                    <CircleAlertIcon aria-hidden className="size-[13px]" /> {errorText(failure)}
                  </span>
                )}
                {t("runner.approval.footnote", { organization })}
              </>
            ),
          }
        : {})}
    >
      <div className="mt-1.5 flex items-center gap-2.5">
        <span aria-hidden className="inline-block size-[9px] shrink-0 rounded-full border-[1.5px] border-muted" />
        <Link href={`/organization/runners/${runnerId}`} className="truncate font-mono text-[15px] font-semibold text-text hover:underline">{name}</Link>
        <span className="text-[13px] text-faint">{t("runners.state.joining")}</span>
      </div>
      {receipt === null ? (
        <>
          <p className="mt-1.5 text-sm text-muted">
            {t("runner.approval.wantsBefore")}
            {page?.pool === null || page?.pool === undefined ? pool : <Link href={`/organization/runners/pools/${page.pool.id}`} className="text-text hover:underline">{pool}</Link>}
            {t("runner.approval.wantsAfter")}
          </p>
          <Facts page={page} now={now} />
        </>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-muted" data-testid="approval-receipt">
          {receipt}{" "}
          {answered?.kind === "approved" || (answered === null && page?.state !== "revoked") ? (
            <Link href={`/organization/runners/${runnerId}`} className="text-teal hover:underline">{t("runner.approval.openRunner")}</Link>
          ) : null}
        </p>
      )}
      <RejectConfirm
        name={name}
        pool={pool}
        open={confirm}
        pending={reject.isPending}
        error={reject.error === null ? null : errorText(reject.error)}
        onOpenChange={(next) => { setConfirm(next); if (!next) reject.reset(); }}
        onReject={() => { reject.mutate({ runnerId }, { onSuccess: () => { setConfirm(false); setAnswered({ kind: "rejected" }); } }); }}
      />
    </NeedsYou>
  );
};
