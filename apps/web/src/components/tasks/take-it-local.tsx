"use client";

import { CircleAlertIcon, InfoIcon, SquareTerminalIcon } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// Take it local (take-it-local.md, F-028, F-103, ADR 0051): the task header's popover with the
// `ostra checkout` line, the `ostra login` hint while the member has no CLI session, and the plain
// git commands per repo. A reference card: nothing in it changes the task.

/** What ticket 39's `tasks.local` returns. */
export type LocalView = {
  /** `ostra checkout OST-142`, or the task's ID for a prompt task. */
  readonly checkoutLine: string;
  /** `… ostra login --server <public URL>`, for a machine that has never signed in. */
  readonly loginLine: string;
  readonly hasCliSession: boolean;
  readonly repos: readonly {
    readonly fullName: string;
    readonly branch: string;
    /** The PR's number when it merged and the task hasn't reopened on a fresh branch (F-066). */
    readonly mergedPr: number | null;
  }[];
};

export type LocalLoad = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly local: LocalView };

/** The plain git lines for one repo: fetch the branch, then switch to it. */
export const gitLines = (branch: string): string => `git fetch origin ${branch}\ngit switch ${branch}`;

const Label = ({ children }: { readonly children: string }) => <div className="mb-1.5 text-[11px] font-medium text-faint">{children}</div>;

/** A read-only one-line command with its copy button: 32px, inset in `--bg`. */
const CommandLine = ({ text, loading }: { readonly text: string; readonly loading: boolean }) => {
  const id = useId();
  return (
    <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-line-2 bg-bg pl-3 pr-1.5">
      {loading ? (
        <Skeleton className="h-3 flex-1" />
      ) : (
        <code id={id} className="min-w-0 flex-1 select-text truncate font-mono text-[12.5px] text-text" title={text}>
          {text}
        </code>
      )}
      <CopyButton text={text} selectId={id} disabled={loading} />
    </div>
  );
};

const GitBlock = ({ repo }: { readonly repo: LocalView["repos"][number] }) => {
  const id = useId();
  const lines = gitLines(repo.branch);
  return (
    <div data-repo={repo.fullName}>
      <div className="mb-1.5 truncate font-mono text-xs text-muted">{repo.fullName}</div>
      <div className="relative rounded-md border border-line-2 bg-bg">
        <pre id={id} className="overflow-x-auto whitespace-pre py-2 pl-3 pr-10 font-mono text-xs leading-[1.7] text-text">
          {lines}
        </pre>
        <CopyButton text={lines} selectId={id} className="absolute right-1.5 top-1.5" />
      </div>
      {repo.mergedPr === null ? null : <p className="mt-1.5 text-xs text-faint">{t("takeLocal.merged", { n: repo.mergedPr })}</p>}
    </div>
  );
};

/** `First time on this machine? Run ostra login, then …` with the command in mono. */
const FirstTime = () => {
  const [before = "", after = ""] = t("takeLocal.firstTime", { command: "\u0000" }).split("\u0000");
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
      <InfoIcon aria-hidden className="mt-px size-[13px] shrink-0 stroke-[1.75] text-faint" />
      <span>
        {before}
        <code className="font-mono text-text">ostra login</code>
        {after}
      </span>
    </p>
  );
};

/** The commands a member runs to take the task's branches local: the popover's, the phone sheet's and `s6.md`'s `…` menu. */
export const TakeItLocalCard = ({ load }: { readonly load: LocalLoad }) => {
  const loading = load.kind === "loading";
  const local = load.kind === "ready" ? load.local : null;
  return (
    <div className="text-left">
      <h2 className="text-ui font-semibold text-text">{t("takeLocal.title")}</h2>
      <p className="mt-1 text-[12.5px] leading-normal text-muted">{t("takeLocal.lede")}</p>
      {load.kind === "error" ? (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12.5px] text-red">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
          {load.message}
        </p>
      ) : (
        <>
          <div className="mt-3.5">
            <Label>{t("takeLocal.cli")}</Label>
            <CommandLine text={local?.checkoutLine ?? ""} loading={loading} />
            {local !== null && !local.hasCliSession ? (
              <>
                <FirstTime />
                <div className="mt-1.5">
                  <CommandLine text={local.loginLine} loading={false} />
                </div>
              </>
            ) : null}
          </div>
          <hr className="my-3.5 border-line" />
          <Label>{local !== null && local.repos.length === 1 ? t("takeLocal.gitOne") : t("takeLocal.git")}</Label>
          {local === null ? (
            <Skeleton className="h-[52px] w-full rounded-md" />
          ) : (
            <div className="flex flex-col gap-3">
              {local.repos.map((repo) => (
                <GitBlock key={repo.fullName} repo={repo} />
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-faint">{t("takeLocal.reopen")}</p>
        </>
      )}
    </div>
  );
};

const PHONE = "(max-width: 639px)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", notify);
  return () => {
    query.removeEventListener("change", notify);
  };
};

/** Whether the window is phone width (F-075), for a popover that becomes a bottom sheet. */
export const usePhone = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

export type TakeItLocalProps = {
  /** Whether any repo has a branch on the code host: otherwise the button is disabled. */
  readonly pushed: boolean;
  readonly load: LocalLoad;
  /** Called when it opens, so `tasks.local` loads on the first open only. */
  readonly onOpen: () => void;
};

/** The top bar's `Take it local` button and its popover (a bottom sheet on a phone). */
export const TakeItLocal = ({ pushed, load, onOpen }: TakeItLocalProps) => {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  const change = (next: boolean) => {
    setOpen(next);
    if (next) onOpen();
  };
  const button = (extra: ReactNode = null) => (
    <Button
      variant="outline"
      size="sm"
      aria-label={t("takeLocal.button")}
      aria-expanded={open}
      disabled={!pushed}
      data-action="take-it-local"
      className={cn("h-7 rounded-md text-[12.5px] aria-expanded:bg-sel", !pushed && "pointer-events-none")}
      onClick={phone ? () => { change(!open); } : undefined}
    >
      <SquareTerminalIcon aria-hidden />
      <span className="hidden sm:inline">{t("takeLocal.button")}</span>
      {extra}
    </Button>
  );
  if (!pushed) {
    return (
      <Tooltip content={t("takeLocal.nothingPushed")}>
        <span tabIndex={0} className="inline-flex rounded-md">
          {button()}
        </span>
      </Tooltip>
    );
  }
  if (phone) {
    return (
      <>
        {button()}
        <Sheet open={open} onOpenChange={change}>
          <SheetContent side="bottom" title={t("takeLocal.title")} className="p-4 pb-6">
            <TakeItLocalCard load={load} />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{button()}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="max-h-none w-[480px] rounded-[10px] bg-surface p-4">
        <TakeItLocalCard load={load} />
      </PopoverContent>
    </Popover>
  );
};
