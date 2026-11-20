"use client";

import {
  ArrowUpRightIcon,
  CheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  LockIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { PropRow, Section } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { StepTick } from "@/components/ui/step-tick";
import type { StepLook } from "@/components/ui/step-tick";
import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";

import {
  connectSteps,
  connectionTone,
  currentStep,
  formatAgo,
  formatDay,
  formatDayTime,
  formatLeft,
  formatWhen,
  middleTruncate,
  pollingLine,
} from "./linear-status";
import type { LinearConnection, LinearStatus } from "./linear-status";

/** One thing the page can do: run it, and whether it's running or failed. */
export type Act<I = void> = { readonly run: (input: I) => void; readonly pending: boolean; readonly error: string | null };

export type LinearAppValues = { readonly clientId: string; readonly clientSecret: string; readonly webhookSecret: string | null };

export type LinearActions = {
  readonly start: Act;
  readonly saveApp: Act<LinearAppValues>;
  readonly authorize: Act;
  readonly startAgain: Act;
  readonly disconnect: Act;
};

/** An error in words with its `triangle-alert`: no box, `--red`. */
export const ErrorLine = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <p role="alert" className={cn("flex items-start gap-2 text-ui text-red", className)}>
    <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

/** A sentence with `{setting}` set in mono. */
const WithSetting = ({ text, setting }: { readonly text: string; readonly setting: string }) => {
  const [before = "", after = ""] = text.split("{setting}");
  return (
    <>
      {before}
      <code className="font-mono text-sm text-text">{setting}</code>
      {after}
    </>
  );
};

/** One key/value row: a 160px key, the value, and an optional right end. Stacks at phone width. */
const KeyRow = ({ label, children, end }: { readonly label: string; readonly children: ReactNode; readonly end?: ReactNode }) => (
  <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:py-0">
    <span className="col-span-2 text-sm text-muted sm:col-span-1 sm:text-body">{label}</span>
    <span className="flex min-w-0 items-center gap-2 text-body text-text">{children}</span>
    {end === undefined ? <span /> : <span className="shrink-0">{end}</span>}
  </li>
);

/** The mode line under step 1: where events will go, or why polling. */
const ModeLine = ({ status }: { readonly status: LinearStatus }) => (
  <p className="mt-2 flex max-w-[640px] items-start gap-2 text-sm text-muted">
    <InfoIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0 break-words">
      {status.mode === "polling" ? (
        <WithSetting text={pollingLine(status.modeReason, status.pollSeconds)} setting="OSTRA_CORE_PUBLIC_URL" />
      ) : status.state !== "none" && status.webhookUrl !== null ? (
        <>
          {t("linear.mode.sendsTo")} <code className="break-all font-mono text-sm text-text">{status.webhookUrl}</code>
        </>
      ) : (
        <>
          {t("linear.mode.sendsToServer")} <code className="font-mono text-sm text-text">/webhooks/linear/…</code>
        </>
      )}
    </span>
  </p>
);

const Step = ({ n, look, title, body, children }: { readonly n: number; readonly look: StepLook; readonly title: string; readonly body: ReactNode; readonly children?: ReactNode }) => (
  <li data-step={n} data-look={look} className="flex min-h-[52px] items-start gap-3 py-3">
    <StepTick state={look} n={n} />
    <div className="min-w-0 flex-1">
      <div className={cn("font-medium", look === "done" && "text-muted")}>{title}</div>
      <div className="text-sm text-muted">{body}</div>
      {children}
    </div>
  </li>
);

const stepLook = (n: 1 | 2 | 3, current: 1 | 2 | 3): StepLook => (n < current ? "done" : n === current ? "current" : "later");

/** Step 2's form: the app's values, into secret fields that never show a saved value. */
const AppValuesForm = ({ status, act, current }: { readonly status: LinearStatus; readonly act: Act<LinearAppValues>; readonly current: boolean }) => {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const webhooks = status.mode === "webhooks";
  const busy = act.pending;
  const filled = clientId.trim() !== "" && clientSecret !== "" && (!webhooks || webhookSecret !== "");
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!filled) return;
    act.run({ clientId: clientId.trim(), clientSecret, webhookSecret: webhooks ? webhookSecret : null });
    // Nothing secret stays in the page once it's sent.
    setClientSecret("");
    setWebhookSecret("");
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t("linear.connect.step2.title")} className="mt-3 max-w-[460px]">
      <Field id="linear-client-id" label={t("linear.connect.step2.clientId")}>
        <Input id="linear-client-id" autoComplete="off" spellCheck={false} className="font-mono" disabled={busy} value={clientId} onChange={(e) => { setClientId(e.target.value); }} />
      </Field>
      <Field id="linear-client-secret" label={t("linear.connect.step2.clientSecret")}>
        <Input id="linear-client-secret" type="password" autoComplete="off" className="font-mono" disabled={busy} value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); }} />
      </Field>
      {webhooks ? (
        <Field id="linear-webhook-secret" label={t("linear.connect.step2.webhookSecret")}>
          <Input id="linear-webhook-secret" type="password" autoComplete="off" className="font-mono" disabled={busy} value={webhookSecret} onChange={(e) => { setWebhookSecret(e.target.value); }} />
        </Field>
      ) : null}
      {act.error === null ? null : <ErrorLine className="mb-3">{act.error}</ErrorLine>}
      <Button type="submit" variant={current ? "primary" : "outline"} disabled={busy || !filled}>
        {busy ? t("common.saving") : t("common.save")}
      </Button>
    </form>
  );
};

/** The three steps of a connection that isn't active yet (states 1 and 2 of connect-linear.md). */
const ConnectSection = ({ status, actions, now }: { readonly status: LinearStatus; readonly actions: LinearActions; readonly now: number }) => {
  const steps = connectSteps(status);
  const [replacing, setReplacing] = useState(false);
  const saved = steps.saved && !replacing;
  const current = currentStep({ created: steps.created, saved });
  return (
    <Section title={t("linear.connect.title")}>
      {status.state === "pending" ? (
        <p className="mb-1 text-sm text-faint">
          {status.startedByName === null
            ? t("linear.connect.startedNoName", { at: formatDayTime(status.startedAt, now) })
            : t("linear.connect.started", { at: formatDayTime(status.startedAt, now), name: status.startedByName })}{" "}
          <Button variant="link" className="h-auto px-0 text-sm" disabled={actions.startAgain.pending} onClick={() => { actions.startAgain.run(); }}>
            {t("linear.connect.startAgain")}
          </Button>
        </p>
      ) : status.state === "none" && status.lastRevoked !== null ? (
        <p className="mb-1 text-sm text-faint">
          {t("linear.connect.disconnectedFrom", { workspace: status.lastRevoked.workspaceKey ?? "Linear", date: formatDay(status.lastRevoked.at, now) })}
        </p>
      ) : null}
      <ol className="rows" data-testid="linear-steps">
        <Step n={1} look={stepLook(1, current)} title={t("linear.connect.step1.title")} body={t("linear.connect.step1.body")}>
          <ModeLine status={status} />
          <div className="mt-3">
            {steps.created ? (
              status.state !== "none" && status.manifestUrl !== null ? (
                <a href={status.manifestUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui text-teal hover:underline">
                  {t("linear.connect.step1.again")}
                  <ArrowUpRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                </a>
              ) : null
            ) : (
              <>
                {actions.start.error === null ? null : <ErrorLine className="mb-3">{actions.start.error}</ErrorLine>}
                <Button variant="primary" disabled={actions.start.pending} onClick={() => { actions.start.run(); }}>
                  {actions.start.pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpRightIcon className="stroke-[1.75]" />}
                  {actions.start.pending ? t("linear.connect.step1.preparing") : t("linear.connect.step1.action")}
                </Button>
              </>
            )}
          </div>
        </Step>
        <Step
          n={2}
          look={stepLook(2, current)}
          title={t("linear.connect.step2.title")}
          body={status.mode === "polling" ? `${t("linear.connect.step2.body")}${t("linear.connect.step2.bodyPolling")}` : t("linear.connect.step2.body")}
        >
          {!steps.created ? null : saved ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
              <LockIcon aria-hidden className="size-[13px] stroke-[1.75]" />
              {t("linear.connect.step2.saved")}
              <Button variant="link" className="h-auto px-0 ml-1 text-sm" onClick={() => { setReplacing(true); }}>
                {t("linear.connect.step2.replace")}
              </Button>
            </p>
          ) : (
            <AppValuesForm
              status={status}
              current={current === 2}
              act={{
                ...actions.saveApp,
                run: (values) => {
                  setReplacing(false);
                  actions.saveApp.run(values);
                },
              }}
            />
          )}
        </Step>
        <Step n={3} look={stepLook(3, current)} title={t("linear.connect.step3.title")} body={t("linear.connect.step3.body")}>
          <div className="mt-3">
            {actions.authorize.error === null ? null : <ErrorLine className="mb-3">{actions.authorize.error}</ErrorLine>}
            <Button variant={current === 3 ? "primary" : "outline"} disabled={current !== 3 || actions.authorize.pending} onClick={() => { actions.authorize.run(); }}>
              {actions.authorize.pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpRightIcon className="stroke-[1.75]" />}
              {actions.authorize.pending ? t("linear.connect.step3.opening") : t("linear.connect.step3.action")}
            </Button>
          </div>
        </Step>
      </ol>
    </Section>
  );
};

/** A teal `Copy` that says `Copied` for two seconds. */
const CopyButton = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="link"
      className="h-auto px-0 text-ui"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 2000);
        });
      }}
    >
      {copied ? t("common.copied") : t("common.copy")}
    </Button>
  );
};

const ModeValue = ({ status, now }: { readonly status: LinearConnection; readonly now: number }) => {
  if (status.mode === "polling")
    return (
      <>
        <RefreshCwIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
        {t("linear.events.polling", { seconds: status.pollSeconds })}
      </>
    );
  if (status.silentSince !== null)
    return (
      <>
        <TriangleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-red" />
        <span className="min-w-0">
          {t("linear.events.silent", { time: formatWhen(status.silentSince, now) })}
          <span className="text-muted">{t("linear.events.silentAfter")}</span>
        </span>
      </>
    );
  return (
    <>
      <RadioTowerIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
      {t("linear.events.receiving")}
    </>
  );
};

/** States 4 to 7: the connection, its events, its token and Disconnect. */
const ConnectedSections = ({ status, actions, now, justConnected, agentMode }: { readonly status: LinearConnection; readonly actions: LinearActions; readonly now: number; readonly justConnected: boolean; readonly agentMode?: ReactNode }) => {
  const tone = connectionTone(status.state);
  const polling = status.mode === "polling";
  const apiKey = status.credentialKind === "api_key";
  return (
    <>
      <Section title={t("linear.connection.title")}>
        <ul className="rows">
          <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-1.5 sm:grid-cols-[160px_auto_minmax(0,1fr)_auto]" data-testid="linear-connection">
            <Status tone={tone.tone} className={cn(status.state === "active" && "text-green", status.state === "failed" && "text-red")}>
              {tone.label}
            </Status>
            <span className="hidden font-mono text-text sm:block">{status.workspaceKey ?? ""}</span>
            <span className="hidden min-w-0 truncate pl-16 text-muted sm:block">{status.workspaceName ?? ""}</span>
            <span className="justify-self-end font-mono text-sm text-faint">
              {justConnected && status.state === "active" ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
                  {t("linear.connection.justConnected")}
                </span>
              ) : status.state === "failed" ? (
                t("linear.connection.since", { date: formatWhen(status.stateSince, now) })
              ) : status.activatedAt === null ? null : (
                t("linear.connection.since", { date: formatDay(status.activatedAt, now) })
              )}
            </span>
          </li>
        </ul>
      </Section>

      {agentMode}

      <Section title={t("linear.events.title")}>
        <ul className="rows">
          <KeyRow label={t("linear.events.mode")}>
            <ModeValue status={status} now={now} />
          </KeyRow>
          {polling ? (
            <KeyRow label={t("linear.events.webhook")}>
              <span className="text-muted">
                {status.modeReason === null ? t("linear.events.webhookNoneNoReason") : t("linear.events.webhookNone", { reason: status.modeReason })}
              </span>
            </KeyRow>
          ) : status.webhookUrl === null ? null : (
            <KeyRow label={t("linear.events.webhookUrl")} end={<CopyButton text={status.webhookUrl} />}>
              <span className="min-w-0 truncate font-mono text-ui text-faint" title={status.webhookUrl}>
                {middleTruncate(status.webhookUrl, 64)}
              </span>
            </KeyRow>
          )}
          {polling ? (
            <KeyRow
              label={t("linear.events.lastPoll")}
              end={status.lastPoll === null ? undefined : <span className="font-mono text-sm text-faint">{formatAgo(status.lastPoll.at, now)}</span>}
            >
              {status.lastPoll === null ? (
                <span className="text-faint">{t("linear.events.noneYet")}</span>
              ) : status.lastPoll.changed > 0 ? (
                <span className="text-muted">{plural(status.lastPoll.changed, "linear.events.changed.one", "linear.events.changed.other")}</span>
              ) : null}
            </KeyRow>
          ) : (
            <KeyRow
              label={t("linear.events.lastEvent")}
              end={status.lastEvent === null ? undefined : <span className="font-mono text-sm text-faint">{formatAgo(status.lastEvent.at, now)}</span>}
            >
              {status.lastEvent === null ? (
                <span className="text-faint">{t("linear.events.noneYet")}</span>
              ) : status.lastEvent.type === null ? null : (
                <span className="min-w-0 truncate">
                  <span className="font-mono text-ui text-text">{status.lastEvent.type}</span>
                  {status.lastEvent.ticketKey === null ? null : (
                    <>
                      {" "}
                      <span className="font-mono text-ui text-muted">{status.lastEvent.ticketKey}</span>{" "}
                      <span className="text-muted">{t("linear.events.updated")}</span>
                    </>
                  )}
                </span>
              )}
            </KeyRow>
          )}
          {polling ? null : (
            <KeyRow label={t("linear.events.backstop")}>
              <span className="text-text">{t("linear.events.backstopBody", { minutes: status.reconcileMinutes })}</span>
            </KeyRow>
          )}
        </ul>
        {!polling && status.silentSince !== null ? (
          <p className="mt-2 text-sm text-faint">{t("linear.events.silentHelp", { minutes: status.reconcileMinutes })}</p>
        ) : null}
      </Section>

      <Section title={t("linear.token.title")}>
        <ul className="rows">
          {apiKey ? (
            <KeyRow label={t("linear.token.apiKey")}>
              <LockIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-muted" />
              <span className="text-muted">{t("linear.token.apiKeyBody")}</span>
            </KeyRow>
          ) : (
            <>
              <KeyRow label={t("linear.token.access")}>
                {status.state === "failed" ? (
                  <>
                    <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
                    <span>{t("linear.token.failed")}</span>
                  </>
                ) : (
                  <span className="min-w-0">
                    <Status tone="green" className="text-green">
                      {t("linear.token.healthy")}
                    </Status>
                    <span className="text-muted">
                      {status.accessTokenExpiresAt === null ? t("linear.token.noExpiry") : t("linear.token.expiresIn", { left: formatLeft(status.accessTokenExpiresAt, now) })}
                    </span>
                  </span>
                )}
              </KeyRow>
              <KeyRow label={t("linear.token.refresh")}>
                <LockIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-muted" />
                <span className="text-muted">{t("linear.token.inSecretStore")}</span>
              </KeyRow>
            </>
          )}
        </ul>
        {status.state === "failed" && !apiKey ? (
          <div className="mt-3.5">
            {actions.authorize.error === null ? null : <ErrorLine className="mb-3">{actions.authorize.error}</ErrorLine>}
            <Button variant="primary" disabled={actions.authorize.pending} onClick={() => { actions.authorize.run(); }}>
              {actions.authorize.pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpRightIcon className="stroke-[1.75]" />}
              {actions.authorize.pending ? t("linear.connect.step3.opening") : t("linear.token.authorizeAgain")}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title={t("linear.disconnect.title")}>
        <ul className="rows">
          <li className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-2">
            <span className="min-w-0 text-body text-text">{t("linear.disconnect.body")}</span>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={actions.disconnect.pending}>{actions.disconnect.pending ? t("linear.disconnect.running") : t("linear.disconnect.action")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title={t("linear.disconnect.confirmTitle")}
                body={t("linear.disconnect.confirmBody")}
                cancel={t("common.cancel")}
                action={t("linear.disconnect.action")}
                onAction={() => { actions.disconnect.run(); }}
              />
            </AlertDialog>
          </li>
        </ul>
        {actions.disconnect.error === null ? null : <ErrorLine className="mt-2">{actions.disconnect.error}</ErrorLine>}
      </Section>
    </>
  );
};

export type LinearBodyProps = {
  readonly status: LinearStatus | undefined;
  readonly actions: LinearActions;
  readonly now: number;
  /** Back from Linear with `?connected=1`. */
  readonly justConnected: boolean;
  /** Milestone 6 (F-012): agent mode's sections, under the connection's. */
  readonly agentMode?: ReactNode;
};

/** The Linear page under its heading: the connect steps, or the connection's state (connect-linear.md). */
export const LinearBody = ({ status, actions, now, justConnected, agentMode }: LinearBodyProps) => {
  if (status === undefined)
    return (
      <Section title={t("linear.connection.title")}>
        <ul className="rows" aria-busy>
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex h-10 items-center gap-4">
              <Skeleton className="w-[120px]" />
              <Skeleton className="w-[260px]" />
            </li>
          ))}
        </ul>
      </Section>
    );
  if (status.state === "active" || status.state === "failed") return <ConnectedSections status={status} actions={actions} now={now} justConnected={justConnected} {...(agentMode === undefined ? {} : { agentMode })} />;
  return <ConnectSection status={status} actions={actions} now={now} />;
};

const PanelLabel = ({ children, count }: { readonly children: ReactNode; readonly count?: number }) => (
  <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
    {children}
    {count === undefined ? null : <span className="ml-auto font-mono text-xs">{count}</span>}
  </h3>
);

const MonoList = ({ items }: { readonly items: readonly string[] }) => (
  <ul>
    {items.map((item) => (
      <li key={item} className="flex h-[26px] items-center font-mono text-ui text-muted">
        {item}
      </li>
    ))}
  </ul>
);

const Sep = () => <div className="my-3.5 h-px bg-line" />;

/** The properties panel: the app (connected) or what it will ask for (not yet), its scopes and events. */
export const LinearProperties = ({ status }: { readonly status: LinearStatus | undefined }) => {
  if (status === undefined)
    return (
      <div>
        <PanelLabel>{t("linear.panel.app")}</PanelLabel>
        <PropRow label={t("linear.panel.appUser")}>–</PropRow>
        <PropRow label={t("linear.panel.secrets")}>–</PropRow>
      </div>
    );
  const connected = status.state === "active" || status.state === "failed";
  const events =
    status.mode === "polling" ? (
      <PropRow label={t("linear.panel.webhook")}>
        <span className="text-muted">{t("linear.panel.webhookOff", { seconds: status.pollSeconds })}</span>
      </PropRow>
    ) : (
      <>
        <PanelLabel count={status.webhookEvents.length}>{t("linear.panel.webhookEvents")}</PanelLabel>
        <MonoList items={status.webhookEvents} />
        <p className="mt-3 text-sm text-muted">{t("linear.panel.eventsHelp")}</p>
      </>
    );
  return (
    <div>
      {connected ? (
        <>
          <PanelLabel>{t("linear.panel.app")}</PanelLabel>
          <PropRow label={t("linear.panel.appUser")}>
            {status.credentialKind === "api_key" ? (
              <span className="text-muted">{t("linear.panel.personalKey")}</span>
            ) : (
              <span className="truncate font-mono">{status.appUserName ?? "–"}</span>
            )}
          </PropRow>
          <PropRow label={t("linear.panel.secrets")}>
            <LockIcon aria-hidden />
            <span className="text-muted">{t("linear.token.inSecretStore")}</span>
          </PropRow>
          <Sep />
          <PanelLabel count={status.scopes.length}>{t("linear.panel.scopes")}</PanelLabel>
        </>
      ) : (
        <>
          <PanelLabel>{t("linear.mode.label")}</PanelLabel>
          <div className="mb-1 text-ui text-text">{status.mode === "polling" ? t("linear.mode.polling") : t("linear.mode.webhooks")}</div>
          <p className="text-sm text-muted">
            {status.mode === "polling" ? (
              <WithSetting text={pollingLine(status.modeReason, status.pollSeconds)} setting="OSTRA_CORE_PUBLIC_URL" />
            ) : (
              t("linear.mode.webhooksHelp")
            )}
          </p>
          <Sep />
          <PanelLabel count={status.scopes.length}>{t("linear.panel.asksFor")}</PanelLabel>
        </>
      )}
      <MonoList items={status.scopes} />
      <Sep />
      {events}
    </div>
  );
};

