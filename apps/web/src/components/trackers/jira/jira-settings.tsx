"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  LockIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PropRow, Section } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ConnectionBoards } from "../connection-boards";
import { ConnectionHeader } from "../connection-header";
import { PanelLabel, Sep } from "../linear/linear-panel";
import { agoText } from "../tracker-words";
import { TrackerMark, trackerMarkAt } from "../tracker-mark";
import { Readback } from "./jira-readback";
import { TokenForm } from "./jira-steps";
import type { StepAct, TokenValues } from "./jira-steps";
import { addressProblemWord, eventWord, formatExpiry } from "./jira-words";
import type { JiraDetail, JiraReadBack, JiraVerdict } from "./jira-words";

// A Jira connection's page once it's active or failed (connection-settings.md, targets
// `connection-jira` and `jira-connect-states`): its events and their secret, its service account
// and the token's date, and Disconnect. A member reads the events without the URL, the secret,
// Rotate, Replace or Disconnect (`trackers.get` sends them as `null`). The body is pure, so every
// state is drawn in the tests without a browser; `JiraSettingsPage` wires the mutations to it.

const DAY_MS = 86_400_000;
const listOf = (items: readonly string[]): string => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format([...items]);

const KeyRow = ({ label, children, end }: { readonly label: string; readonly children: ReactNode; readonly end?: ReactNode }) => (
  <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:py-0">
    <span className="col-span-2 text-sm text-muted sm:col-span-1 sm:text-body">{label}</span>
    <span className="flex min-w-0 items-center gap-2 text-body text-text">{children}</span>
    {end === undefined ? <span /> : <span className="shrink-0">{end}</span>}
  </li>
);

/** The teal end-of-row action. */
const LinkAction = ({ children, onClick, testId, disabled = false }: { readonly children: ReactNode; readonly onClick: () => void; readonly testId?: string; readonly disabled?: boolean }) => (
  <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className="text-ui text-teal hover:underline disabled:opacity-50">
    {children}
  </button>
);

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

/** The mode's value: receiving, polling every N s, or silent with polling still finding changes. */
const ModeValue = ({ detail }: { readonly detail: JiraDetail }) => {
  if (detail.webhookMode === "polling")
    return (
      <>
        <RefreshCwIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
        {t("trackers.jira.settings.events.polling", { seconds: detail.jira.pollSeconds })}
      </>
    );
  if (detail.silentSince !== null)
    return (
      <>
        <TriangleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-red" />
        <span className="min-w-0">
          {t("trackers.jira.settings.events.silent", { time: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(detail.silentSince) })}
          <span className="text-muted">{t("trackers.jira.settings.events.silentAfter")}</span>
        </span>
      </>
    );
  return (
    <>
      <RadioTowerIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
      {t("trackers.jira.settings.events.receiving")}
    </>
  );
};

export type JiraRotate = { readonly run: () => void; readonly pending: boolean; readonly error: string | null; readonly secret: string | null };

export type JiraTokenOps = {
  readonly check: { readonly run: (values: TokenValues) => void; readonly pending: boolean; readonly error: string | null; readonly readBack: JiraReadBack | null; readonly verdict: JiraVerdict | null };
  readonly save: StepAct<TokenValues>;
  readonly recheck: { readonly run: () => void; readonly pending: boolean; readonly error: string | null; readonly readBack: JiraReadBack | null; readonly verdict: JiraVerdict | null };
  /** The fields changed: the read-back no longer says what's in them. */
  readonly reset: () => void;
};

export type JiraSettingsBodyProps = {
  readonly detail: JiraDetail;
  readonly now: number;
  readonly canManage: boolean;
  readonly justConnected: boolean;
  readonly rotate: JiraRotate;
  readonly token: JiraTokenOps;
  readonly disconnect: { readonly run: () => void; readonly pending: boolean; readonly error: string | null };
};

/** Disconnect's dialog body: what stops, and the boards (by project) that stay attached and paused (F-152/c5). */
export const jiraDisconnectBody = (detail: JiraDetail): string => {
  const projects = [...new Set(detail.boards.map((board) => board.project.name))];
  const boardLine = plural(detail.boards.length, "trackers.jira.settings.disconnect.boardsOne", "trackers.jira.settings.disconnect.boardsMany");
  return t("trackers.jira.settings.disconnect.confirmBody", {
    site: detail.site ?? detail.name,
    boards: projects.length === 0 ? boardLine : `${boardLine} on ${listOf(projects)}`,
  });
};

/** `14 Sep 2027` and `295`: the token's date and the whole days until it. */
const expiry = (at: number, now: number): { readonly date: string; readonly days: number } => ({ date: formatExpiry(at), days: Math.max(0, Math.round((at - now) / DAY_MS)) });

/** The page's sections under the header: Connection, Events, Service account, Disconnect. */
export const JiraSettingsBody = ({ detail, now, canManage, justConnected, rotate, token, disconnect }: JiraSettingsBodyProps) => {
  const jira = detail.jira;
  const polling = detail.webhookMode === "polling";
  const [replacing, setReplacing] = useState(false);
  const expiryState = detail.tokenExpiry;
  const expired = expiryState?.state === "expired" || (detail.state === "failed" && detail.failedReason === "token-expired");
  const soon = !expired && expiryState?.state === "expires-soon";
  const tokenDate = detail.tokenExpiresAt === null ? null : expiry(detail.tokenExpiresAt, now);
  const checkedAt = jira.reach === null ? null : jira.reach.checkedAt;
  const confirmBody = jiraDisconnectBody(detail);
  const startReplace = () => {
    token.reset();
    setReplacing(true);
  };

  return (
    <>
      <Section title={t("trackers.jira.connect.connected.title")}>
        <ul className="rows">
          <li className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-1.5 sm:grid-cols-[160px_auto_minmax(0,1fr)_auto]" data-testid="jira-connection">
            <Status tone={detail.state === "active" ? "green" : detail.state === "failed" ? "red" : "grey"} className={detail.state === "active" ? "text-green" : detail.state === "failed" ? "text-red" : "text-muted"}>
              {detail.state === "active"
                ? t("trackers.jira.connect.connected.connected")
                : detail.state === "failed"
                  ? t("trackers.jira.connect.connected.failed")
                  : t("trackers.linear.connection.pending")}
            </Status>
            <span className="hidden font-mono text-text sm:block">{detail.site ?? ""}</span>
            <span className="hidden min-w-0 truncate pl-16 text-muted sm:block">{detail.name.split(/\s+/)[0] ?? ""}</span>
            <span className="justify-self-end font-mono text-sm text-faint">
              {justConnected && detail.state === "active" ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
                  {t("trackers.jira.connect.connected.justConnected")}
                </span>
              ) : detail.state === "active" && jira.activatedAt !== null ? (
                t(`trackers.linear.connection.since`, { date: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(jira.activatedAt) })
              ) : null}
            </span>
          </li>
        </ul>
      </Section>

      <Section title={t("trackers.jira.settings.events.title")}>
        <ul className="rows">
          <KeyRow label={t("trackers.jira.settings.events.mode")}>
            <ModeValue detail={detail} />
          </KeyRow>
          {polling ? (
            <KeyRow label={t("trackers.jira.settings.events.webhookUrl")}>
              <span className="text-muted">
                {jira.modeReason === null ? t("trackers.jira.settings.events.webhookNoneNoReason") : t("trackers.jira.settings.events.webhookNone", { reason: addressProblemWord(jira.modeReason) })}
              </span>
            </KeyRow>
          ) : jira.webhookUrl === null ? null : (
            <KeyRow label={t("trackers.jira.settings.events.webhookUrl")} end={canManage ? <CopyButton text={jira.webhookUrl} /> : undefined}>
              <span className="min-w-0 truncate font-mono text-ui text-faint" title={jira.webhookUrl} data-testid="jira-webhook-url">
                {jira.webhookUrl}
              </span>
            </KeyRow>
          )}
          {polling || !canManage ? null : (
            <KeyRow
              label={t("trackers.jira.settings.events.webhookSecret")}
              end={
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button type="button" className="text-ui text-teal hover:underline" data-testid="jira-rotate">
                      {t("trackers.jira.settings.events.rotate")}
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    title={t("trackers.jira.settings.events.rotateTitle")}
                    body={t("trackers.jira.settings.events.rotateBody")}
                    cancel={t("common.cancel")}
                    action={t("trackers.jira.settings.events.rotate")}
                    onAction={rotate.run}
                  />
                </AlertDialog>
              }
            >
              <LockIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-muted" />
              <span className="text-muted">{t("trackers.jira.settings.events.inSecretStore")}</span>
            </KeyRow>
          )}
          {!canManage || rotate.secret === null ? null : (
            <KeyRow label={t("trackers.jira.settings.events.webhookSecret")} end={<CopyButton text={rotate.secret} />}>
              <span className="min-w-0 break-all font-mono text-ui text-text" data-testid="jira-new-secret">
                {rotate.secret}
              </span>
              <span className="text-muted">{t("trackers.jira.settings.events.rotated")}</span>
            </KeyRow>
          )}
          {polling ? (
            <KeyRow label={t("trackers.jira.settings.events.lastPoll")} end={jira.lastPollAt === null ? undefined : <span className="font-mono text-sm text-faint">{agoText(jira.lastPollAt, now)}</span>}>
              {jira.lastPollAt === null ? <span className="text-faint">{t("trackers.jira.settings.events.noneYet")}</span> : null}
            </KeyRow>
          ) : (
            <KeyRow label={t("trackers.jira.settings.events.lastEvent")} end={jira.lastEvent === null ? undefined : <span className="font-mono text-sm text-faint">{agoText(jira.lastEvent.at, now)}</span>}>
              {jira.lastEvent === null ? (
                <span className="text-faint">{t("trackers.jira.settings.events.noneYet")}</span>
              ) : jira.lastEvent.type === null ? null : (
                <span className="min-w-0 truncate">
                  <span className="font-mono text-ui text-text">{jira.lastEvent.type}</span>
                  {jira.lastEvent.ticketKey === null ? null : (
                    <>
                      {" "}
                      <span className="font-mono text-ui text-muted">{jira.lastEvent.ticketKey}</span>{" "}
                      <span className="text-muted">{t("trackers.jira.settings.events.updated")}</span>
                    </>
                  )}
                </span>
              )}
            </KeyRow>
          )}
          {polling ? null : (
            <KeyRow label={t("trackers.jira.settings.events.backstop")}>
              <span className="text-text">{t("trackers.jira.settings.events.backstopBody", { minutes: jira.reconcileMinutes })}</span>
            </KeyRow>
          )}
        </ul>
        {polling || detail.silentSince === null ? null : <p className="mt-2 text-sm text-faint">{t("trackers.jira.settings.events.silentHelp", { minutes: jira.reconcileMinutes })}</p>}
        {rotate.error === null ? null : (
          <p role="alert" className="mt-2 text-sm text-red">
            {rotate.error}
          </p>
        )}
      </Section>

      {!canManage ? null : (
        <Section title={t("trackers.jira.settings.token.title")}>
          <ul className="rows">
            <KeyRow label={t("trackers.jira.settings.token.signsInAs")}>
              {jira.email === null ? <span className="text-faint">{t("trackers.jira.settings.token.signsInAsHidden")}</span> : <span className="truncate font-mono text-ui">{jira.email}</span>}
            </KeyRow>
            <KeyRow
              label={t("trackers.jira.settings.token.token")}
              end={
                expired ? undefined : (
                  <LinkAction onClick={startReplace} testId="jira-token-replace">
                    {t("trackers.jira.settings.token.replace")}
                  </LinkAction>
                )
              }
            >
              {expired ? (
                <>
                  <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
                  <span data-testid="jira-token-expired">
                    {t("trackers.jira.settings.token.expired", { date: tokenDate?.date ?? "–" })}
                  </span>
                </>
              ) : soon ? (
                <>
                  <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
                  <span data-testid="jira-token-expiring">
                    {tokenDate === null
                      ? null
                      : tokenDate.days <= 1
                        ? t("trackers.jira.settings.token.expiresTomorrow", { date: tokenDate.date })
                        : t("trackers.jira.settings.token.expiresSoon", { days: tokenDate.days, date: tokenDate.date })}
                  </span>
                </>
              ) : (
                <span className="min-w-0" data-testid="jira-token-healthy">
                  <Status tone="green" className="text-green">
                    {t("trackers.jira.settings.token.healthy")}
                  </Status>
                  <span className="text-muted">{tokenDate === null ? null : t("trackers.jira.settings.token.expiresIn", { date: tokenDate.date, days: tokenDate.days })}</span>
                </span>
              )}
            </KeyRow>
            <KeyRow
              label={t("trackers.jira.settings.token.reaches")}
              end={
                <span className="flex items-center gap-3">
                  {checkedAt === null ? null : <span className="font-mono text-sm text-faint">{t("trackers.jira.settings.token.checked", { ago: agoText(checkedAt, now) })}</span>}
                  <LinkAction onClick={token.recheck.run} testId="jira-check-again" disabled={token.recheck.pending}>
                    {token.recheck.pending ? t("trackers.jira.settings.token.checking") : t("trackers.jira.settings.token.checkAgain")}
                  </LinkAction>
                </span>
              }
            >
              {jira.reach === null ? (
                <span className="text-faint">–</span>
              ) : (
                <span className="min-w-0">
                  <span>{plural(jira.reach.projects.length, "trackers.jira.settings.token.projects.one", "trackers.jira.settings.token.projects.other")}</span>
                  <span className="text-muted">{t("trackers.jira.settings.token.can")}</span>
                </span>
              )}
            </KeyRow>
          </ul>
          {token.recheck.error === null ? null : (
            <p role="alert" className="mt-2 text-sm text-red">
              {token.recheck.error}
            </p>
          )}
          {token.recheck.readBack === null ? null : (
            <div data-testid="jira-recheck">
              <Readback readBack={token.recheck.readBack} />
            </div>
          )}
          {replacing ? (
            <div className="mt-3.5" data-testid="jira-replace">
              <TokenForm
                email={jira.email ?? ""}
                scopes={jira.neededScopes}
                check={{ run: token.check.run, pending: token.check.pending, error: token.check.error }}
                save={token.save}
                readBack={token.check.readBack}
                verdict={token.check.verdict}
                onEdit={token.reset}
                now={now}
                focus
              />
              <Button variant="link" className="mt-2 h-auto px-0 text-sm" onClick={() => { setReplacing(false); token.reset(); }}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : null}
          {expired ? (
            <div className="mt-3.5">
              <Button variant="primary" onClick={startReplace} data-testid="jira-replace-primary">
                {t("trackers.jira.settings.token.replace")}
              </Button>
            </div>
          ) : null}
        </Section>
      )}

      {!canManage ? null : (
        <Section title={t("trackers.jira.settings.disconnect.title")}>
          <ul className="rows">
            <li className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-body text-text">{t("trackers.jira.settings.disconnect.body", { n: detail.boards.length })}</span>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={disconnect.pending}>{disconnect.pending ? t("trackers.jira.settings.disconnect.running") : t("trackers.jira.settings.disconnect.action")}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  title={t("trackers.jira.settings.disconnect.confirmTitle", { name: detail.name })}
                  body={confirmBody}
                  cancel={t("common.cancel")}
                  action={t("trackers.jira.settings.disconnect.action")}
                  onAction={disconnect.run}
                />
              </AlertDialog>
            </li>
          </ul>
          {disconnect.error === null ? null : (
            <p role="alert" className="mt-2 text-sm text-red">
              {disconnect.error}
            </p>
          )}
        </Section>
      )}
    </>
  );
};

/** The properties panel: the site, its scopes, the webhook's events and the boards on it. */
export const JiraSettingsPanel = ({ detail, canManage }: { readonly detail: JiraDetail; readonly canManage: boolean }) => {
  const jira = detail.jira;
  return (
    <div data-testid="jira-settings-panel">
      <div className="flex items-center gap-3">
        <TrackerMark kind="jira" size={trackerMarkAt.trackerPanelHead.size} label={false} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-text">{detail.name}</div>
          <div className="mt-px truncate font-mono text-[12.5px] text-muted">{detail.site ?? ""}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-3.5">
        <PanelLabel>{t("trackers.jira.settings.panel.site")}</PanelLabel>
        <PropRow label={t("trackers.jira.settings.panel.site")}><span className="truncate font-mono text-[13.5px]">{detail.site ?? "–"}</span></PropRow>
        <PropRow label={t("trackers.jira.settings.panel.cloudId")}><span className="truncate font-mono text-[13.5px]">{jira.cloudId ?? "–"}</span></PropRow>
        <PropRow label={t("trackers.jira.settings.panel.product")}><span>{t("trackers.jira.settings.panel.jiraCloud")}</span></PropRow>
        <PropRow label={t("trackers.jira.settings.panel.workflows")}>
          <span className={cn(jira.workflowsReadable === false && "text-muted")}>
            {jira.workflowsReadable === null ? "–" : jira.workflowsReadable ? t("trackers.jira.settings.panel.readable") : t("trackers.jira.settings.panel.notReadable")}
          </span>
        </PropRow>
      </div>
      {!canManage ? null : (
        <>
          <Sep />
          <PanelLabel count={jira.scopes.length}>{t("trackers.jira.settings.panel.scopes")}</PanelLabel>
          <ul data-testid="jira-scopes">
            {jira.neededScopes.map((scope) => {
              const granted = jira.scopes.includes(scope);
              return (
                <li key={scope} className="flex h-[26px] items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-ui text-muted">{scope}</span>
                  {granted ? (
                    <CheckIcon aria-hidden className="size-[13px] stroke-[1.75] text-faint" />
                  ) : (
                    <CircleXIcon aria-label={t("trackers.jira.settings.panel.missing", { scope })} className="size-[13px] stroke-[1.75] text-red" />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Sep />
      <PanelLabel count={jira.webhookEvents.length}>{t("trackers.jira.settings.panel.webhookEvents")}</PanelLabel>
      <ul>
        {jira.webhookEvents.map((event) => (
          <li key={event} className="flex h-[26px] items-center font-mono text-ui text-muted">
            {eventWord(event)}
          </li>
        ))}
      </ul>
      <Sep />
      <PanelLabel count={detail.boards.length}>{t("trackers.jira.settings.panel.boards")}</PanelLabel>
      <ConnectionBoards boards={detail.boards} />
    </div>
  );
};

/** A Jira connection's page: the frame, the header with its rename, the sections and the panel. */
export const JiraSettingsPage = ({ detail, canManage, now }: { readonly detail: JiraDetail; readonly canManage: boolean; readonly now: number }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const [secret, setSecret] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ readBack: JiraReadBack | null; verdict: JiraVerdict | null }>({ readBack: null, verdict: null });
  const [rechecked, setRechecked] = useState<{ readBack: JiraReadBack | null; verdict: JiraVerdict | null }>({ readBack: null, verdict: null });
  const me = useQuery(trpc.me.get.queryOptions());
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.trackers.pathKey() });

  const rotate = useMutation(
    trpc.trackers.jira.rotateSecret.mutationOptions({
      onSuccess: (result) => {
        setSecret(result.secret);
        void refresh();
      },
    }),
  );
  const check = useMutation(trpc.trackers.jira.checkToken.mutationOptions({ onSuccess: (result) => { setChecked({ readBack: result.readBack, verdict: result.verdict }); } }));
  const replace = useMutation(
    trpc.trackers.jira.replaceToken.mutationOptions({
      onSuccess: (result) => {
        if (result.ok) {
          setChecked({ readBack: null, verdict: null });
          void refresh();
        }
      },
    }),
  );
  const recheck = useMutation(
    trpc.trackers.jira.recheck.mutationOptions({
      onSuccess: (result) => {
        setRechecked({ readBack: result.readBack, verdict: result.verdict });
        void refresh();
      },
    }),
  );
  const disconnect = useMutation(
    trpc.trackers.disconnect.mutationOptions({
      onSuccess: () => {
        void refresh();
        router.push("/organization/trackers");
      },
    }),
  );
  const connectionId = detail.id;
  const token: JiraTokenOps = {
    check: {
      run: (values) => { check.mutate({ connectionId, ...values }); },
      pending: check.isPending,
      error: errorText(check.error),
      readBack: checked.readBack,
      verdict: checked.verdict,
    },
    save: {
      run: (values) => { replace.mutate({ connectionId, ...values }); },
      pending: replace.isPending,
      error: errorText(replace.error),
    },
    recheck: {
      run: () => { recheck.mutate({ connectionId }); },
      pending: recheck.isPending,
      error: errorText(recheck.error),
      readBack: rechecked.readBack,
      verdict: rechecked.verdict,
    },
    reset: () => { setChecked({ readBack: null, verdict: null }); },
  };

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: detail.name }]}
      actions={
        detail.site === null ? undefined : (
          <a href={`https://${detail.site}`} target="_blank" rel="noopener noreferrer" className={buttonVariants()} data-testid="open-in-jira">
            <ExternalLinkIcon className="stroke-[1.75]" />
            {t("trackers.jira.settings.openInJira")}
          </a>
        )
      }
      properties={<JiraSettingsPanel detail={detail} canManage={canManage} />}
    >
      <ConnectionHeader connectionId={connectionId} kind="jira" name={detail.name} site={detail.site} lede={canManage ? t("trackers.jira.connect.lede") : t("trackers.memberPage.lede")} admin={canManage} />
      <JiraSettingsBody
        detail={detail}
        now={now}
        canManage={canManage}
        justConnected={params.get("connected") === "1"}
        rotate={{ run: () => { rotate.mutate({ connectionId }); }, pending: rotate.isPending, error: errorText(rotate.error), secret }}
        token={token}
        disconnect={{ run: () => { disconnect.mutate({ id: connectionId }); }, pending: disconnect.isPending, error: errorText(disconnect.error) }}
      />
    </PageFrame>
  );
};
