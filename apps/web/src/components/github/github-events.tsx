"use client";

import { ArrowRightIcon, ArrowUpRightIcon, ClockIcon, InfoIcon, LockIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef } from "react";
import type { ReactNode } from "react";

import { PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { tNodes } from "@/lib/message-nodes";
import { plural, t } from "@/lib/messages";

import type { GitHubApp } from "./github-orgs";
import { appSettingsLinks, eventsState, eventsToTick } from "./github-orgs-words";

// F-006/c4 (app-targets/m10-gaps/github-events.md): an App the manifest flow made while ostra had no
// public address has no webhook and takes no events. GitHub has no call that adds them, so the App's
// panel says which state it's in (the Events row), and once the address is public `Turn on` asks
// core for the App's webhook address and a fresh secret, shown once, with the events to tick in the
// App's settings on GitHub. Leaving that result before `Done` asks first (`@/lib/leave-guard`).

/** Turn on's result, or `Which ones` reopening its events list without a new secret. */
export type ShownOnce =
  | {
      readonly kind: "secret";
      readonly connectionId: GitHubApp["connectionId"];
      /** A secret replaced (New webhook secret), not the App's first. */
      readonly replaced: boolean;
      readonly webhookUrl: string;
      readonly webhookSecret: string;
      readonly events: readonly string[];
    }
  | { readonly kind: "which-ones"; readonly connectionId: GitHubApp["connectionId"] };

/** A teal action in a line of the panel: a button, or a link to GitHub that opens in a new tab. */
const teal = "text-teal hover:underline disabled:opacity-50 disabled:hover:no-underline";

const OutLink = ({ href, children, className }: { readonly href: string; readonly children: ReactNode; readonly className?: string }) => (
  <a href={href} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-[3px] whitespace-nowrap", teal, className)}>
    {children}
    <ArrowUpRightIcon aria-hidden className="size-[13px]! stroke-[1.75] text-teal!" />
  </a>
);

const Mention = () => <span className="font-mono text-xs">{t("githubOrgs.events.mention")}</span>;

/** `OSTRA_CORE_PUBLIC_URL` as a chip in a line. */
const SettingChip = () => <code className="rounded-[4px] border border-line bg-surface px-1 font-mono text-[12.5px] text-text-2">OSTRA_CORE_PUBLIC_URL</code>;

/**
 * The note under an App's installations while its events are off (github-events.md): why, and, once
 * the address is public, `Turn them on →`, which selects the App and starts Turn on.
 */
export const MadeWithoutNote = ({ webhookPossible, busy, onTurnOn }: { readonly webhookPossible: boolean; readonly busy: boolean; readonly onTurnOn: () => void }) => (
  <p className="mt-2.5 flex items-start gap-[9px] px-2 text-[13.5px] leading-normal text-muted" data-testid="events-off-note">
    <InfoIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75] text-faint" />
    <span className="min-w-0">
      {t("githubOrgs.events.madeWithout")}
      {webhookPossible ? (
        <>
          {" "}
          <button type="button" className={cn("inline-flex items-center gap-[3px] whitespace-nowrap", teal)} disabled={busy} onClick={onTurnOn}>
            {busy ? t("githubOrgs.events.turningOn") : t("githubOrgs.events.turnThemOn")}
            <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          </button>
        </>
      ) : null}
    </span>
  </p>
);

export type EventsRowProps = {
  readonly app: GitHubApp;
  /** `undefined` while `github.appRequest` loads: the row is a skeleton. */
  readonly webhookPossible: boolean | undefined;
  /** The events ostra uses, for `On · 10 events`. */
  readonly eventCount: number | undefined;
  readonly turningOn: boolean;
  /** Turn on's refusal, or another error, under the row. */
  readonly error: string | null;
  readonly checking: boolean;
  readonly onTurnOn: () => void;
  readonly onWhichOnes: () => void;
  readonly onNewSecret: () => void;
  readonly onCheckAgain: () => void;
};

/** The line under the Events row, the width of the panel: 12.5px `--faint`. */
const RowLine = ({ children }: { readonly children: ReactNode }) => (
  <p className="mb-1.5 mt-px text-[12.5px] leading-normal text-faint" data-testid="events-line">{children}</p>
);

/** The App panel's Events row, after Webhook (github-events.md, "The Events row"), and its line. */
export const EventsRow = ({ app, webhookPossible, eventCount, turningOn, error, checking, onTurnOn, onWhichOnes, onNewSecret, onCheckAgain }: EventsRowProps) => {
  const label = t("githubOrgs.events.label");
  if (webhookPossible === undefined) {
    return (
      <PropRow labelWidth={112} label={label}>
        <Skeleton className="h-3.5 w-24" />
      </PropRow>
    );
  }
  const state = eventsState(app, webhookPossible);
  const links = appSettingsLinks(app);
  const newSecret = (
    <button type="button" className={teal} disabled={turningOn} onClick={onNewSecret}>
      {turningOn ? t("githubOrgs.events.turningOn") : t("githubOrgs.events.newSecret")}
    </button>
  );
  const row = (value: ReactNode, line: ReactNode) => (
    <div data-testid="events-row" data-state={state}>
      <PropRow labelWidth={112} label={label}>{value}</PropRow>
      <RowLine>{line}</RowLine>
      {error === null ? null : <p role="alert" className="mb-1.5 text-[13.5px] leading-normal text-red">{error}</p>}
    </div>
  );
  switch (state) {
    case "no-public":
      return row(<span className="text-muted">{t("githubOrgs.events.offNoPublic")}</span>, tNodes("githubOrgs.events.noPublicLine", { setting: <SettingChip /> }));
    case "off":
      return row(
        <>
          <span className="text-muted">{t("githubOrgs.events.off")}</span>
          <button type="button" className={cn("ml-auto inline-flex items-center gap-[3px] whitespace-nowrap", teal)} disabled={turningOn} onClick={onTurnOn}>
            {turningOn ? t("githubOrgs.events.turningOn") : t("githubOrgs.events.turnOn")}
            {turningOn ? null : <ArrowRightIcon aria-hidden className="size-[13px]! stroke-[1.75] text-teal!" />}
          </button>
        </>,
        tNodes("githubOrgs.events.offLine", { mention: <Mention /> }),
      );
    case "waiting": {
      const missing = app.missingEvents?.length ?? 0;
      return row(
        <>
          <ClockIcon aria-hidden className="stroke-[1.75] text-text!" />
          <span>{t("githubOrgs.events.waiting")}</span>
        </>,
        <>
          {plural(missing, "githubOrgs.events.waitingLineOne", "githubOrgs.events.waitingLine")}{" "}
          <button type="button" className={cn("whitespace-nowrap", teal)} onClick={onWhichOnes}>{t("githubOrgs.events.whichOnes")}</button>
          {links === null ? null : (
            <>
              {" · "}
              <OutLink href={links.permissions}>{t("githubOrgs.events.permissionsLink")}</OutLink>
            </>
          )}
          <span className="block">{newSecret}</span>
        </>,
      );
    }
    case "on":
      return row(
        <>
          <Dot tone="green" />
          <span>{t("githubOrgs.events.on")}</span>
          {eventCount === undefined ? null : <span className="-ml-0.5 text-sm text-faint">{`· ${t("githubOrgs.events.count", { n: eventCount })}`}</span>}
        </>,
        newSecret,
      );
    case "unknown":
      return row(
        <span className="text-muted">{t("githubOrgs.events.unknown")}</span>,
        <>
          {t("githubOrgs.events.unknownLine")}{" "}
          <button type="button" className={cn("whitespace-nowrap", teal)} disabled={checking} onClick={onCheckAgain}>{t("githubOrgs.events.checkAgain")}</button>
        </>,
      );
    default:
      return state satisfies never;
  }
};

/**
 * A numbered step of the result: its ring, its head, and the GitHub page's link at the head's right
 * end. The link comes after the step's fields in the page, so Tab reaches the values to copy first
 * (github-events.md, "Keyboard": URL, secret, General, Permissions, Done).
 */
const Step = ({ n, title, link, children }: { readonly n: number; readonly title: string; readonly link: { readonly href: string; readonly label: string } | null; readonly children: ReactNode }) => (
  <li className="relative mt-3.5 grid grid-cols-[22px_minmax(0,1fr)] gap-x-2">
    <span aria-hidden className="mt-px grid size-5 place-items-center rounded-full border border-line-2 font-mono text-[11.5px] font-medium text-muted">{n}</span>
    <div className="min-w-0">
      <h4 className={cn("text-ui font-medium leading-[22px] text-text", link !== null && "pr-28")}>{title}</h4>
      {children}
    </div>
    {link === null ? null : <OutLink href={link.href} className="absolute right-0 top-0 text-[13.5px] leading-[22px]">{link.label}</OutLink>}
  </li>
);

/** A value to copy: the field, cut with `…`, and its copy button (32px; 44px on a phone). */
const CopyField = ({ id, value, testId, phone }: { readonly id: string; readonly value: string; readonly testId: string; readonly phone: boolean }) => (
  <div className="flex items-center gap-2">
    <span
      id={id}
      data-testid={testId}
      className={cn("block min-w-0 flex-1 truncate rounded-md border border-line-2 bg-surface px-2.5 font-mono text-text", phone ? "h-11 text-sm leading-[42px]" : "h-8 text-[12.5px] leading-[30px]")}
    >
      {value}
    </span>
    {/* A control's edge at 3:1 (`--control-line`, F-081), beside the field's hairline. */}
    <CopyButton text={value} selectId={id} className={cn("rounded-md border border-control-line bg-surface", phone ? "size-11" : "size-8")} />
  </div>
);

const FieldLabel = ({ children }: { readonly children: ReactNode }) => <p className="mb-[5px] mt-2.5 text-sm font-medium leading-[normal] text-muted">{children}</p>;

const Strong = ({ children }: { readonly children: ReactNode }) => <b className="font-medium text-text">{children}</b>;

export type ShownOnceViewProps = {
  readonly app: GitHubApp;
  readonly shown: ShownOnce;
  /** Every event ostra uses, in its order. */
  readonly events: readonly string[];
  readonly phone: boolean;
  readonly onDone: () => void;
  /** `Esc`, wherever the focus is: the result asks before it goes, while it holds a secret. */
  readonly onEscape: () => void;
};

/**
 * Turn on's result, shown once (github-events.md, `github-events-turn-on`): the App's webhook address
 * and secret to paste under General, the events to tick under Permissions, and `Done`. A new secret
 * shows the first step only, unless events are missing; `Which ones` shows the second only.
 */
export const ShownOnceView = ({ app, shown, events, phone, onDone, onEscape }: ShownOnceViewProps) => {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const links = appSettingsLinks(app);
  const replaced = shown.kind === "secret" && shown.replaced;
  const toTick = shown.kind === "secret" ? eventsToTick(shown.events, app.missingEvents, shown.replaced) : (app.missingEvents ?? events);
  const total = shown.kind === "secret" ? shown.events.length : events.length;
  // `Esc` is "leave" wherever the focus is while the result shows, not only inside it: `Stay` gives
  // the focus back to the row that asked. A dialog's own `Esc` (Radix's, which prevents the
  // default) closes that dialog only.
  const escape = useEffectEvent(onEscape);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      escape();
    };
    document.addEventListener("keydown", keyDown);
    return () => { document.removeEventListener("keydown", keyDown); };
  }, []);
  const step2 = toTick.length === 0 ? null : (
    <Step n={shown.kind === "secret" ? 2 : 1} title={t("githubOrgs.events.once.step2")} link={links === null ? null : { href: links.permissions, label: t("githubOrgs.events.once.permissions") }}>
      <p className="mt-px text-sm text-muted">
        {toTick.length === 1
          ? tNodes("githubOrgs.events.once.step2HelpOne", { subscribe: <Strong>{t("githubOrgs.events.once.subscribe")}</Strong> })
          : tNodes("githubOrgs.events.once.step2Help", { n: toTick.length, subscribe: <Strong>{t("githubOrgs.events.once.subscribe")}</Strong> })}
      </p>
      <ul aria-label={t("githubOrgs.events.once.eventsList")} className="mt-[7px] border-t border-line" data-testid="events-to-tick">
        {toTick.map((event) => (
          <li key={event} className={cn("flex items-center border-b border-line font-mono text-sm text-text", phone ? "h-6" : "h-[25px]")}>{event}</li>
        ))}
      </ul>
    </Step>
  );
  return (
    <div data-testid="shown-once" data-kind={shown.kind}>
      <h3 ref={heading} tabIndex={-1} className="text-xs font-medium leading-[normal] text-faint outline-none">
        {replaced ? t("githubOrgs.events.once.eyebrowNew") : t("githubOrgs.events.once.eyebrow")}
      </h3>
      <p className="mt-1 truncate font-mono text-[15px] font-semibold leading-[normal] text-text">{app.slug ?? app.appId}</p>
      <p className="mb-1 mt-1 text-[13.5px] text-muted">{replaced ? t("githubOrgs.events.once.ledeNew") : t("githubOrgs.events.once.lede")}</p>
      <ol>
        {shown.kind === "secret" ? (
          <Step n={1} title={t("githubOrgs.events.once.step1")} link={links === null ? null : { href: links.general, label: t("githubOrgs.events.once.general") }}>
            <p className="mt-px text-sm text-muted">{tNodes("githubOrgs.events.once.step1Help", { active: <Strong>{t("githubOrgs.events.once.active")}</Strong> })}</p>
            <FieldLabel>{t("githubOrgs.connectAnother.webhookUrl")}</FieldLabel>
            <CopyField id={`${id}-url`} value={shown.webhookUrl} testId="webhook-url" phone={phone} />
            <FieldLabel>{t("githubOrgs.connectAnother.webhookSecret")}</FieldLabel>
            <CopyField id={`${id}-secret`} value={shown.webhookSecret} testId="webhook-secret" phone={phone} />
            <p className="mt-[9px] flex items-start gap-[7px] text-[12.5px] leading-normal text-muted">
              <LockIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
              {t("githubOrgs.connectAnother.once")}
            </p>
          </Step>
        ) : null}
        {step2}
      </ol>
      <div className="mt-4 flex items-center gap-2.5">
        <Button className={cn(phone && "h-11 flex-1 text-[15px]")} onClick={onDone}>{t("githubOrgs.connectAnother.done")}</Button>
        {phone ? null : (
          <span className="text-[12.5px] text-faint">
            {replaced ? t("githubOrgs.events.once.doneHelpNew") : t("githubOrgs.events.once.doneHelp", { n: total })}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * On a phone the result opens as a bottom sheet (github-events.md, "Phone"): 64px from the top,
 * a grab handle and a 44px close, each of which asks before it goes while the result holds a secret.
 */
export const ShownOnceSheet = ({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) => (
  <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent
      side="bottom"
      title={title}
      closeButton={false}
      className="top-16 max-h-none rounded-t-[14px] border-line-2 bg-raise px-[18px] pb-[max(18px,env(safe-area-inset-bottom))] pt-[22px] shadow-(--shadow-pop)"
      // The result's heading takes the focus (`ShownOnceView`), not the sheet's grab handle.
      onOpenAutoFocus={(event) => { event.preventDefault(); }}
      // Esc asks first, as the panel's does: the sheet stays until the leave dialog says so.
      onEscapeKeyDown={(event) => { event.preventDefault(); onClose(); }}
      onPointerDownOutside={(event) => { event.preventDefault(); onClose(); }}
    >
      {/* The grab handle: 36 × 4 at 8px from the top, inside a wider target (44px tall on touch). */}
      <button type="button" onClick={onClose} aria-label={t("common.close")} className="absolute left-1/2 top-0 grid h-5 w-14 -translate-x-1/2 justify-items-center pt-2">
        <span aria-hidden className="h-1 w-9 rounded-sm bg-line-3" />
      </button>
      <button type="button" onClick={onClose} aria-label={t("common.close")} className="absolute right-2 top-2.5 grid size-11 place-items-center text-muted hover:text-text">
        <XIcon aria-hidden className="size-[18px] stroke-[1.75]" />
      </button>
      {children}
    </SheetContent>
  </Sheet>
);

/** `Leave without copying the secret?`: Stay, or Leave, which drops the result. */
export const LeaveDialog = ({ open, onStay, onLeave }: { readonly open: boolean; readonly onStay: () => void; readonly onLeave: () => void }) => (
  <AlertDialog open={open} onOpenChange={(next) => { if (!next) onStay(); }}>
    {open ? (
      <AlertDialogContent
        title={t("githubOrgs.events.leave.title")}
        body={tNodes("githubOrgs.events.leave.body", { newSecret: <Strong>{t("githubOrgs.events.newSecret")}</Strong> })}
        cancel={t("githubOrgs.events.leave.stay")}
        action={t("githubOrgs.events.leave.leave")}
        onAction={onLeave}
      />
    ) : null}
  </AlertDialog>
);

/** `Replace the webhook secret?`: deliveries fail until the new one is pasted on GitHub. */
export const ReplaceDialog = ({ app, open, onCancel, onReplace }: { readonly app: GitHubApp | null; readonly open: boolean; readonly onCancel: () => void; readonly onReplace: () => void }) => (
  <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    {open && app !== null ? (
      <AlertDialogContent
        title={t("githubOrgs.events.replace.title")}
        body={tNodes("githubOrgs.events.replace.body", { app: <span className="font-mono text-sm text-text-2">{app.slug ?? app.appId}</span>, mention: <span className="font-mono text-sm text-text-2">{t("githubOrgs.events.mention")}</span> })}
        cancel={t("common.cancel")}
        action={t("githubOrgs.events.replace.confirm")}
        onAction={onReplace}
      />
    ) : null}
  </AlertDialog>
);
