"use client";

import { CheckIcon, MailXIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { CHOOSABLE, MOMENTS, delayText, isOn, lastChangeText, momentDescription, momentName } from "./notification-words";
import type { ChoosableChannel, Grid, Moment } from "./notification-words";

// The notification choices' parts (notification-settings.md, F-036, F-115): the mail notice, the
// moments' grid and the properties panel. Each takes plain data; `notification-settings-view.tsx`
// wires them to `notifications.preferences` and `email.status`.

/** What the page shows beside the boxes (ticket 37's `notifications.preferences.get`). */
export type NotificationFacts = {
  readonly mailOn: boolean;
  readonly tracker: { readonly name: string } | null;
  readonly delaySeconds: number;
  readonly savedAt: number | null;
  readonly instanceAdmin: boolean;
};

/** Mail is off on this install: a quiet note with a `--line-2` rule, never amber (nothing waits). */
export const MailOffNotice = ({ instanceAdmin }: { readonly instanceAdmin: boolean }) => (
  <p className="mt-4 max-w-[760px] border-l-2 border-line-2 pl-3 text-ui leading-5">
    <MailXIcon aria-hidden className="mr-2 inline size-[15px] -translate-y-px stroke-[1.75] text-muted" />
    <span className="font-medium text-text">{t("notificationSettings.mailOff")}</span>
    <span className="text-muted">{t("notificationSettings.mailOffBody")}</span>
    {instanceAdmin ? (
      <>
        {" "}
        <Link href="/organization/email" className="text-teal hover:underline">
          {t("notificationSettings.setUpEmail")}
        </Link>
      </>
    ) : null}
  </p>
);

const channelLabel = (channel: "panel" | ChoosableChannel): string => {
  switch (channel) {
    case "panel":
      return t("notificationSettings.panel");
    case "tracker":
      return t("notificationSettings.ticket");
    case "email":
      return t("notificationSettings.email");
    default:
      return channel satisfies never;
  }
};

const Box = ({ kind, channel, grid, disabled, onChange }: { readonly kind: Moment; readonly channel: ChoosableChannel; readonly grid: Grid; readonly disabled: boolean; readonly onChange: (kind: Moment, channel: ChoosableChannel, on: boolean) => void }) => (
  <Checkbox
    className="size-4"
    checked={isOn(grid, kind, channel)}
    disabled={disabled}
    aria-label={t("notificationSettings.boxLabel", { channel: channelLabel(channel), moment: momentName(kind) })}
    onCheckedChange={(state) => {
      onChange(kind, channel, state === true);
    }}
  />
);

const PanelBox = ({ kind }: { readonly kind: Moment }) => (
  <Tooltip content={t("notificationSettings.panelAlways")}>
    <span className="inline-grid">
      <Checkbox className="size-4 disabled:opacity-40" checked disabled aria-label={t("notificationSettings.boxLabel", { channel: channelLabel("panel"), moment: momentName(kind) })} />
    </span>
  </Tooltip>
);

/** A labelled box at phone width, where the header row is hidden. */
const PhoneCell = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <span className="flex items-center gap-2 sm:contents">
    {children}
    <span aria-hidden className="text-sm text-muted sm:hidden">
      {label}
    </span>
  </span>
);

export type MomentsTableProps = {
  /** `undefined` while it loads. */
  readonly grid: Grid | undefined;
  readonly mailOn: boolean;
  readonly disabled: boolean;
  readonly onChange: (kind: Moment, channel: ChoosableChannel, on: boolean) => void;
};

/**
 * The moments' grid: a 30px head, 44px rows, the moment's name and description, and three 88px
 * centred columns of 16px boxes. The panel's box is always checked and disabled.
 */
export const MomentsTable = ({ grid, mailOn, disabled, onChange }: MomentsTableProps) => (
  <div role="table" aria-label={t("notificationSettings.moments")} className="max-w-[760px]">
    <div role="row" className="hidden h-[30px] grid-cols-[minmax(0,1fr)_88px_88px_88px] items-center border-b border-line text-[11.5px] font-medium text-faint sm:grid">
      <span role="columnheader">{t("notificationSettings.moment")}</span>
      <span role="columnheader" className="text-center">
        {t("notificationSettings.panel")}
      </span>
      <span role="columnheader" className="text-center">
        {t("notificationSettings.ticket")}
      </span>
      <span role="columnheader" className="text-center">
        {t("notificationSettings.email")}
        {mailOn ? null : (
          <span aria-hidden>
            {t("notificationSettings.emailOff")}
          </span>
        )}
      </span>
    </div>
    {MOMENTS.map((kind) => (
      <div
        role="row"
        key={kind}
        data-moment={kind}
        className="grid grid-cols-1 gap-y-2 border-b border-line py-2.5 sm:h-11 sm:grid-cols-[minmax(0,1fr)_88px_88px_88px] sm:items-center sm:py-0"
      >
        <span role="cell" className="min-w-0">
          <span className="block truncate text-ui font-medium leading-[18px] text-text">{momentName(kind)}</span>
          <span className="block truncate text-xs leading-4 text-muted">{momentDescription(kind)}</span>
        </span>
        <span className="flex items-center gap-6 sm:contents">
          <span role="cell" className="sm:grid sm:place-items-center">
            <PhoneCell label={t("notificationSettings.panel")}>{grid === undefined ? <Skeleton className="size-4" /> : <PanelBox kind={kind} />}</PhoneCell>
          </span>
          {CHOOSABLE.map((channel) => (
            <span role="cell" key={channel} className="sm:grid sm:place-items-center">
              <PhoneCell label={channelLabel(channel)}>
                {grid === undefined ? <Skeleton className="size-4" /> : <Box kind={kind} channel={channel} grid={grid} disabled={disabled} onChange={onChange} />}
              </PhoneCell>
            </span>
          ))}
        </span>
      </div>
    ))}
  </div>
);

export type MomentsFootProps = {
  readonly showReset: boolean;
  readonly onReset: () => void;
  readonly saved: boolean;
  readonly error: string | null;
};

/** The footnote, `Reset to defaults` while the boxes differ from them, and the save's outcome. */
export const MomentsFoot = ({ showReset, onReset, saved, error }: MomentsFootProps) => (
  <div className="mt-2.5 max-w-[760px]">
    <p className="text-xs text-faint">{t("notificationSettings.footnote")}</p>
    {showReset ? (
      <Button variant="link" className="mt-1.5 text-[12.5px] hover:no-underline" onClick={onReset}>
        {t("notificationSettings.reset")}
      </Button>
    ) : null}
    {saved ? (
      <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-green">
        <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {t("notificationSettings.saved")}
      </p>
    ) : null}
    {error === null ? null : (
      <p role="alert" className="mt-2 text-[12.5px] text-red">
        {error}
      </p>
    )}
  </div>
);

export const MomentsSection = ({ children }: { readonly children: ReactNode }) => (
  <Section title={t("notificationSettings.moments")} className="mt-[26px]">
    {children}
  </Section>
);

const Value = ({ ready, children, className }: { readonly ready: boolean; readonly children: ReactNode; readonly className?: string | undefined }) =>
  ready ? <span className={cn("min-w-0 truncate", className)}>{children}</span> : <Skeleton className="w-[96px]" />;

export type NotificationPanelProps = {
  readonly email: string | null;
  /** `undefined` while it loads. */
  readonly facts: NotificationFacts | undefined;
};

/** The properties panel: where these reach the member, what a mail carries, and the last change. */
export const NotificationPanel = ({ email, facts }: NotificationPanelProps) => {
  const ready = facts !== undefined;
  const tracker = facts?.tracker ?? null;
  return (
    <div className="text-[12.5px]">
      <PropGroup title={t("notificationSettings.yourAddress")}>
        {email === null ? <p className="text-muted">{t("notificationSettings.noAddress")}</p> : <p className="truncate font-mono text-ui text-text">{email}</p>}
        <p className="mt-1 text-xs text-muted">{tracker === null ? t("notificationSettings.addressHint") : t("notificationSettings.addressHintTracker", { tracker: tracker.name })}</p>
      </PropGroup>
      <PropGroup title={t("notificationSettings.channels")}>
        <PropRow label={t("notificationSettings.panel")} labelWidth={96}>
          {t("notificationSettings.alwaysOn")}
        </PropRow>
        <PropRow label={t("notificationSettings.ticket")} labelWidth={96}>
          <Value ready={ready} className={tracker === null ? "text-faint" : undefined}>
            {tracker === null ? t("notificationSettings.noTracker") : tracker.name}
          </Value>
        </PropRow>
        <PropRow label={t("notificationSettings.email")} labelWidth={96}>
          {facts === undefined ? (
            <Skeleton className="w-[96px]" />
          ) : facts.mailOn ? (
            <Status tone="green">{t("notificationSettings.mailOn")}</Status>
          ) : (
            <Status tone="grey">{t("notificationSettings.mailOffShort")}</Status>
          )}
        </PropRow>
      </PropGroup>
      <PropGroup title={t("notificationSettings.mail")}>
        <PropRow label={t("notificationSettings.delay")} labelWidth={96}>
          <Value ready={ready} className="font-mono">
            {facts === undefined ? "" : delayText(facts.delaySeconds)}
          </Value>
        </PropRow>
        <PropRow label={t("notificationSettings.skippedWhen")} labelWidth={96}>
          {t("notificationSettings.readInPanel")}
        </PropRow>
        <p className="mt-1.5 text-xs leading-[18px] text-muted">{t("notificationSettings.mailCarries")}</p>
      </PropGroup>
      <PropGroup title={t("notificationSettings.lastChange")}>
        {facts === undefined ? <Skeleton className="w-[120px]" /> : <p className="text-muted">{lastChangeText(facts.savedAt)}</p>}
      </PropGroup>
    </div>
  );
};
