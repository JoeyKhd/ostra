"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BanIcon, CirclePauseIcon, CirclePlayIcon, EllipsisIcon, LoaderCircleIcon } from "lucide-react";
import { AlertDialog as Dialog } from "radix-ui";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { RunnerState } from "./runner-words";

// F-092, F-091, F-014 (ticket 31, runner.md): a runner's actions and their confirms. Drain lets its
// tasks finish and takes no new one; Resume lifts it; Revoke cuts it off at once; Approve and Reject
// answer a runner waiting to join. The same dialogs serve the runner's page and the rows' menu.

export type RunnerAction = "drain" | "resume" | "revoke" | "reject";

/** What the actions and their confirms read of a runner. */
export type ActionRunner = {
  readonly id: string;
  readonly name: string;
  readonly kind: "pool" | "personal";
  readonly state: RunnerState;
  /** Boxes holding a slot on it now: the tasks a drain lets finish and a revoke stops. */
  readonly busy: number;
  /** The protocol minor it speaks; below 4 it gets no `resume` command. */
  readonly minor: number | null;
  readonly awaitingApproval: boolean;
  readonly poolName: string | null;
};

/** Which actions a runner offers (runner.md, "The actions"): by its state, and only Revoke on a member's own. */
export const runnerActions = (runner: Pick<ActionRunner, "state" | "awaitingApproval">, admin: boolean): readonly ("approve" | RunnerAction)[] => {
  if (!admin) return runner.state === "revoked" ? [] : ["revoke"];
  switch (runner.state) {
    case "joining":
      return runner.awaitingApproval ? ["reject", "approve"] : ["revoke"];
    case "online":
    case "offline":
      return ["drain", "revoke"];
    case "draining":
      return ["resume", "revoke"];
    case "revoked":
      return [];
    default:
      return runner.state satisfies never;
  }
};

/** A confirm's title and body. */
export const confirmWords = (action: RunnerAction, runner: ActionRunner, own: boolean): { readonly title: string; readonly body: string; readonly button: string } => {
  const name = runner.name;
  switch (action) {
    case "drain":
      return {
        title: t("runner.confirm.drainTitle", { name }),
        body: runner.busy === 0 ? t("runner.confirm.drainBodyIdle") : runner.busy === 1 ? t("runner.confirm.drainBodyOne") : t("runner.confirm.drainBody", { n: runner.busy }),
        button: t("runner.drain"),
      };
    case "resume":
      return {
        title: t("runner.confirm.resumeTitle", { name }),
        body: runner.minor !== null && runner.minor < 4 ? t("runner.confirm.resumeBodyOld") : t("runner.confirm.resumeBody"),
        button: t("runner.resume"),
      };
    case "revoke":
      return {
        title: t("runner.confirm.revokeTitle", { name }),
        body: own
          ? t("runner.confirm.revokeBodyOwn")
          : runner.busy === 0
            ? t("runner.confirm.revokeBodyIdle")
            : runner.busy === 1
              ? t("runner.confirm.revokeBodyOne")
              : t("runner.confirm.revokeBody", { n: runner.busy }),
        button: t("runner.revoke"),
      };
    case "reject":
      return { title: t("runner.confirm.rejectTitle", { name }), body: t("runner.confirm.rejectBody", { pool: runner.poolName ?? "" }), button: t("runner.reject") };
    default:
      return action satisfies never;
  }
};

/** Refreshes every view of the fleet after an action. */
const useFleetRefresh = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.runners.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.pools.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.notifications.pathKey() }),
    ]);
};

/** The mutation behind each confirmed action. */
const useRunnerMutations = () => {
  const trpc = useTRPC();
  const refresh = useFleetRefresh();
  return {
    drain: useMutation(trpc.runners.drain.mutationOptions({ onSuccess: refresh })),
    resume: useMutation(trpc.runners.resume.mutationOptions({ onSuccess: refresh })),
    revoke: useMutation(trpc.runners.revoke.mutationOptions({ onSuccess: refresh })),
    reject: useMutation(trpc.runners.reject.mutationOptions({ onSuccess: refresh })),
  };
};

/** One confirm, open while `action` is set; it closes itself on success and shows the failure inside. */
export const RunnerConfirm = ({ runner, action, own, onClose }: { readonly runner: ActionRunner; readonly action: RunnerAction | null; readonly own: boolean; readonly onClose: () => void }) => {
  const mutations = useRunnerMutations();
  const current = action === null ? null : mutations[action];
  const words = action === null ? null : confirmWords(action, runner, own);
  const busy = current?.isPending === true;
  return (
    <Dialog.Root open={action !== null} onOpenChange={(open) => { if (!open && !busy) { current?.reset(); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content data-testid="runner-confirm" className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none">
          <Dialog.Title className="text-[16.5px] font-semibold text-text">{words?.title}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-sm text-muted">{words?.body}</Dialog.Description>
          {current?.error === null || current === null ? null : <p role="alert" className="mt-3 text-[12.5px] text-red">{errorText(current.error)}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Cancel className={buttonVariants()} disabled={busy}>{t("common.cancel")}</Dialog.Cancel>
            <button
              type="button"
              disabled={busy}
              className={buttonVariants({ variant: action === "drain" || action === "resume" ? "outline" : "danger" })}
              onClick={() => {
                if (action === null || current === null) return;
                current.mutate({ runnerId: runner.id }, { onSuccess: () => { current.reset(); onClose(); } });
              }}
            >
              {busy ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
              {words?.button}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** The runner page's top-bar buttons (runner.md), with their confirms. Approve and Reject live in `RunnerApproval`. */
export const RunnerButtons = ({ runner, admin, own }: { readonly runner: ActionRunner; readonly admin: boolean; readonly own: boolean }) => {
  const [action, setAction] = useState<RunnerAction | null>(null);
  const actions = runnerActions(runner, admin).filter((one): one is "drain" | "resume" | "revoke" => one === "drain" || one === "resume" || one === "revoke");
  if (actions.length === 0) return null;
  return (
    <>
      {/* Phone (F-075): the actions go into a `…` menu. */}
      <div className="hidden items-center gap-2 sm:flex">
        {actions.map((one) => (
          <Button key={one} onClick={() => { setAction(one); }} className={cn(one === "revoke" && "text-red")}>
            {one === "drain" ? <CirclePauseIcon aria-hidden className="stroke-[1.75]" /> : one === "resume" ? <CirclePlayIcon aria-hidden className="stroke-[1.75]" /> : <BanIcon aria-hidden className="stroke-[1.75]" />}
            {one === "drain" ? t("runner.drain") : one === "resume" ? t("runner.resume") : t("runner.revoke")}
          </Button>
        ))}
      </div>
      <div className="sm:hidden">
        <RunnerMenuItems actions={actions} onPick={setAction} label={t("runner.actions")} />
      </div>
      <RunnerConfirm runner={runner} action={action} own={own} onClose={() => { setAction(null); }} />
    </>
  );
};

const RunnerMenuItems = ({ actions, onPick, label, onApprove }: {
  readonly actions: readonly ("approve" | RunnerAction)[];
  readonly onPick: (action: RunnerAction) => void;
  readonly label: string;
  readonly onApprove?: () => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger className="grid size-[26px] place-items-center rounded-sm text-faint hover:bg-sel hover:text-text" aria-label={label}>
      <EllipsisIcon aria-hidden className="size-[15px] stroke-[1.75]" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-[150px]">
      {actions.map((one) => (
        <DropdownMenuItem
          key={one}
          className={cn((one === "revoke" || one === "reject") && "text-red")}
          onSelect={() => { if (one === "approve") onApprove?.(); else onPick(one); }}
        >
          {one === "approve" ? t("runner.approve") : one === "drain" ? t("runner.drain") : one === "resume" ? t("runner.resume") : one === "reject" ? t("runner.reject") : t("runner.revoke")}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

/** A runner row's `···` menu (pool.md, "Runners"): Drain or Resume, Revoke; Approve and Reject while it waits. */
export const RunnerRowMenu = ({ runner }: { readonly runner: ActionRunner }) => {
  const trpc = useTRPC();
  const refresh = useFleetRefresh();
  const approve = useMutation(trpc.runners.approve.mutationOptions({ onSuccess: refresh }));
  const [action, setAction] = useState<RunnerAction | null>(null);
  const actions = runnerActions(runner, true);
  if (actions.length === 0) return null;
  return (
    <>
      <RunnerMenuItems actions={actions} onPick={setAction} label={t("runner.actionsFor", { name: runner.name })} onApprove={() => { approve.mutate({ runnerId: runner.id }); }} />
      <RunnerConfirm runner={runner} action={action} own={false} onClose={() => { setAction(null); }} />
    </>
  );
};
