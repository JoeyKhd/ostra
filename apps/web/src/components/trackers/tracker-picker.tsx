"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useRef } from "react";
import type { KeyboardEvent } from "react";

import { KeyCap } from "@/components/shell/actions/kbd-sequence";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { TrackerMark, trackerMarkAt, trackerName } from "./tracker-mark";
import { capabilityChips, comingSoonKinds, pickerKinds } from "./tracker-words";
import type { PickerKinds, TrackerKind } from "./tracker-words";

// "Connect a tracker" (F-152, F-008; trackers.md, "Connect a tracker" and "No connection yet"): the
// kinds as tiles, Linear and Jira to pick, each with its adapter's declared capabilities as chips;
// Trello and Notion shown with their marks and one quiet `Coming soon`, disabled, not focusable, no
// link and no form (choice 1, F-152/c8). Continue makes a pending connection of the kind
// (`trackers.create`) and opens its page at step 1. The same tiles sit in a dialog over the list
// (a bottom sheet on a phone, the tiles stacked) and on the page itself while there's no connection.

/**
 * `Continue with <kind>`: a new pending connection of the kind, then its page. Linear's page opens
 * at step 1 (`?new=1`, today's Linear connect flow, its button making the app from the pre-filled
 * link); Jira's at its first step.
 */
export const useConnectTracker = () => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.trackers.create.mutationOptions({
      onSuccess: async (made) => {
        await queryClient.invalidateQueries({ queryKey: trpc.trackers.list.queryKey() });
        router.push(`/organization/trackers/${made.connectionId}?new=1`);
      },
    }),
  );
  return {
    run: (kind: TrackerKind) => { create.mutate({ kind }); },
    pending: create.isPending || create.isSuccess,
    error: errorText(create.error),
  };
};

/** The two kinds as tiles, a radio group, and the Coming-soon row under them. */
export const KindTiles = ({
  kinds,
  picked,
  onPick,
  onContinue,
  stacked = false,
}: {
  readonly kinds: PickerKinds;
  readonly picked: TrackerKind | null;
  readonly onPick: (kind: TrackerKind) => void;
  /** `Enter` on a tile picks it and continues. */
  readonly onContinue: (kind: TrackerKind) => void;
  /** One column (the phone's sheet). */
  readonly stacked?: boolean;
}) => {
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  // `←`/`→` (and `↑`/`↓`) move between Linear and Jira and pick; `Space` picks; `Enter` continues.
  // The Coming-soon tiles are skipped: they aren't buttons.
  const onKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const kind = pickerKinds[index];
    if (kind === undefined) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onPick(kind);
      onContinue(kind);
      return;
    }
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + pickerKinds.length) % pickerKinds.length;
    const nextKind = pickerKinds[next];
    if (nextKind === undefined) return;
    onPick(nextKind);
    tiles.current[next]?.focus();
  };
  return (
    <div>
      <div role="radiogroup" aria-label={t("trackers.picker.kinds")} className={cn("grid gap-3", stacked ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
        {pickerKinds.map((kind, index) => {
          const on = picked === kind;
          return (
            <button
              key={kind}
              ref={(node) => { tiles.current[index] = node; }}
              type="button"
              role="radio"
              aria-checked={on}
              data-kind={kind}
              onClick={() => { onPick(kind); }}
              onKeyDown={onKey(index)}
              className={cn(
                "relative flex flex-col gap-2.5 rounded-[10px] border bg-surface px-4 pb-3.5 pt-4 text-left",
                on ? "border-text shadow-[0_0_0_1px_var(--text)]" : "border-line-2 hover:border-control-line",
              )}
            >
              <span aria-hidden className={cn("absolute right-3.5 top-3.5 size-4 rounded-full border", on ? "border-[5px] border-text" : "border-control-line")} />
              <span className="flex items-center gap-3 pr-6">
                <TrackerMark kind={kind} size={trackerMarkAt.picker.size} label={false} />
                <span className="min-w-0">
                  <span className="block text-[16px] font-semibold leading-tight text-text">{trackerName[kind]}</span>
                  <span className="mt-px block text-[12.5px] text-faint">{t(`trackers.picker.${kind}.sub`)}</span>
                </span>
              </span>
              <span className="text-[13.5px] leading-normal text-muted">{t(`trackers.picker.${kind}.body`)}</span>
              <span className="flex flex-wrap gap-1.5">
                {capabilityChips(kind, kinds[kind]).map((chip) => (
                  <Chip key={chip} className="rounded-[5px] px-[7px] text-xs font-medium">{chip}</Chip>
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div role="group" aria-label={t("trackers.picker.soon")} className={cn("mt-2.5 grid gap-3", stacked ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
        {comingSoonKinds.map((kind) => (
          <div
            key={kind}
            aria-disabled="true"
            data-kind={kind}
            data-coming-soon
            className="flex h-11 items-center gap-2.5 rounded-[10px] border border-line px-3.5"
          >
            <TrackerMark kind={kind} size={trackerMarkAt.pickerComingSoon.size} label={false} className="opacity-60" />
            <span className="text-ui font-medium text-faint">{trackerName[kind]}</span>
            <span className="ml-auto inline-flex h-[18px] items-center rounded-[4px] border border-line-2 px-1.5 text-[11px] font-medium text-faint">{t("trackers.picker.soon")}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** The Continue button's words: the picked kind's name, or `Continue` until one is picked. */
export const continueWords = (picked: TrackerKind | null): string =>
  picked === null ? t("trackers.empty.continue") : t("trackers.picker.continue", { kind: trackerName[picked] });

/**
 * The picker as a dialog (600px, 150px from the top), from the top bar's `Connect a tracker` or
 * `c`; below 640px a bottom sheet with the tiles stacked. `Esc` closes it.
 */
export const TrackerPickerDialog = ({
  open,
  onOpenChange,
  kinds,
  picked,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly kinds: PickerKinds;
  readonly picked: TrackerKind | null;
  readonly onPick: (kind: TrackerKind | null) => void;
}) => {
  const connect = useConnectTracker();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onPick(null);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          data-testid="tracker-picker"
          className={cn(
            "fixed z-50 border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none",
            "inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-[10px] px-4 pb-4 pt-5",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[150px] sm:max-h-[calc(100dvh-180px)] sm:w-[600px] sm:-translate-x-1/2 sm:rounded-[10px] sm:px-[22px] sm:pb-[18px] sm:pt-[22px]",
          )}
        >
          <Dialog.Title className="text-[16px] font-semibold leading-[1.35] text-text">{t("trackers.connect")}</Dialog.Title>
          <Dialog.Description className="mt-1 text-ui text-muted">{t("trackers.picker.lede")}</Dialog.Description>
          <div className="mt-[18px]">
            <KindTiles kinds={kinds} picked={picked} onPick={onPick} onContinue={connect.run} />
          </div>
          {connect.error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{connect.error}</p>}
          <div className="mt-[18px] flex items-center justify-end gap-2">
            <span className="mr-auto hidden items-center gap-1.5 text-sm text-faint sm:inline-flex" aria-hidden>
              <KeyCap className="bg-surface">←</KeyCap>
              <KeyCap className="bg-surface">→</KeyCap>
              {t("trackers.picker.toPick")}
            </span>
            <Dialog.Close asChild>
              <Button>{t("common.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              disabled={picked === null || connect.pending}
              onClick={() => { if (picked !== null) connect.run(picked); }}
            >
              {continueWords(picked)}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** No connection yet (`trackers-empty`): the tiles on the page itself, `Continue` and its hint. */
export const EmptyPicker = ({ kinds, picked, onPick }: { readonly kinds: PickerKinds; readonly picked: TrackerKind | null; readonly onPick: (kind: TrackerKind) => void }) => {
  const connect = useConnectTracker();
  return (
    <section className="mt-[26px] border-t border-line pt-[22px]" data-testid="trackers-empty">
      <h2 className="text-[15px] font-semibold text-text">{t("trackers.empty.title")}</h2>
      <p className="mt-1 max-w-[620px] text-ui text-muted">{t("trackers.empty.lede")}</p>
      <div className="mt-4">
        <KindTiles kinds={kinds} picked={picked} onPick={onPick} onContinue={connect.run} />
      </div>
      {connect.error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{connect.error}</p>}
      <div className="mt-[18px] flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={picked === null || connect.pending} onClick={() => { if (picked !== null) connect.run(picked); }}>
          {continueWords(picked)}
        </Button>
        <span className="text-[12.5px] text-faint">{t("trackers.empty.hint")}</span>
      </div>
    </section>
  );
};
