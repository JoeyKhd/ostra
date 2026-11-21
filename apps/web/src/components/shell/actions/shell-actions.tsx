"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { SearchPalette } from "@/components/search-palette";
import type { PaletteStart } from "@/components/search-palette";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { useShellState } from "../shell-state";
import { ShortcutSheet } from "../shortcut-sheet";
import { useSystemScheme, useTheme } from "../theme-provider";

import { KeyCap } from "./kbd-sequence";
import type { PaletteStep } from "./palette-step";
import type { PaletteActionId, PaletteContext } from "./registry";
import { useActionScope } from "./use-scope";
import type { TaskScope } from "./use-scope";
import { useShortcuts } from "./use-shortcuts";

// The shell's actions (F-081, tickets 13 and 16): the palette, the `?` sheet, the one key listener,
// Stop's confirmation, and one polite live region that is also the toast, which says what an action
// did and announces a new needs-you item. Every action runs through `run`, from a key or a palette row.

type ShellActionsValue = {
  readonly openPalette: (step: PaletteStep | null) => void;
  readonly openSheet: () => void;
  readonly announce: (text: string) => void;
};

const ShellActionsContext = createContext<ShellActionsValue>({ openPalette: () => undefined, openSheet: () => undefined, announce: () => undefined });

export const useShellActions = (): ShellActionsValue => useContext(ShellActionsContext);

/** How long the toast stays. */
const TOAST_MS = 5_000;

/** The project a page belongs to, from its address, for `g` then `t`. */
const projectOfPath = (path: string): string | null => /^\/projects\/([^/]+)/.exec(path)?.[1] ?? null;

export const ShellActions = ({ me, children }: { readonly me: RouterOutputs["me"]["get"]; readonly children: ReactNode }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const path = usePathname();
  const queryClient = useQueryClient();
  const scope = useActionScope();
  const shell = useShellState();
  const role = me.organization?.role ?? "member";
  const context: PaletteContext = useMemo(() => ({ role, scopes: scope.scopes }), [role, scope.scopes]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [start, setStart] = useState<PaletteStart>({ step: null });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [stopping, setStopping] = useState<TaskScope | null>(null);
  const [toast, setToast] = useState<{ readonly id: number; readonly text: string } | null>(null);
  // The theme on screen: the member's, or the system's when they follow it. The switch goes through
  // the one ThemeProvider (F-082), so Account's Appearance and the member menu show it too.
  const { theme, choose } = useTheme();
  const system = useSystemScheme();
  const shownTheme: "dark" | "light" = theme === "system" ? (system ?? "dark") : theme;

  const announce = useCallback((text: string) => { setToast({ id: Date.now(), text }); }, []);
  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => { setToast(null); }, TOAST_MS);
    return () => { clearTimeout(timer); };
  }, [toast]);

  const settle = { onSettled: () => queryClient.invalidateQueries() };
  const approve = useMutation(trpc.approvals.answer.mutationOptions(settle));
  const takeOver = useMutation(trpc.tasks.takeOver.mutationOptions(settle));
  const stop = useMutation(trpc.tasks.stop.mutationOptions(settle));
  const refused = (error: { readonly message: string; readonly data?: { readonly code?: string } | null | undefined }) => {
    announce(error.data?.code === "CONFLICT" ? t("palette.step.answeredFirst") : (errorText(error) ?? t("errors.unknown")));
  };

  // Ticket 16: a dialog opened by a key or by code has no trigger of its own, so the focus it had
  // before is remembered here and given back when it closes. One opened from another dialog (the
  // palette's `?`) gives it back to what had it before the first.
  const returnTo = useRef<HTMLElement | null>(null);
  const remember = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.closest("[role='dialog'], [role='alertdialog']") === null) returnTo.current = active;
  }, []);
  const giveFocusBack = useCallback((event: Event) => {
    const target = returnTo.current;
    if (target?.isConnected !== true) return;
    event.preventDefault();
    target.focus();
  }, []);
  const openPalette = useCallback((step: PaletteStep | null) => {
    remember();
    setStart({ step });
    setPaletteOpen(true);
  }, [remember]);
  const openSheet = useCallback(() => {
    remember();
    setSheetOpen(true);
  }, [remember]);

  const runStop = (task: TaskScope) => {
    stop.mutate({ taskId: task.taskId }, { onSuccess: () => { setStopping(null); announce(t("palette.toast.stopped", { key: task.key })); }, onError: refused });
  };

  /** Runs one action of the registry, from a key or from a palette row (which needs no second step). */
  const run = (id: PaletteActionId, from: "key" | "palette") => {
    const task = scope.task;
    const item = scope.item;
    switch (id) {
      case "go-needs-you":
        router.push("/needs-you");
        return;
      case "go-home":
        router.push("/");
        return;
      case "go-tasks": {
        const project = task?.projectId ?? projectOfPath(path);
        router.push(project === null ? "/search" : `/projects/${project}`);
        return;
      }
      case "go-projects":
        router.push(shell.spaceHref("projects"));
        return;
      case "go-organization":
        router.push(shell.spaceHref("organization"));
        return;
      case "toggle-sidebar":
        shell.toggle();
        return;
      case "search":
        openPalette(null);
        return;
      case "shortcut-sheet":
        openSheet();
        return;
      case "new-task":
        router.push("/tasks/new");
        return;
      case "new-project":
        router.push("/projects/new");
        return;
      case "toggle-theme":
        choose(shownTheme === "dark" ? "light" : "dark");
        return;
      case "approve":
        if (item?.kind !== "approval") return;
        approve.mutate({ approvalId: item.approvalId, decision: "allow_once" }, { onSuccess: () => { announce(t("palette.toast.approved", { key: item.key })); }, onError: refused });
        return;
      case "deny":
        if (item?.kind === "approval") item.deny();
        return;
      case "answer":
        if (item?.kind === "question") item.reply();
        return;
      case "take-over":
        if (task?.canTakeOver !== true) return;
        takeOver.mutate({ taskId: task.taskId }, { onSuccess: () => { announce(t("palette.toast.tookOver", { key: task.key })); }, onError: refused });
        return;
      case "reopen":
        if (task?.canReopen === true) openPalette({ kind: "reopen-message", task: { taskId: task.taskId, key: task.key, title: task.title } });
        return;
      case "stop":
        if (task?.canStop !== true) return;
        // The bare key asks first; from the palette the row itself is the confirmation.
        if (from === "key") {
          remember();
          setStopping(task);
        }
        else runStop(task);
        return;
      case "steer":
        task?.focusComposer();
        return;
      case "toggle-side-pane":
        task?.preview?.toggle();
        return;
      case "expand-preview":
        task?.preview?.expand();
        return;
      default:
        id satisfies never;
    }
  };

  const { pending } = useShortcuts({ context, fire: (action) => { run(action.id, "key"); } });

  // A new needs-you item is announced (ticket 16): the rail's count, kept fresh, rising.
  const count = shell.needsYou;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (count === null) return;
    if (seen.current !== null && count > seen.current) announce(count === 1 ? t("palette.toast.newItemOne") : t("palette.toast.newItemOther", { n: count }));
    seen.current = count;
  }, [count, announce]);

  const value = useMemo(() => ({ openPalette, openSheet, announce }), [openPalette, openSheet, announce]);
  return (
    <ShellActionsContext.Provider value={value}>
      {children}
      <SearchPalette
        open={paletteOpen}
        onOpenChange={(open) => {
          if (open) remember();
          setPaletteOpen(open);
        }}
        onCloseAutoFocus={giveFocusBack}
        admin={role === "admin"}
        start={start}
        actions={{ scope, context, shownTheme, run: (id) => { run(id, "palette"); }, announce, openSheet }}
      />
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} onOpenPalette={() => { openPalette(null); }} onCloseAutoFocus={giveFocusBack} />
      <AlertDialog open={stopping !== null} onOpenChange={(open) => { if (!open) setStopping(null); }}>
        {stopping === null ? null : (
          <AlertDialogContent
            title={t("palette.stop.title", { key: stopping.key })}
            body={t("palette.stop.body")}
            cancel={t("common.cancel")}
            action={t("palette.stop.action")}
            onAction={() => { runStop(stopping); }}
            pending={{ busy: stop.isPending, label: t("palette.stop.busy"), error: stop.error === null ? null : errorText(stop.error) }}
            onCloseAutoFocus={giveFocusBack}
          />
        )}
      </AlertDialog>
      {/* One polite live region: what an action did, and a new needs-you item. */}
      <div role="status" aria-live="polite" data-testid="shell-toast" className="pointer-events-none fixed bottom-4 right-4 z-50 max-w-[min(420px,calc(100vw-32px))]">
        {toast === null ? null : (
          <p key={toast.id} className="rounded-lg border border-line-2 bg-raise px-3.5 py-2.5 text-ui text-text shadow-(--shadow-pop)">{toast.text}</p>
        )}
      </div>
      {pending === null ? null : (
        <div aria-hidden data-testid="shortcut-pending" className="fixed bottom-3 left-3 z-50 rounded-md border border-line-2 bg-surface p-1">
          <KeyCap>{pending}</KeyCap>
        </div>
      )}
    </ShellActionsContext.Provider>
  );
};
