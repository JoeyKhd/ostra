"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, FlaskConicalIcon, GitBranchIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge, formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { AttachmentThumb } from "@/components/tasks/attachments/attachment-thumb";
import { thumbName } from "@/components/tasks/attachments/attachment-words";

import { readyWords } from "./environment-app-words";
import { agoText, changesOf, decidedOf, editedProposal, lineDiff, taskStateWords } from "./proposal-words";
import type { Decided, DiffRow, Onboarding, ProposalView } from "./proposal-words";

// The environment page's Proposal tab (app-targets/m6/environment-proposal.md; F-113, ticket 36):
// the onboarding task's line, then its proposal as a diff per repo against the environment as
// saved (the setup script, the checks, the variable names it needs, then the services), the
// agent's notes, and a project admin's decision: Accept, Edit and accept, or Reject. Values never
// show: the proposal holds names only. The scripts and notes are the agent's words: plain text.

const SIGN_TONE = { "+": "bg-diff-add text-green", "-": "bg-diff-del text-red", " ": "text-faint", "~": "text-muted" } as const;

const Part = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="mt-3">
    <p className="mb-2 text-xs font-medium text-faint">{label}</p>
    {children}
  </div>
);

const ScriptDiff = ({ rows }: { readonly rows: readonly DiffRow[] }) => (
  <div className="max-h-[320px] overflow-auto rounded-[7px] border border-line bg-surface font-mono text-[12.5px]" data-testid="script-diff">
    {rows.map((row, index) =>
      row.sign === "fold" ? (
        <div key={index} className="flex h-5 items-center px-3 text-xs text-faint">{t("proposal.unchanged", { n: row.lines })}</div>
      ) : (
        <div key={index} className={cn("grid min-h-5 grid-cols-[20px_minmax(0,1fr)] items-center whitespace-pre pr-3", row.sign === "+" ? "bg-diff-add" : row.sign === "-" ? "bg-diff-del" : "")} data-sign={row.sign}>
          <span className={cn("text-center", row.sign === "+" ? "text-green" : row.sign === "-" ? "text-red" : "text-faint")}>{row.sign === "-" ? "−" : row.sign}</span>
          <span className="text-text">{row.text}</span>
        </div>
      ),
    )}
  </div>
);

const RowsBlock = ({ children }: { readonly children: ReactNode }) => <div className="overflow-x-auto rounded-[7px] border border-line bg-surface">{children}</div>;

const SignedRow = ({ sign, children, testid }: { readonly sign: "+" | "-" | "~"; readonly children: ReactNode; readonly testid?: string }) => (
  <div className={cn("grid min-h-9 grid-cols-[20px_minmax(0,1fr)] items-center gap-x-1 py-1 pr-3", sign === "+" ? "bg-diff-add" : sign === "-" ? "bg-diff-del" : "")} {...(testid === undefined ? {} : { "data-testid": testid })}>
    <span className={cn("text-center font-mono text-[12.5px]", SIGN_TONE[sign])}>{sign === "-" ? "−" : sign}</span>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">{children}</div>
  </div>
);

const RepoBlock = ({ repo, editing, edit, onEdit }: {
  readonly repo: ProposalView["repos"][number];
  readonly editing: boolean;
  readonly edit: { readonly setupScript: string; readonly commands: ReadonlyMap<string, string> } | undefined;
  readonly onEdit: (next: { readonly setupScript: string; readonly commands: ReadonlyMap<string, string> }) => void;
}) => {
  const changes = changesOf(repo);
  const current = edit ?? { setupScript: repo.setupScript.proposed ?? "", commands: new Map<string, string>() };
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0" data-repo={repo.repo ?? repo.repoId}>
      <h3 className="flex h-8 items-center gap-2">
        <span className="font-mono text-[14px] font-medium text-text">{repo.repo ?? repo.repoId}</span>
        <span className="text-sm text-faint">{changes === 0 && !editing ? t("proposal.noChanges") : t("proposal.changes", { n: changes })}</span>
      </h3>
      {editing ? (
        <Part label={t("proposal.setupScript")}>
          <Textarea
            aria-label={t("proposal.editScript", { repo: repo.repo ?? "" })}
            className="border-l-2 border-l-teal font-mono text-[12.5px] [field-sizing:content]"
            value={current.setupScript}
            onChange={(event) => { onEdit({ ...current, setupScript: event.target.value }); }}
          />
        </Part>
      ) : repo.setupScript.changed ? (
        <Part label={t("proposal.setupScript")}><ScriptDiff rows={lineDiff(repo.setupScript.current, repo.setupScript.proposed)} /></Part>
      ) : null}
      {repo.checks.added.length + repo.checks.changed.length === 0 ? null : (
        <Part label={t("proposal.checks")}>
          <RowsBlock>
            {repo.checks.added.map((check) => (
              <SignedRow key={check.name} sign="+" testid="proposal-check">
                <span className="font-mono text-[13px] text-text">{check.name}</span>
                {editing ? (
                  <Input
                    aria-label={t("proposal.editCommand", { check: check.name })}
                    className="h-[28px] min-w-[200px] flex-1 font-mono text-[12.5px]"
                    value={current.commands.get(check.name) ?? check.command}
                    onChange={(event) => { onEdit({ ...current, commands: new Map([...current.commands, [check.name, event.target.value]]) }); }}
                  />
                ) : (
                  <span className="font-mono text-[12.5px] text-muted">{check.command}</span>
                )}
                <span className="ml-auto font-mono text-[12.5px] text-faint">{t("proposal.timeout", { s: check.timeoutSeconds })}</span>
              </SignedRow>
            ))}
            {repo.checks.changed.map((check) => (
              <SignedRow key={check.name} sign="~" testid="proposal-check">
                <span className="font-mono text-[13px] text-text">{check.name}</span>
                <span className="flex min-w-0 flex-col">
                  <s className="font-mono text-[12.5px] text-faint">{check.current.command}</s>
                  <span className="font-mono text-[12.5px] text-muted">{check.proposed.command}</span>
                </span>
                <span className="ml-auto font-mono text-[12.5px] text-faint">{t("proposal.timeout", { s: check.proposed.timeoutSeconds })}</span>
              </SignedRow>
            ))}
          </RowsBlock>
        </Part>
      )}
      {repo.variableNames.missing.length === 0 ? null : (
        <Part label={t("proposal.variables")}>
          <RowsBlock>
            {repo.variableNames.missing.map((name) => (
              <SignedRow key={name} sign="+" testid="proposal-variable">
                <span className="font-mono text-[13px] text-text">{name}</span>
                <span className="flex items-center gap-1 text-sm text-faint"><LockIcon aria-hidden className="size-3" />{t("proposal.nameOnly")}</span>
              </SignedRow>
            ))}
          </RowsBlock>
        </Part>
      )}
    </section>
  );
};

/**
 * Milestone 8 (F-140, F-113): the proposal's app processes, against the environment's list while
 * it's open (`+` added, `~` changed), who kept it from a task, and the onboarding task's screenshot
 * of the primary it started. "Accept" writes each in place of the one of its name or port.
 */
const AppProcessesBlock = ({ data, projectId }: { readonly data: ProposalView; readonly projectId: ProjectId }) => {
  const router = useRouter();
  const { proposed, diff } = data.appProcesses;
  if (proposed.length === 0) return null;
  const signOf = (name: string): "+" | "~" | null =>
    diff === null || diff.added.some((one) => one.name === name) ? "+" : diff.changed.some((one) => one.name === name) ? "~" : null;
  const rows = proposed.flatMap((process) => {
    const sign = signOf(process.name);
    return sign === null ? [] : [{ sign, process }];
  });
  const shot = data.screenshot;
  return (
    <section className="border-t border-line pt-4" data-testid="proposal-app">
      <h3 className="text-[14px] font-semibold text-text">
        {t("proposal.app.title")}
        <span className="text-sm font-normal text-faint"> {data.source === "kept" ? t("proposal.app.kept", { name: data.keptBy?.name ?? t("environment.app.someone") }) : t("proposal.app.order")}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-faint">{t("proposal.noChanges")}</p>
      ) : (
        <div className="mt-2">
          <RowsBlock>
            {rows.map(({ sign, process }) => {
              const ready = readyWords(process.ready);
              return (
                <SignedRow key={process.name} sign={sign} testid="proposal-process">
                  <span className="font-mono text-[13px] text-text">{process.name}</span>
                  <span className="text-sm text-muted">{process.label}</span>
                  {process.primary ? <span className="inline-flex h-5 items-center rounded-[5px] border border-line-2 px-1.5 text-xs text-muted">{t("environment.app.primary")}</span> : null}
                  <span className="font-mono text-[12.5px] text-text">{process.port}</span>
                  <span className="text-[12.5px] text-muted">{ready.words}{ready.mono === null ? null : <span className="ml-1 font-mono text-text">{ready.mono}</span>}</span>
                  <span className="basis-full truncate font-mono text-[12.5px] text-faint">{process.folder === "." ? process.command : `${process.folder} · ${process.command}`}</span>
                </SignedRow>
              );
            })}
          </RowsBlock>
        </div>
      )}
      {data.waitsForCommand === null ? null : (
        <p className="mt-2 text-sm text-muted" data-testid="proposal-waits">
          {t("proposal.app.waits", { name: data.waitsForCommand })}{" "}
          <Link href={`/projects/${projectId}/environment?tab=app`} className="text-teal hover:underline">{t("proposal.app.review")}</Link>
        </p>
      )}
      {shot === null ? null : (
        <div className="mt-3" data-testid="proposal-screenshot">
          <p className="mb-1.5 text-xs font-medium text-faint">{t("proposal.app.screenshot")}</p>
          <AttachmentThumb
            view={shot}
            size={{ width: shot.width, height: shot.height, kind: shot.kind, durationMs: shot.durationMs }}
            height={110}
            caption={`${String(shot.width)} · ${shot.path}`}
            name={thumbName({ kind: shot.kind, path: shot.path, width: shot.width, at: shot.createdAt })}
            onOpen={() => { router.push(`/tasks/${shot.taskId}?attachment=${encodeURIComponent(shot.attachmentId)}`); }}
          />
        </div>
      )}
    </section>
  );
};

/** What a project admin decided: `Accepted as version 5.` with `Open Setup`, or `Rejected.` */
const DecidedLine = ({ decided, projectId, className }: { readonly decided: Decided; readonly projectId: ProjectId; readonly className?: string }) => (
  <p className={cn("flex items-center gap-1.5 text-sm text-green", className)} role="status" data-testid="proposal-decided">
    {decided.kind === "accepted" ? (
      <>
        <CheckIcon aria-hidden className="size-[14px]" />
        {decided.version === null ? t("proposal.acceptedNoVersion") : t("proposal.accepted", { n: decided.version })}{" "}
        <Link href={`/projects/${projectId}/environment`} className="text-teal hover:underline">{t("proposal.openSetup")}</Link>
      </>
    ) : (
      <span className="text-muted">{t("proposal.rejected")}</span>
    )}
  </p>
);

/** The onboarding task's line: its key and title, its state, and its AGENTS.md PRs. */
const TaskLine = ({ onboarding, now }: { readonly onboarding: Onboarding; readonly now: number }) => {
  const task = onboarding.task;
  if (task === null) return null;
  return (
    <div className="mt-4" data-testid="onboarding-line" data-open={task.open ? "true" : "false"}>
      <p className="flex min-h-9 flex-wrap items-center gap-x-2 text-ui">
        <GitBranchIcon aria-hidden className="size-[15px] text-faint" />
        <Link href={`/tasks/${task.taskId}`} className="font-mono text-teal hover:underline">{task.key}</Link>
        <span className="text-text">{task.title}</span>
        <span aria-hidden className="text-faint">·</span>
        <span className="flex items-center gap-1.5 text-sm text-muted">
          {task.open && task.state !== "needs_you" ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin" /> : null}
          {taskStateWords(task, task.open ? formatElapsed(task.startedAt, now) : formatAge(task.updatedAt, now))}
        </span>
        {task.prs.length === 0 ? null : (
          <>
            <span aria-hidden className="text-faint">·</span>
            {task.prs.map((pr) => (
              <a key={pr.url} href={safeHref(pr.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-teal hover:underline" data-testid="agents-pr">
                {t("proposal.agentsPr", { n: pr.number })} <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            ))}
          </>
        )}
      </p>
      {task.open && task.state !== "needs_you" ? (
        <p className="mt-1 text-sm text-muted">
          {t("proposal.runningNote")} <Link href={`/tasks/${task.taskId}`} className="text-teal hover:underline">{t("proposal.watch")}</Link>
        </p>
      ) : null}
    </div>
  );
};

/** "Test this environment": a project admin's, while no onboarding task is open and no proposal waits. */
export const TestEnvironmentButton = ({ projectId, onboarding, onStarted, onError }: {
  readonly projectId: ProjectId;
  readonly onboarding: Onboarding | undefined;
  readonly onStarted: () => void;
  /** A refusal (no model, the spend cap) shows in the page, under the top bar. */
  readonly onError: (message: string | null) => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const start = useMutation(
    trpc.environments.startOnboarding.mutationOptions({
      onMutate: () => { onError(null); },
      onSuccess: onStarted,
      onError: (error) => { onError(errorText(error) ?? t("errors.unknown")); },
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.environments.onboarding.queryKey({ projectId }) }),
    }),
  );
  if (onboarding?.isAdmin !== true) return null;
  const button = (
    <Button disabled={!onboarding.canStart || start.isPending} onClick={() => { start.mutate({ projectId }); }} data-action="test-environment">
      <FlaskConicalIcon aria-hidden /> <span className="max-sm:sr-only">{start.isPending ? t("proposal.starting") : t("proposal.test")}</span>
    </Button>
  );
  return onboarding.canStart ? button : <Tooltip content={onboarding.task?.open === true ? t("proposal.stillTesting", { key: onboarding.task.key }) : t("proposal.waiting")}><span>{button}</span></Tooltip>;
};

/** The panel's groups on the Proposal tab: the proposal, the AGENTS.md PRs, and what wasn't committed. */
export const ProposalProperties = ({ proposal, onboarding, now }: { readonly proposal: ProposalView | null; readonly onboarding: Onboarding | undefined; readonly now: number }) => (
  <div data-testid="proposal-properties">
    <PropGroup title={t("proposal.panel.proposal")}>
      <PropRow label={t("proposal.panel.state")} labelWidth={120}>
        <span>
          {proposal?.decision?.kind === "accepted"
            ? proposal.decision.version === null
              ? t("proposal.panel.acceptedNoVersion")
              : t("proposal.panel.accepted", { n: proposal.decision.version })
            : proposal?.decision?.kind === "rejected"
              ? t("proposal.panel.rejected")
              : proposal !== null
                ? t("proposal.panel.proposed")
                : onboarding?.task?.open === true
                  ? t("proposal.panel.running")
                  : t("proposal.panel.none")}
        </span>
      </PropRow>
      {onboarding?.task === null || onboarding?.task === undefined ? null : (
        <PropRow label={t("proposal.panel.task")} labelWidth={120}><Link href={`/tasks/${onboarding.task.taskId}`} className="font-mono text-teal hover:underline">{onboarding.task.key}</Link></PropRow>
      )}
      {proposal === null ? null : (
        <>
          <PropRow label={t("proposal.panel.scan")} labelWidth={120}><span aria-hidden className="size-[7px] rounded-full bg-green" /><span>{t("proposal.panel.noValues")}</span></PropRow>
          <PropRow label={t("proposal.panel.proposedAt")} labelWidth={120}><span>{agoText(proposal.createdAt, now)}</span></PropRow>
        </>
      )}
    </PropGroup>
    {onboarding?.task === null || onboarding?.task === undefined ? null : (
      <PropGroup title={t("proposal.panel.agents")}>
        {onboarding.task.prs.length === 0 ? (
          <p className="text-sm text-faint">{t("proposal.panel.noAgentsPr")}</p>
        ) : (
          onboarding.task.prs.map((pr) => (
            <PropRow key={pr.url} label={pr.repo.split("/").at(-1) ?? pr.repo} labelWidth={120} labelClassName="font-mono">
              <a href={safeHref(pr.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.number}</a>
              <span className="text-muted">· {pr.state === "merged" ? t("proposal.panel.merged") : pr.state === "closed_unmerged" ? t("proposal.panel.closed") : t("proposal.panel.open")}</span>
            </PropRow>
          ))
        )}
      </PropGroup>
    )}
    {onboarding === undefined || onboarding.notCommitted.length === 0 ? null : (
      <PropGroup title={t("proposal.panel.notCommitted")}>
        <p className="text-sm text-muted">{t("proposal.panel.notCommittedBody")}</p>
        <ul className="mt-1" data-testid="not-committed">
          {onboarding.notCommitted.slice(0, 10).map((file) => <li key={file} className="flex h-[26px] items-center truncate font-mono text-sm text-muted">{file}</li>)}
        </ul>
        {onboarding.notCommitted.length > 10 ? <p className="text-xs text-faint">{t("proposal.panel.more", { n: onboarding.notCommitted.length - 10 })}</p> : null}
      </PropGroup>
    )}
  </div>
);

export const EnvironmentProposalTab = ({ projectId, projectName, onboarding, now }: { readonly projectId: ProjectId; readonly projectName: string; readonly onboarding: Onboarding | undefined; readonly now: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const proposal = useQuery({ ...trpc.environments.proposal.queryOptions({ projectId }), refetchInterval: onboarding?.task?.open === true ? 5000 : false });
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<ReadonlyMap<string, { readonly setupScript: string; readonly commands: ReadonlyMap<string, string> }>>(new Map());
  const [reason, setReason] = useState("");
  const data = proposal.data;
  const [justDecided, setDecided] = useState<Decided | null>(null);
  // What was decided here a moment ago, else what the server says was decided (after a reload too):
  // the shown proposal's decision (kept readable for 7 days), or the onboarding task's last one.
  const decided = decidedOf(justDecided, data?.decision ?? (data === null ? (onboarding?.decision ?? null) : null));
  const decide = useMutation(
    trpc.environments.decideProposal.mutationOptions({
      onSettled: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.environments.proposal.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.environments.onboarding.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.environments.pathKey() }),
        ]);
      },
    }),
  );

  if (proposal.error !== null) {
    return (
      <p role="alert" className="mt-4 text-red">
        {errorText(proposal.error)} <button type="button" className="text-teal hover:underline" onClick={() => void proposal.refetch()}>{t("proposal.retry")}</button>
      </p>
    );
  }
  if (data === undefined || onboarding === undefined) {
    return (
      <div aria-busy className="mt-4 space-y-3">
        <Skeleton className="h-5 w-80" />
        {[0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full" />)}
      </div>
    );
  }
  const accept = (edited: boolean) => {
    if (data === null) return;
    const body = edited && data.body !== null ? editedProposal(data.body, edits) : null;
    decide.mutate(
      { proposalId: data.proposalId, decision: body === null ? "accept" : "edit-and-accept", edited: body, reason: null },
      { onSuccess: ({ resultVersion }) => { setDecided({ kind: "accepted", version: resultVersion }); setEditing(false); } },
    );
  };

  return (
    <div data-testid="proposal-tab">
      <TaskLine onboarding={onboarding} now={now} />
      {/* With the proposal shown, its outcome takes the decision row's place below. */}
      {decided === null || data !== null ? null : <DecidedLine decided={decided} projectId={projectId} className="mt-4" />}
      {data === null ? (
        onboarding.task !== null && !onboarding.task.open && decided === null ? (
          <p className="mt-2 text-sm text-muted">
            {t("proposal.endedWithout")} <Link href={`/tasks/${onboarding.task.taskId}`} className="text-teal hover:underline">{t("proposal.openTask", { key: onboarding.task.key })}</Link>
          </p>
        ) : null
      ) : (
        <div className="mt-6 border-t border-line pt-4" data-testid="proposal">
          <h2 className="text-[15px] font-semibold text-text">
            {editing ? t("proposal.editingTitle") : t("proposal.title")}
            <span className="text-sm font-normal text-faint">{data.saved ? ` · ${t("proposal.againstSaved")}` : data.decision === null ? ` · ${t("proposal.againstDraft")}` : ` · ${t("proposal.againstDraftThen")}`}</span>
          </h2>
          {data.notes === "" ? null : <p className="mt-2 max-w-[680px] whitespace-pre-wrap text-ui leading-[1.6] text-muted" data-testid="proposal-notes">{data.notes}</p>}
          {!data.readable ? (
            <p className="mt-3 text-sm text-muted">{t("proposal.unreadable")}</p>
          ) : (
            <div className="mt-5 space-y-6">
              {data.repos.map((repo) => (
                <RepoBlock
                  key={repo.repoId}
                  repo={repo}
                  editing={editing}
                  edit={edits.get(repo.repoId)}
                  onEdit={(next) => { setEdits((now) => new Map([...now, [repo.repoId, next]])); }}
                />
              ))}
              {data.services.added.length + data.services.changed.length === 0 ? null : (
                <section className="border-t border-line pt-4">
                  <h3 className="text-[14px] font-semibold text-text">{t("proposal.services")}<span className="text-sm font-normal text-faint"> {t("proposal.forEveryRepo")}</span></h3>
                  <div className="mt-2">
                    <RowsBlock>
                      {[...data.services.added.map((service) => ({ sign: "+" as const, service })), ...data.services.changed.map((change) => ({ sign: "~" as const, service: change.proposed }))].map(({ sign, service }) => (
                        <SignedRow key={service.name} sign={sign} testid="proposal-service">
                          <span className="font-mono text-[13px] text-text">{service.name}</span>
                          <span className="font-mono text-[12.5px] text-faint">{service.image}</span>
                          {service.port === null ? null : <span className="font-mono text-[12.5px] text-text">{service.port}</span>}
                          {service.healthCheck === null ? null : <span className="font-mono text-[12.5px] text-muted">{service.healthCheck}</span>}
                        </SignedRow>
                      ))}
                    </RowsBlock>
                  </div>
                </section>
              )}
              <AppProcessesBlock data={data} projectId={projectId} />
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4" data-testid="proposal-decision">
            {decided !== null ? (
              <DecidedLine decided={decided} projectId={projectId} />
            ) : !data.canDecide ? (
              <p className="text-sm text-muted">{t("proposal.adminDecides", { project: projectName })}</p>
            ) : editing ? (
              <>
                <Button variant="primary" disabled={decide.isPending} onClick={() => { accept(true); }} data-action="accept-edited">{t("proposal.acceptEdited")}</Button>
                <Button variant="ghost" disabled={decide.isPending} onClick={() => { setEditing(false); setEdits(new Map()); }}>{t("proposal.cancel")}</Button>
              </>
            ) : (
              <>
                <Button variant="primary" disabled={decide.isPending || !data.readable} onClick={() => { accept(false); }} data-action="accept">{t("proposal.accept")}</Button>
                <Button disabled={decide.isPending || !data.readable} onClick={() => { setEditing(true); }} data-action="edit-and-accept">{t("proposal.editAndAccept")}</Button>
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <Button variant="ghost" className="hover:text-red" disabled={decide.isPending} data-action="reject">{t("proposal.reject")}</Button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content align="start" sideOffset={6} className="z-50 w-[320px] rounded-md border border-line-2 bg-raise p-3 shadow-(--shadow-pop)">
                      <Textarea aria-label={t("proposal.why")} placeholder={t("proposal.why")} value={reason} onChange={(event) => { setReason(event.target.value); }} />
                      <Button
                        className="mt-2 text-red"
                        disabled={decide.isPending}
                        onClick={() => {
                          decide.mutate(
                            { proposalId: data.proposalId, decision: "reject", edited: null, reason: reason.trim() === "" ? null : reason.trim() },
                            { onSuccess: () => { setDecided({ kind: "rejected" }); } },
                          );
                        }}
                      >
                        {t("proposal.rejectConfirm")}
                      </Button>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </>
            )}
            {data.canDecide && decided === null ? <span className="text-xs text-faint sm:ml-auto">{t("proposal.acceptNote")}</span> : null}
          </div>
          {decide.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(decide.error)}</p>}
        </div>
      )}
    </div>
  );
};
