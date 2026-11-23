"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, RadioTowerIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ConnectionId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { Step, SiteForm, TokenDone, TokenForm } from "./jira-steps";
import type { SiteValues, StepAct, TokenValues } from "./jira-steps";
import { WebhookStep } from "./jira-webhook-step";
import { addressProblemWord, clockOf, eventWord, isPlaceholderJiraName, jiraSteps, scopeWord, siteRefusal, stepState } from "./jira-words";
import type { JiraDetail, JiraReadBack, JiraVerdict, SiteRefusal } from "./jira-words";
import { TrackerMark } from "../tracker-mark";

// Connecting Jira, step by step (F-008, F-152; app-targets/m11-trackers/jira-connect.md): a pending
// connection's page at `/organization/trackers/<id>`. The header with its mark, the lede, the
// started line and `Start again`, `Connect Jira` and the done count, then the three checked steps:
// the site (`trackers.jira.findSite`), the service account's scoped token (`checkToken`,
// `saveToken`), and the admin webhook (`webhook`, every 3 s) or polling (`finishPolling`). The
// properties panel is what ostra asks of Jira. An admin's only: a member never sees a step, a URL
// or a secret. Once it's active, ticket 14's settings take the page; this draws the target's
// connected row, with `Just connected` while the first delivery is fresh.

/** How long `Just connected` stays after the first delivery (the target's own `connected` row). */
const JUST_CONNECTED_MS = 10 * 60_000;

/** The page's header: the 36px mark, `Jira Cloud · connecting`, the name, and the lede. */
const Header = ({ detail }: { readonly detail: JiraDetail }) => (
  <div className="flex items-start gap-3.5 max-sm:gap-3">
    <TrackerMark kind="jira" size={36} label={false} className="mt-[3px] max-sm:mt-[2px]" />
    <div className="min-w-0 flex-1">
      <PageHeading eyebrow={t("trackers.jira.connect.eyebrow")} title={detail.name} lede={t("trackers.jira.connect.lede")} />
    </div>
  </div>
);

/** The counts the panel's groups carry (`4`, `6`, `3`), in the target's faint mono. */
const Count = ({ n }: { readonly n: number }) => <span className="ml-1 font-mono text-[11.5px] font-normal text-faint">{n}</span>;

/** The properties panel: Mode, The token needs, Webhook events, It sees (jira-connect.md, "Layout"). */
const JiraPanel = ({ detail, polling, events }: { readonly detail: JiraDetail; readonly polling: boolean; readonly events: readonly string[] }) => {
  const projects = detail.jira.reach?.projects ?? [];
  const reason = detail.jira.modeReason;
  return (
    <div data-testid="jira-connect-panel">
      <PropGroup title={t("trackers.jira.connect.panel.mode")}>
        <PropRow label={t("trackers.jira.connect.panel.events")}>
          {polling ? <RefreshCwIcon aria-hidden className="stroke-[1.75]" /> : <RadioTowerIcon aria-hidden className="stroke-[1.75]" />}
          {polling ? t("trackers.jira.connect.panel.polling", { seconds: detail.jira.pollSeconds }) : t("trackers.jira.connect.panel.webhooks")}
        </PropRow>
        <p className="mt-1 text-[12.5px] leading-normal text-faint">
          {polling
            ? reason === null
              ? t("trackers.jira.connect.panel.pollingHelpNoReason")
              : t("trackers.jira.connect.panel.pollingHelp", { reason: addressProblemWord(reason) })
            : t("trackers.jira.connect.panel.webhooksHelp", { minutes: detail.jira.reconcileMinutes })}
        </p>
      </PropGroup>
      <PropGroup
        title={
          <>
            {t("trackers.jira.connect.panel.needs")}
            <Count n={detail.jira.neededScopes.length} />
          </>
        }
      >
        {detail.jira.neededScopes.map((scope) => (
          <div key={scope} className="flex items-baseline justify-between gap-3 py-[3px]">
            <code className="font-mono text-[12px] text-text-2">{scope}</code>
            <span className="min-w-0 truncate text-[12px] text-faint">{scopeWord(scope)}</span>
          </div>
        ))}
      </PropGroup>
      {polling ? null : (
        <PropGroup
          title={
            <>
              {t("trackers.jira.connect.panel.webhookEvents")}
              <Count n={events.length} />
            </>
          }
        >
          {events.map((event) => (
            <div key={event} className="py-[3px] text-[13px] text-text-2">
              {eventWord(event)}
            </div>
          ))}
        </PropGroup>
      )}
      <PropGroup
        title={
          <>
            {t("trackers.jira.connect.panel.sees")}
            {projects.length === 0 ? null : <Count n={projects.length} />}
          </>
        }
      >
        {projects.length === 0 ? (
          <p className="text-[12.5px] leading-normal text-faint">{t("trackers.jira.connect.panel.seesNotYet")}</p>
        ) : (
          <>
            {projects.map((project) => (
              <div key={project.id} className="flex items-baseline gap-2 py-[3px]">
                <code className="font-mono text-[12px] text-text-2">{project.key}</code>
                <span className="min-w-0 truncate text-[13px] text-muted">{project.name}</span>
              </div>
            ))}
            <p className="mt-1 text-[12.5px] leading-normal text-faint">{t("trackers.jira.connect.panel.seesHelp")}</p>
          </>
        )}
      </PropGroup>
    </div>
  );
};

/** The started line: when and by whom, and `Start again`, which ends the pending connection and makes a fresh one. */
const Started = ({ at, name, again }: { readonly at: number; readonly name: string | null; readonly again: StepAct<void> }) => (
  <p className="mt-3 text-[13px] text-faint">
    {name === null ? t("trackers.jira.connect.startedNoName", { at: clockOf(at) }) : t("trackers.jira.connect.started", { at: clockOf(at), name })}
    <span aria-hidden> · </span>
    <button type="button" disabled={again.pending} onClick={() => { again.run(); }} data-testid="jira-start-again" className="text-teal hover:underline disabled:opacity-50">
      {t("trackers.jira.connect.startAgain")}
    </button>
    {again.error === null ? null : <span role="alert" className="ml-2 text-red">{again.error}</span>}
  </p>
);

/** A connection that isn't pending: the target's connected row, which ticket 14's settings grow. */
const Connected = ({ detail, justConnected }: { readonly detail: JiraDetail; readonly justConnected: boolean }) => (
  <section className="mt-[26px]">
    <div className="mb-1 flex h-[30px] items-center">
      <h2 className="text-body font-semibold">{t("trackers.jira.connect.connected.title")}</h2>
    </div>
    <div data-testid="jira-connected" className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-y border-line py-2.5 text-body">
      <span className={cn("inline-flex items-center gap-1.5 font-medium", detail.state === "failed" ? "text-red" : "text-green")}>
        <span aria-hidden className={cn("size-[7px] rounded-full", detail.state === "failed" ? "bg-red" : "bg-green")} />
        {detail.state === "failed" ? t("trackers.jira.connect.connected.failed") : t("trackers.jira.connect.connected.connected")}
      </span>
      {detail.site === null ? null : <code className="font-mono text-[12.5px] text-muted">{detail.site}</code>}
      {justConnected ? (
        <span className="ml-auto inline-flex items-center gap-1.5 text-ui text-text-2">
          <CheckIcon aria-hidden className="size-[14px] stroke-2 text-green" />
          {t("trackers.jira.connect.connected.justConnected")}
        </span>
      ) : null}
    </div>
  </section>
);

/**
 * A pending Jira connection's page. Admin only (`ConnectionPage` keeps a member on the list's
 * detail): the three steps, each checking itself before the next opens, and the panel's Mode,
 * scopes, events and projects.
 */
export const JiraConnect = ({ connectionId }: { readonly connectionId: ConnectionId }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mounted] = useState(() => Date.now());
  const [reopened, setReopened] = useState<1 | 2 | null>(null);
  const [refusal, setRefusal] = useState<SiteRefusal | null>(null);
  const [readBack, setReadBack] = useState<JiraReadBack | null>(null);
  const [verdict, setVerdict] = useState<JiraVerdict | null>(null);

  const me = useQuery(trpc.me.get.queryOptions());
  const detailQuery = useQuery({
    ...trpc.trackers.get.queryOptions({ id: connectionId }),
    refetchInterval: (query) => (query.state.data?.state === "pending" ? 3000 : false),
  });
  const detail = detailQuery.data?.kind === "jira" ? detailQuery.data : null;
  const now = detailQuery.dataUpdatedAt === 0 ? mounted : detailQuery.dataUpdatedAt;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.trackers.pathKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
  };

  const findSite = useMutation(trpc.trackers.jira.findSite.mutationOptions());
  const checkToken = useMutation(trpc.trackers.jira.checkToken.mutationOptions());
  const saveToken = useMutation(trpc.trackers.jira.saveToken.mutationOptions());
  const finishPolling = useMutation(trpc.trackers.jira.finishPolling.mutationOptions());
  const rotateSecret = useMutation(trpc.trackers.jira.rotateSecret.mutationOptions());
  const disconnect = useMutation(trpc.trackers.disconnect.mutationOptions());
  const create = useMutation(trpc.trackers.create.mutationOptions());

  const steps = detail === null ? null : jiraSteps(detail, reopened);
  const webhook = useQuery({
    ...trpc.trackers.jira.webhook.queryOptions({ connectionId }),
    enabled: detail?.state === "pending" && steps?.current === 3,
    refetchInterval: 3000,
  });

  const crumbs = [{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title"), href: "/organization/trackers" }, { label: detail?.name ?? t("trackers.title") }];
  if (detail === null) {
    return (
      <PageFrame crumbs={crumbs}>
        {detailQuery.isError ? <p role="alert" className="mt-6 text-sm text-red">{errorText(detailQuery.error)}</p> : <SkeletonRows rows={3} />}
      </PageFrame>
    );
  }

  const events = detail.jira.webhookEvents;
  const polling = (webhook.data?.webhook.mode ?? detail.webhookMode) === "polling";
  const justConnected = detail.state === "active" && detail.jira.activatedAt !== null && now - detail.jira.activatedAt < JUST_CONNECTED_MS;
  const header = <Header detail={detail} />;

  if (detail.state !== "pending") {
    return (
      <PageFrame crumbs={crumbs} properties={<JiraPanel detail={detail} polling={polling} events={events} />}>
        {header}
        <Connected detail={detail} justConnected={justConnected} />
      </PageFrame>
    );
  }

  const siteStep = steps ?? { site: false, token: false, current: 1 as const, done: 0 as const };
  const siteAct: StepAct<SiteValues> = {
    run: ({ site, name }) => {
      findSite.mutate(
        { connectionId, site, name },
        {
          onSuccess: (result, variables) => {
            if (result.ok) {
              setRefusal(null);
              setReopened(null);
              void refresh();
            } else {
              setRefusal(siteRefusal(result, variables.site, variables.name ?? ""));
            }
          },
        },
      );
    },
    pending: findSite.isPending,
    error: errorText(findSite.error),
  };
  const tokenAct: StepAct<TokenValues> = {
    run: ({ email, token, expiresOn }) => {
      checkToken.mutate(
        { connectionId, email, token, expiresOn },
        {
          onSuccess: (result) => {
            setReadBack(result.readBack);
            setVerdict(result.verdict);
          },
        },
      );
    },
    pending: checkToken.isPending,
    error: null,
  };
  const saveFailure = saveToken.data !== undefined && !saveToken.data.ok ? saveToken.data.message : null;
  const saveAct: StepAct<TokenValues> = {
    run: ({ email, token, expiresOn }) => {
      saveToken.mutate(
        { connectionId, email, token, expiresOn },
        {
          onSuccess: (result) => {
            if (result.ok) {
              setReadBack(null);
              setVerdict(null);
              setReopened(null);
              void refresh();
            } else if (result.error === "token-failed") {
              setReadBack(result.readBack);
              setVerdict("fail");
            }
          },
        },
      );
    },
    pending: saveToken.isPending,
    error: saveFailure ?? errorText(saveToken.error),
  };
  const finishAct: StepAct<void> = {
    run: () => {
      finishPolling.mutate({ connectionId }, { onSuccess: () => { void refresh(); } });
    },
    pending: finishPolling.isPending,
    error: errorText(finishPolling.error),
  };
  const rotateAct: StepAct<void> = {
    run: () => {
      rotateSecret.mutate({ connectionId }, { onSuccess: () => { void webhook.refetch(); } });
    },
    pending: rotateSecret.isPending,
    error: errorText(rotateSecret.error),
  };
  const againAct: StepAct<void> = {
    run: () => {
      disconnect.mutate(
        { id: connectionId },
        {
          onSuccess: () => {
            create.mutate({ kind: "jira" }, { onSuccess: (made) => { router.replace(`/organization/trackers/${made.connectionId}`); } });
          },
        },
      );
    },
    pending: disconnect.isPending || create.isPending,
    error: errorText(disconnect.error) ?? errorText(create.error),
  };

  const keys = detail.jira.reach?.projects.map((project) => project.key) ?? [];
  const step3State = stepState(3, siteStep.current);
  const [tokenBefore = "", tokenAfter = ""] = t("trackers.jira.connect.step2.body").split("{path}");

  return (
    <PageFrame crumbs={crumbs} properties={<JiraPanel detail={detail} polling={polling} events={events} />}>
      {header}
      <Started at={detail.jira.startedAt} name={detail.jira.startedByName} again={againAct} />
      <section className="mt-[22px]">
        <div className="mb-1 flex h-[30px] items-center gap-2">
          <h2 className="text-body font-semibold">{t("trackers.jira.connect.title")}</h2>
          <span data-testid="jira-done-count" className="font-mono text-[12.5px] text-faint">
            {t("trackers.jira.connect.doneCount", { done: siteStep.done })}
          </span>
        </div>
        <ol aria-label={t("trackers.jira.connect.steps")} className="border-t border-line">
          {siteStep.site ? (
            <Step
              n={1}
              state="done"
              title={t("trackers.jira.connect.step1.title")}
              {...(detail.site === null ? {} : { value: detail.site })}
              link={
                <button
                  type="button"
                  data-testid="jira-site-change"
                  onClick={() => {
                    setReopened(1);
                    setReadBack(null);
                    setVerdict(null);
                  }}
                  className="ml-auto shrink-0 text-[13.5px] font-normal text-teal hover:underline"
                >
                  {t("trackers.jira.connect.step1.change")}
                </button>
              }
              body={t("trackers.jira.connect.step1.done", { name: detail.name })}
            />
          ) : (
            <Step n={1} state="current" title={t("trackers.jira.connect.step1.title")} body={t("trackers.jira.connect.step1.body")}>
              <SiteForm
                site={detail.site?.replace(/\.atlassian\.net$/, "") ?? ""}
                name={detail.name === "" || isPlaceholderJiraName(detail.name) ? null : detail.name}
                act={siteAct}
                refusal={refusal}
                focus
              />
            </Step>
          )}
          {siteStep.current < 2 ? (
            <Step n={2} state="later" title={t("trackers.jira.connect.step2.title")} />
          ) : siteStep.token ? (
            <Step
              n={2}
              state="done"
              title={t("trackers.jira.connect.step2.title")}
              link={
                <button
                  type="button"
                  data-testid="jira-token-replace"
                  onClick={() => {
                    setReopened(2);
                    setReadBack(null);
                    setVerdict(null);
                  }}
                  className="ml-auto shrink-0 text-[13.5px] font-normal text-teal hover:underline"
                >
                  {t("trackers.jira.connect.step2.replace")}
                </button>
              }
              body={<TokenDone detail={detail} />}
            />
          ) : (
            <Step
              n={2}
              state="current"
              title={t("trackers.jira.connect.step2.title")}
              link={
                <a href="https://admin.atlassian.com" target="_blank" rel="noopener noreferrer" className="ml-auto shrink-0 text-[13.5px] font-normal text-teal hover:underline max-sm:hidden">
                  {t("trackers.jira.connect.step2.link")}
                </a>
              }
            >
              <p className="mt-0.5 max-w-[600px] text-[13.5px] leading-normal text-muted max-sm:text-ui [&_b]:font-medium [&_b]:text-text">
                {tokenBefore}
                <b>{t("trackers.jira.connect.step2.path")}</b>
                {tokenAfter}
              </p>
              <TokenForm
                email={detail.jira.email ?? ""}
                scopes={[...detail.jira.neededScopes]}
                check={tokenAct}
                save={saveAct}
                readBack={readBack}
                verdict={verdict}
                onEdit={() => {
                  setReadBack(null);
                  setVerdict(null);
                }}
                now={now}
                focus
              />
            </Step>
          )}
          <WebhookStep
            state={step3State}
            name={detail.name}
            mode={detail.webhookMode}
            webhook={webhook.data?.webhook}
            keys={keys}
            pollSeconds={detail.jira.pollSeconds}
            webhooksPage={detail.jira.webhooksPage}
            finish={finishAct}
            rotate={rotateAct}
            error={errorText(webhook.error)}
          />
        </ol>
      </section>
    </PageFrame>
  );
};
