"use client";

import { CheckIcon, CopyIcon, InfoIcon, LoaderCircleIcon, LockIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { AlertLine, Step, StepLink } from "./jira-steps";
import type { StepAct } from "./jira-steps";
import { clockOf, eventWord, pollingWhy, waitingHint } from "./jira-words";
import type { JiraAddressProblem, JiraWebhook, StepState } from "./jira-words";

// Step 3 (jira-connect.md, `jira-connect-webhook`, `jira-connect-polling`, `jira-connect-phone`):
// what a Jira admin pastes into Settings › System › WebHooks: the URL and the secret ostra made, as
// copy fields, the six events, the optional JQL, the line about the secret, and the wait row, which
// the page keeps current by asking `trackers.jira.webhook` every 3 s, until the first signed
// delivery connects it. A delivery with a wrong signature turns the row red, with `Make a new
// secret`. Without a public address the step is `Events: polling`, and `Finish` connects it.

/** How long a copy button shows its green check (jira-connect.md: 2 s). */
const COPIED_MS = 2000;

/**
 * A value to paste into Jira: mono 12.5px in a 32px field (40px on a phone), and a 32px copy button
 * (40px) labelled for what it copies, which turns into a green check for 2 s and says `Copied`.
 */
export const CopyField = ({ value, label, testId }: { readonly value: string; readonly label: string; readonly testId: string }) => {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        id={id}
        data-testid={testId}
        className="block h-8 min-w-0 flex-1 truncate rounded-md border border-line-2 bg-surface px-2.5 font-mono text-[12.5px] leading-[30px] text-text max-sm:h-10 max-sm:leading-[38px]"
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={label}
        data-copy={value}
        data-copied={copied}
        onClick={() => {
          void copyText(value, id).then((outcome) => {
            if (outcome !== "copied") return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => { setCopied(false); }, COPIED_MS);
          });
        }}
        className="grid size-8 shrink-0 place-items-center rounded-md border border-control-line bg-surface text-muted hover:bg-sel hover:text-text max-sm:size-10"
      >
        {copied ? <CheckIcon aria-hidden className="size-[15px] stroke-[1.75] text-green" /> : <CopyIcon aria-hidden className="size-[15px] stroke-[1.75]" />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("trackers.jira.connect.step3.copied") : ""}
      </span>
    </div>
  );
};

/** One of step 3's rows: a 116px label, then the field; the label over the field on a phone. */
const Row = ({ label, children, top = false }: { readonly label: ReactNode; readonly children: ReactNode; readonly top?: boolean }) => (
  <div className={cn("mt-2 grid max-w-[640px] grid-cols-[116px_minmax(0,1fr)] gap-x-3 max-sm:max-w-none max-sm:grid-cols-1 max-sm:gap-y-[5px]", top ? "items-start" : "items-center")}>
    <span className={cn("text-[12.5px] font-medium text-muted max-sm:text-sm", top && "mt-1")}>{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);

/** A sentence with `{name}`-style holes filled by nodes. */
const Fill = ({ text, values }: { readonly text: string; readonly values: Readonly<Record<string, ReactNode>> }) => (
  <>
    {text.split(/(\{\w+\})/).map((part, i) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      const value = name === undefined ? undefined : values[name];
      return <span key={i}>{value ?? part}</span>;
    })}
  </>
);

/** The spinner of the wait row: an 11px ring with a teal arc, still when motion is reduced. */
const Spinner = () => <span aria-hidden className="inline-block size-[11px] shrink-0 rounded-full border-[1.75px] border-line-2 border-t-teal motion-safe:animate-spin" />;

export type WebhookStepProps = {
  readonly state: StepState;
  /** The connection's name, for `Finish`'s line. */
  readonly name: string;
  /** Before step 3 opens, how events will come (the connection's mode as it was made). */
  readonly mode: "webhooks" | "polling";
  /** Step 3's values, once asked; `undefined` while they load. */
  readonly webhook: JiraWebhook | undefined;
  /** The projects the token saw, for the wait row's hint. */
  readonly keys: readonly string[];
  readonly pollSeconds: number;
  readonly webhooksPage: string | null;
  readonly finish: StepAct<void>;
  readonly rotate: StepAct<void>;
  /** The webhook's values couldn't be read. */
  readonly error: string | null;
};

/** The webhook's rows, while webhooks reach this server. */
const WebhookRows = ({ webhook, keys, rotate, finish }: { readonly webhook: Extract<JiraWebhook, { readonly mode: "webhooks" }>; readonly keys: readonly string[]; readonly rotate: StepAct<void>; readonly finish: StepAct<void> }) => {
  const settings = <b>{t("trackers.jira.connect.step3.settings")}</b>;
  const create = <b>{t("trackers.jira.connect.step3.create")}</b>;
  const bad = webhook.badSignatureAt;
  return (
    <>
      <div className="mt-0.5 max-w-[600px] text-[13.5px] leading-normal text-muted max-sm:text-ui [&_b]:font-medium [&_b]:text-text">
        <span className="max-sm:hidden">
          <Fill text={t("trackers.jira.connect.step3.body")} values={{ settings, create }} />
        </span>
        <span className="sm:hidden">
          <Fill text={t("trackers.jira.connect.step3.bodyPhone")} values={{ settings, create }} />
        </span>
      </div>
      <div className="mt-1">
        <Row label={t("trackers.jira.connect.step3.url")}>
          {webhook.url === null ? <span className="text-faint">–</span> : <CopyField value={webhook.url} label={t("trackers.jira.connect.step3.copyUrl")} testId="jira-webhook-url" />}
        </Row>
        <Row label={t("trackers.jira.connect.step3.secret")}>
          {webhook.secret === null ? (
            <span className="text-[12.5px] text-muted">{t("trackers.jira.connect.step3.noSecret")}</span>
          ) : (
            <CopyField value={webhook.secret} label={t("trackers.jira.connect.step3.copySecret")} testId="jira-webhook-secret" />
          )}
        </Row>
        <Row label={t("trackers.jira.connect.step3.events")} top>
          <ul aria-label={t("trackers.jira.connect.step3.events")} data-testid="jira-webhook-events" className="flex flex-wrap gap-1.5">
            {webhook.events.map((event) => (
              <li key={event} className="inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-line-2 px-[7px] text-[12.5px] text-text-2 max-sm:h-[26px] max-sm:text-sm">
                <CheckIcon aria-hidden className="size-3 stroke-[1.75] text-green" />
                {eventWord(event)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12.5px] text-faint [&_b]:font-medium [&_b]:text-muted">
            <Fill text={t("trackers.jira.connect.step3.excludeBody")} values={{ name: <b>{t("trackers.jira.connect.step3.excludeBodyName")}</b> }} />
          </p>
        </Row>
        {webhook.jql === null ? null : (
          <Row
            label={
              <>
                {t("trackers.jira.connect.step3.jql")} <span className="font-normal text-faint">{t("trackers.jira.connect.step3.optional")}</span>
              </>
            }
          >
            <CopyField value={webhook.jql} label={t("trackers.jira.connect.step3.copyJql")} testId="jira-webhook-jql" />
          </Row>
        )}
      </div>
      <p className="mt-[9px] flex max-w-[640px] items-start gap-[7px] text-[12.5px] leading-normal text-muted">
        <LockIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
        <span>{t("trackers.jira.connect.step3.lock")}</span>
      </p>
      {bad === null ? (
        <div data-testid="jira-webhook-wait" className="mt-3.5 flex max-w-[640px] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-line-2 px-3 py-2.5 text-[13.5px] text-text-2 max-sm:max-w-none">
          <Spinner />
          <span role="status" className="min-w-0 flex-1">
            {t("trackers.jira.connect.step3.waiting")} <span className="text-faint max-sm:hidden">{waitingHint(keys)}</span>
          </span>
          <button type="button" disabled={finish.pending} onClick={() => { finish.run(); }} className="ml-auto whitespace-nowrap text-teal hover:underline disabled:opacity-50 max-sm:ml-[21px] max-sm:basis-full max-sm:text-left">
            {finish.pending ? t("trackers.jira.connect.polling.finishing") : t("trackers.jira.connect.step3.usePolling")}
          </button>
        </div>
      ) : (
        <div data-testid="jira-webhook-bad" className="mt-3.5 flex max-w-[640px] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-red px-3 py-2.5 text-[13.5px] text-text-2 max-sm:max-w-none">
          <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
          <span role="alert" className="min-w-0 flex-1">
            <Fill text={t("trackers.jira.connect.step3.badSignature")} values={{ time: <code className="font-mono text-[12.5px] text-text">{clockOf(bad)}</code> }} />
          </span>
          <button type="button" disabled={rotate.pending} onClick={() => { rotate.run(); }} className="ml-auto whitespace-nowrap text-teal hover:underline disabled:opacity-50 max-sm:ml-6 max-sm:basis-full max-sm:text-left">
            {rotate.pending ? t("trackers.jira.connect.step3.making") : t("trackers.jira.connect.step3.newSecret")}
          </button>
        </div>
      )}
      {rotate.error === null ? null : <AlertLine className="mt-2">{rotate.error}</AlertLine>}
      {finish.error === null ? null : <AlertLine className="mt-2">{finish.error}</AlertLine>}
    </>
  );
};

/** Without a public address (jira-connect.md, "No public address"): why, the setting that changes it, and `Finish`. */
const PollingRows = ({ reason, seconds, name, finish }: { readonly reason: JiraAddressProblem | null; readonly seconds: number; readonly name: string; readonly finish: StepAct<void> }) => (
  <>
    <p data-testid="jira-polling-why" className="mt-1.5 flex max-w-[620px] items-start gap-2 text-[13.5px] leading-normal text-muted">
      <RefreshCwIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75]" />
      <span>
        {pollingWhy(reason, seconds)}
        <b className="font-medium text-text">{t("trackers.jira.connect.polling.late")}</b>
      </span>
    </p>
    <p className="mt-2 flex max-w-[620px] items-start gap-2 text-[13.5px] leading-normal text-muted">
      <InfoIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75]" />
      <span>
        <Fill text={t("trackers.jira.connect.polling.setting")} values={{ setting: <code className="font-mono text-[12.5px] text-text-2">OSTRA_CORE_PUBLIC_URL</code> }} />
      </span>
    </p>
    {finish.error === null ? null : <AlertLine className="mt-3">{finish.error}</AlertLine>}
    <div className="mt-3.5 flex flex-wrap items-center gap-3">
      <Button variant="primary" disabled={finish.pending} onClick={() => { finish.run(); }} className="max-sm:h-11">
        {finish.pending ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : null}
        {finish.pending ? t("trackers.jira.connect.polling.finishing") : t("trackers.jira.connect.polling.finish")}
      </Button>
      <span className="text-[12.5px] text-faint">{t("trackers.jira.connect.polling.finishHelp", { name })}</span>
    </div>
  </>
);

/** Step 3: the admin webhook, or polling. */
export const WebhookStep = ({ state, name, mode, webhook, keys, pollSeconds, webhooksPage, finish, rotate, error }: WebhookStepProps) => {
  const polling = webhook === undefined ? mode === "polling" : webhook.mode === "polling";
  if (state !== "current") {
    return (
      <Step
        n={3}
        state={state}
        title={polling ? t("trackers.jira.connect.polling.laterTitle") : t("trackers.jira.connect.step3.title")}
        body={polling ? t("trackers.jira.connect.polling.later") : t("trackers.jira.connect.step3.later")}
      />
    );
  }
  const link =
    polling || webhooksPage === null ? undefined : (
      <span className="ml-auto max-sm:hidden">
        <StepLink href={webhooksPage}>{t("trackers.jira.connect.step3.link")}</StepLink>
      </span>
    );
  return (
    <Step n={3} state="current" title={polling ? t("trackers.jira.connect.polling.title") : t("trackers.jira.connect.step3.title")} {...(link === undefined ? {} : { link })}>
      {error !== null ? (
        <AlertLine className="mt-2">{error}</AlertLine>
      ) : webhook === undefined ? (
        <div aria-busy className="mt-3 flex max-w-[640px] flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : webhook.mode === "polling" ? (
        <PollingRows reason={webhook.reason} seconds={pollSeconds} name={name} finish={finish} />
      ) : (
        <WebhookRows webhook={webhook} keys={keys} rotate={rotate} finish={finish} />
      )}
    </Step>
  );
};
