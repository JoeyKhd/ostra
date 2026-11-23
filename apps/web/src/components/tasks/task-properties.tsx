"use client";

import type { ReactNode } from "react";

import { RunnerKind } from "@/components/runners/runners-view";
import { TaskMemory } from "@/components/memory/task-memory";
import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { formatDuration, formatElapsed, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { TaskAttachmentsGroup } from "./attachments/attachments-group";
import { KeyRow } from "./no-key";
import { CodeHeadRows, statusWithSubState } from "./review/task-rounds";
import { ReasoningRow } from "./task-effort";
import { boxText, sessionText, SpendValue } from "./task-ticket";
import { boxSizeText } from "./task-waiting-words";
import { planRowText, stateTone } from "./task-words";

// Owner: ticket 16 (milestone 10, F-151: the properties panel's groups, parts.md part 15). Ticket 09
// moved it here from `task-view.tsx` unchanged, so ticket 16 can rebuild it on its own.

type Task = RouterOutputs["tasks"]["get"];

/** The task kinds that never push (ADR 0028 amended): a refine task, and a review task. */
export const readOnlyKind = (kind: Task["kind"]): boolean => kind === "refine" || kind === "review";

/** The ` · ` between facts on a line, in `--faint`. */
const Sep = () => <span aria-hidden className="text-faint">·</span>;

const Mono = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("truncate font-mono text-ui", className)}>{children}</span>
);

/** The 18px avatar beside the driver's name: the only marker a value may carry besides the status dot. */
const Avatar = ({ name }: { readonly name: string }) => (
  <span aria-hidden className="inline-grid size-[18px] shrink-0 place-items-center rounded-full bg-line-2 text-[9.5px] font-semibold text-text">
    {initials(name)}
  </span>
);

/** Whether a repo's current PR is a draft (task-checks.md: `git-pull-request-draft`, `#483 · draft`). */
export const prIsDraft = (repo: Task["repos"][number]): boolean =>
  repo.pr !== null && repo.pr.state === "open" && repo.pullRequests.some((pr) => pr.number === repo.pr?.number && pr.draft);

/**
 * The properties panel (task.md, "Properties panel"): what describes the task and doesn't change turn
 * to turn. Values carry no icons, so they all start at one x; the status dot and the driver's avatar
 * are the only markers. Its Tokens, Cache, Spend and Agent time rows are F-084's.
 */
export const Properties = ({ task, tokens, reasoningTokens, context, now, onTakeOver, takingOver, ticket, effort, noKey, projectName, checks }: {
  readonly task: Task;
  /** The newest turn's checks, for the Code group's `Checks` row (task-checks.md); `null` when none ran. */
  readonly checks: { readonly failing: number; readonly passed: number; readonly running: boolean } | null;
  /** F-137: the Effort row, built by the view (it holds the change's mutation). */
  readonly effort: ReactNode;
  /** F-135: queued with no key for its model. */
  readonly noKey: boolean;
  readonly projectName: string;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean };
  /** F-137: the reasoning tokens inside `out`, from the turns' usage. */
  readonly reasoningTokens: number;
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly now: number;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
  /** The Ticket and On Linear groups (ticket 36). */
  readonly ticket: ReactNode;
}) => {
  const usage = task.usage?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spentMicroUsd: null, agentMs: 0, estimated: false };
  const input = Math.max(tokens.inputTokens, task.session?.inputTokens ?? 0);
  const output = Math.max(tokens.outputTokens, task.session?.outputTokens ?? 0);
  const boxSize = task.box?.size ?? null;
  return (
    <div data-testid="task-properties">
      <PropGroup title={t("taskPage.properties")}>
        <PropRow label={t("taskPage.status")}>
          <Status tone={stateTone(task.state)} className="min-w-0">
            {/* A sub-state makes it long (`In review · waiting for a reviewer`): it wraps rather than cut a word. */}
            <span className="min-w-0 break-words" data-testid="task-status">{noKey ? t("noKey.queued") : statusWithSubState(task)}</span>
          </Status>
        </PropRow>
        <PropRow label={t("taskPage.driver")}>
          {task.driver === null ? <span className="text-faint">–</span> : (
            <>
              <Avatar name={task.driver.name} />
              <span className="truncate">{task.driver.name}</span>
            </>
          )}
          {task.capabilities.takeOver ? (
            <>
              {task.driver === null ? null : <Sep />}
              <Button variant="link" className="text-ui font-normal" onClick={onTakeOver} disabled={takingOver} data-action="take-over">{t("taskPage.takeOver")}</Button>
            </>
          ) : null}
        </PropRow>
        {task.kind === "code" ? null : (
          <PropRow label={t("draft.kind")}><span data-testid="task-kind">{task.kind === "refine" ? t("draft.kindRefine") : t("draft.kindReview")}</span></PropRow>
        )}
        <PropRow label={t("taskAnswers.usage.profile")}>
          {task.agent === null ? <span className="text-faint">{t("taskAnswers.usage.none")}</span> : <span className="truncate" data-testid="task-profile">{task.agent.name}</span>}
          {task.agent?.builtInKind === null || task.agent?.builtInKind === undefined ? null : <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("draft.builtIn")}</Chip>}
        </PropRow>
        {task.plan === null ? null : <PropRow label={t("taskAnswers.usage.plan")}><span className="truncate" data-testid="task-plan-row">{planRowText(task.plan)}</span></PropRow>}
        {task.agent === null ? null : (
          <>
            <PropRow label={t("taskPage.agent")}><span className="truncate">{task.agent.agentName}</span></PropRow>
            {task.agent.model === null ? null : (
              <PropRow label={t("taskPage.model")}>
                <span className="truncate">{task.agent.model.name}</span>
                {task.session?.providerName === undefined || task.session.providerName === null ? null : (
                  <span className="shrink-0 truncate" data-testid="task-key">
                    <span className="text-muted">{t("noKey.keyPrefix")}</span> <span className="font-mono text-ui">{task.session.providerName}</span>
                  </span>
                )}
              </PropRow>
            )}
            {noKey ? <KeyRow providerName={null} projectName={projectName} /> : null}
          </>
        )}
        {effort}
        <PropRow label={t("taskPage.runner")}>
          {/* Once the box is released the task has no runner (task-reopen.md, "Properties"). */}
          {task.runner === null || task.box?.state === "released" ? <span className="text-faint">{t("taskPage.noRunner")}</span> : <Mono>{task.runner.name}</Mono>}
        </PropRow>
        {task.runner === null || task.box?.state === "released" ? null : (
          <div className="pb-1.5 pl-[104px]"><RunnerKind runner={task.runner} /></div>
        )}
        {readOnlyKind(task.kind) ? (
          <PropRow label={t("draft.pushes")}><span className="truncate text-muted" data-testid="task-pushes">{task.state === "done" ? t("draft.pushesNoneDone") : t("draft.pushesNone")}</span></PropRow>
        ) : null}
        <PropRow label={t("taskPage.tokens")}>
          <Mono>
            <span data-testid="task-tokens">{usage.estimated ? "≈ " : ""}{formatTokens(Math.max(input, usage.inputTokens))} {t("taskPage.in")} · {formatTokens(Math.max(output, usage.outputTokens))} {t("taskPage.out")}</span>
          </Mono>
          {/* F-089: a call whose endpoint reported no usage was estimated by the key proxy, and the count says so. */}
          {tokens.estimated ? (
            <span data-testid="task-tokens-estimated" className="truncate text-faint" title={t("taskPage.estimatedHelp")}>
              {t("taskPage.estimated")}
            </span>
          ) : null}
        </PropRow>
        <ReasoningRow tokens={reasoningTokens} />
        <PropRow label={t("taskAnswers.usage.cache")}>
          <Mono><span data-testid="task-cache">{formatTokens(usage.cacheReadTokens)} {t("taskAnswers.usage.read")} · {formatTokens(usage.cacheWriteTokens)} {t("taskAnswers.usage.write")}</span></Mono>
        </PropRow>
        {context === null ? null : (
          <PropRow label={t("taskPage.context")}>
            <span className="inline-block h-1 w-[60px] shrink-0 overflow-hidden rounded-sm bg-line-2" aria-hidden>
              <i className="block h-full bg-muted" style={{ width: `${String(Math.min(100, Math.round((context.used / Math.max(1, context.size)) * 100)))}%` }} />
            </span>
            <Mono className="text-muted">{formatTokens(context.used)} / {formatTokens(context.size)}</Mono>
          </PropRow>
        )}
        {task.box === null ? null : <PropRow label={t("taskPage.box.label")}><span className="truncate">{boxText(task.box, now)}</span></PropRow>}
        {task.sessions.length === 0 ? null : (
          <PropRow label={t("taskPage.session.label")}>
            <span className="truncate" data-testid="task-sessions">{sessionText(task.sessions)}</span>
          </PropRow>
        )}
        {boxSize === null ? null : <PropRow label={t("waitLine.panelBoxSize")}><Mono><span data-testid="task-box-size">{boxSizeText(boxSize)}</span></Mono></PropRow>}
        <PropRow label={t("taskPage.spend")}>
          <Mono><span data-testid="task-spend" data-reached={task.spend.reached}><SpendValue spend={task.spend} /></span></Mono>
        </PropRow>
        <PropRow label={t("taskAnswers.usage.agentTime")}><Mono><span data-testid="task-agent-time">{formatDuration(usage.agentMs)}</span></Mono></PropRow>
        <PropRow label={t("taskPage.time")}><Mono>{formatElapsed(task.createdAt, now)}</Mono></PropRow>
      </PropGroup>
      {task.taskRules.length === 0 ? null : (
        <PropGroup title={t("taskAnswers.usage.rules")}>
          {task.taskRules.map((rule) => (
            <div key={rule.ruleId} className="flex h-[26px] items-center gap-2 text-[12.5px]" data-testid="task-rule">
              <span className="min-w-0 flex-1 truncate font-mono text-text">{rule.tool} {rule.pattern}</span>
              <span className="shrink-0 text-xs text-faint">{t("taskAnswers.usage.fromTask", { name: rule.createdBy?.name ?? t("taskPage.someone") })}</span>
            </div>
          ))}
        </PropGroup>
      )}
      {ticket}
      <TaskAttachmentsGroup taskId={task.id} pr={task.repos.flatMap((repo) => (repo.pr === null ? [] : [{ number: repo.pr.number, url: repo.pr.url }]))[0] ?? null} />
      <TaskMemory taskId={task.id} />
      <PropGroup title={t("taskPage.code")}>
        {task.repos.map((repo) => {
          const href = repo.pr === null ? null : safeHref(repo.pr.url);
          return (
            <div key={repo.repoId}>
              <PropRow label={t("taskPage.repo")}><Mono>{repo.fullName}</Mono></PropRow>
              <PropRow label={t("taskPage.branch")}>
                <span className="truncate font-mono text-ui" title={repo.branchName}>{repo.branchName}</span>
              </PropRow>
              {repo.pullRequests.filter((pr) => pr.number !== repo.pr?.number).map((pr) => (
                <PropRow key={pr.number} label={t("taskPage.pr")}>
                  <a href={safeHref(pr.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-earlier">#{pr.number}</a>
                  <span className="text-faint">·</span>
                  <span className="text-ui text-muted">{pr.state}</span>
                </PropRow>
              ))}
              {repo.pr === null ? null : <CodeHeadRows headSha={repo.headSha} ci={repo.ci} />}
              <PropRow label={t("taskPage.pr")}>
                {repo.pr === null || href === null ? <span className="text-faint">{t("taskPage.noPr")}</span> : (
                  <>
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-link">
                      #{repo.pr.number}
                    </a>
                    <span className="text-faint">·</span>
                    <span className={cn("text-ui", repo.pr.state === "merged" ? "text-green" : repo.pr.state === "closed" ? "text-faint" : "text-muted")} data-pr-state={repo.pr.state}>
                      {prIsDraft(repo) ? t("taskPage.prState.draft") : t(`taskPage.prState.${repo.pr.state}`)}
                    </span>
                  </>
                )}
              </PropRow>
            </div>
          );
        })}
        {checks === null ? null : (
          <PropRow label={t("checks.property.label")}>
            <span className="truncate text-[12.5px]" data-testid="task-checks-row">
              {checks.running ? (
                <span className="text-muted">{t("checks.property.running")}</span>
              ) : checks.failing > 0 ? (
                <>
                  <span className="text-red">{t("checks.summary.failed", { n: checks.failing })}</span>
                  {checks.passed > 0 ? <span className="text-muted">{t("checks.property.andPassed", { n: checks.passed })}</span> : null}
                </>
              ) : (
                <span className="text-green">{t("checks.property.allPassed", { n: checks.passed })}</span>
              )}
            </span>
          </PropRow>
        )}
      </PropGroup>
    </div>
  );
};
