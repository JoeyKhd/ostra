"use client";

import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { RunnerKind } from "@/components/runners/runners-view";
import { TaskMemory } from "@/components/memory/task-memory";
import { PropDensity, PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { formatDuration, formatElapsed, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";
import { checksRow, ciRow } from "@/task/thread/words";

import { TaskAttachmentsGroup } from "./attachments/attachments-group";
import { KeyRow } from "./no-key";
import { statusWithSubState } from "./review/task-rounds";
import { ReasoningRow } from "./task-effort";
import { boxRowWords, savedWorkWords, tokensWords } from "./task-properties-words";
import type { PanelTurns, RowWords } from "./task-properties-words";
import { SpendValue } from "./task-ticket";
import { boxSizeText } from "./task-waiting-words";
import { planRowText, stateTone } from "./task-words";

// Owner: ticket 16 (milestone 10, F-151/c3: the properties panel's groups, parts.md part 15, each
// scene's table in `s1.md`, `s2.md`, `s3.md` and `s5.md`). What describes the task and doesn't
// change turn to turn, in the targets' groups: `Properties`, a review task's `Result`, the ticket's
// and the draft's groups as their milestones built them, `Usage`, `Code` (ostra's checks in the box
// and the code host's CI in jobs), `Session` (the box, the saved work, the turns), then milestone
// 6's rounds, milestone 3's approval rules, milestone 9's attachments and the memory. Rows are
// 28px with a 104px key column (`PropDensity`); a value's tail after ` · ` is `--faint`.

type Task = RouterOutputs["tasks"]["get"];

/** The task kinds that never push (ADR 0028 amended): a refine task, and a review task. */
export const readOnlyKind = (kind: Task["kind"]): boolean => kind === "refine" || kind === "review";

const Mono = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("truncate font-mono text-[13.5px]", className)}>{children}</span>
);

/** What follows a value, after ` · `, in `--faint` (`Idle · stops in 11 min`, `3 of 3 passed · in the box`). */
const Tail = ({ children, mono = false }: { readonly children: ReactNode; readonly mono?: boolean }) => (
  <span className={cn("min-w-0 truncate text-[13px] text-faint", mono && "font-mono")}>
    <span aria-hidden>· </span>
    {children}
  </span>
);

/** A row's value and its `--faint` tail. */
const Words = ({ words, testId, monoTail = false }: { readonly words: RowWords; readonly testId: string; readonly monoTail?: boolean }) => (
  <span className="flex min-w-0 items-center gap-[7px]" data-testid={testId}>
    <span className="shrink-0">{words.value}</span>
    {words.detail === null ? null : <Tail mono={monoTail}>{words.detail}</Tail>}
  </span>
);

/** The 18px avatar beside the driver's name: the only marker a value may carry besides the status dot. */
const Avatar = ({ name }: { readonly name: string }) => (
  <span aria-hidden className="inline-grid size-[18px] shrink-0 place-items-center rounded-full bg-line-2 text-[9.5px] font-semibold text-text">
    {initials(name)}
  </span>
);

/** The 11px ring that turns while something runs (milestone 8's `.spin`), still with reduced motion. */
const Spin = () => <span aria-hidden className="size-[11px] shrink-0 animate-spin rounded-full border-[1.75px] border-line-2 border-t-teal motion-reduce:animate-none" />;

/** A 13px mark: a passed check or job green, a failed one red (colour never alone: the words say it too). */
const Mark = ({ failed }: { readonly failed: boolean }) =>
  failed ? <CircleXIcon aria-hidden className="size-[13px]! text-red!" /> : <CircleCheckIcon aria-hidden className="size-[13px]! text-green!" />;

/** Whether a repo's current PR is a draft (task-checks.md: `git-pull-request-draft`, `#483 · draft`). */
export const prIsDraft = (repo: Task["repos"][number]): boolean =>
  repo.pr !== null && repo.pr.state === "open" && repo.pullRequests.some((pr) => pr.number === repo.pr?.number && pr.draft);

/** ostra's checks of the newest turn, as the Checks tab counts them. */
export type ChecksSummary = { readonly failing: number; readonly passed: number; readonly running: boolean };

/** The Code group's `Checks` row (parts.md parts 13 and 15): `3 of 3 passed · in the box`. */
const ChecksRow = ({ checks }: { readonly checks: ChecksSummary }) => {
  const words = checksRow({ passed: checks.passed, failed: checks.failing, total: checks.passed + checks.failing }, t);
  return (
    <PropRow label={t("checks.property.label")}>
      <span className="flex min-w-0 items-center gap-[7px]" data-testid="task-checks-row" data-checks={checks.running ? "running" : checks.failing > 0 ? "failed" : "passed"}>
        {checks.running ? <Spin /> : <Mark failed={checks.failing > 0} />}
        <span className={cn("shrink-0", !checks.running && checks.failing > 0 && "text-red")}>{checks.running ? t("checks.property.running") : words.value}</span>
        <Tail>{words.place}</Tail>
      </span>
    </PropRow>
  );
};

/** A repo's `CI` row (parts.md parts 13 and 15): the code host's CI on its head, counted in jobs: `Running · 2 of 4 jobs`. */
const CiRow = ({ ci }: { readonly ci: NonNullable<Task["repos"][number]["ci"]> }) => {
  const words = ciRow(ci, t);
  return (
    <PropRow label={t("taskPage.ci")}>
      <span className="flex min-w-0 items-center gap-[7px]" data-testid="code-ci" data-ci={ci.state}>
        {ci.state === "running" ? <Spin /> : ci.state === "none" ? null : <Mark failed={ci.state === "failed"} />}
        <span className={cn("shrink-0", ci.state === "failed" && "text-red", ci.state === "none" && "text-faint")}>{words.state}</span>
        {words.detail === null ? null : <Tail>{words.detail}</Tail>}
      </span>
    </PropRow>
  );
};

/** A repo's rows in the Code group: Repo, Branch, its earlier PRs, its PR, ostra's checks (once), and CI on its PR's head. */
const RepoRows = ({ repo, checks }: { readonly repo: Task["repos"][number]; readonly checks: ReactNode }) => {
  const href = repo.pr === null ? null : safeHref(repo.pr.url);
  return (
    <div>
      <PropRow label={t("taskPage.repo")}><Mono>{repo.fullName}</Mono></PropRow>
      <PropRow label={t("taskPage.branch")}><Mono><span title={repo.branchName}>{repo.branchName}</span></Mono></PropRow>
      {repo.pullRequests.filter((pr) => pr.number !== repo.pr?.number).map((pr) => (
        <PropRow key={pr.number} label={t("taskPage.pr")}>
          <a href={safeHref(pr.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline" data-testid="pr-earlier">#{pr.number}</a>
          <Tail>{pr.state}</Tail>
        </PropRow>
      ))}
      <PropRow label={t("taskPage.pr")}>
        {repo.pr === null || href === null ? <span className="text-[13px] text-faint">{t("taskPage.noPr")}</span> : (
          <>
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline" data-testid="pr-link">
              #{repo.pr.number}
            </a>
            <span className={cn(repo.pr.state === "merged" ? "text-green" : repo.pr.state === "closed" ? "text-faint" : "text-muted")} data-pr-state={repo.pr.state}>
              <span aria-hidden className="text-muted">· </span>
              {prIsDraft(repo) ? t("taskPage.prState.draft") : t(`taskPage.prState.${repo.pr.state}`)}
            </span>
          </>
        )}
      </PropRow>
      {checks}
      {repo.pr === null || repo.ci === null ? null : <CiRow ci={repo.ci} />}
    </div>
  );
};

/** A review task's `Result` group (`s3.md`), once its review is handed in: the blocking findings, the nits, and milestone 6's review screen. */
const ResultGroup = ({ review }: { readonly review: NonNullable<Task["review"]> }) => (
  <PropGroup title={t("taskPage.panel.result")}>
    <PropRow label={t("taskPage.panel.blocking")}>
      <span data-testid="task-blocking">{review.blocking === 0 ? t("taskPage.panel.none") : <Mono>{review.blocking}</Mono>}</span>
    </PropRow>
    <PropRow label={t("taskPage.panel.nits")}>
      <span data-testid="task-nits">{review.nits === 0 ? t("taskPage.panel.none") : <Mono>{review.nits}</Mono>}</span>
    </PropRow>
    <PropRow label={t("taskPage.panel.review")}>
      <Link href={`/tasks/${review.codeTask.id}/review`} className="truncate text-teal hover:underline" data-testid="task-open-review">{t("taskPage.panel.openReview")}</Link>
    </PropRow>
  </PropGroup>
);

/** A review task's `Reviews` row: the PR it reviews (a link to it on the code host), then its code task's key in `--muted`. */
const ReviewsRow = ({ review, prs }: { readonly review: NonNullable<Task["review"]>; readonly prs: NonNullable<Task["reviewOf"]>["prs"] }) => {
  const pr = review.prNumber === null ? null : { number: review.prNumber, href: safeHref(prs.find((one) => one.number === review.prNumber)?.url ?? "") };
  return (
    <PropRow label={t("taskPage.panel.reviews")}>
      <span className="flex min-w-0 items-center gap-[7px]" data-testid="task-reviews">
        {pr === null ? null : pr.href === null ? (
          <span className="shrink-0 text-teal">{t("taskPage.prButton", { n: pr.number })}</span>
        ) : (
          <a href={pr.href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-teal hover:underline">{t("taskPage.prButton", { n: pr.number })}</a>
        )}
        <span className="min-w-0 truncate text-muted">
          {pr === null ? null : <span aria-hidden>· </span>}
          {review.codeTask.key}
        </span>
      </span>
    </PropRow>
  );
};

/**
 * The properties panel (parts.md part 15; task.md, "Properties panel"): what describes the task and
 * doesn't change turn to turn. Values carry no icons but the status dot, the driver's avatar and the
 * checks' and CI's marks, so they all start at one x. Its Tokens, Cache, Spend and Agent time rows
 * are F-084's; its Usage and Session groups hold the turns' numbers for the task as a whole (F-151/c3).
 */
export const Properties = ({ task, meId = null, tokens, reasoningTokens, context, now, onTakeOver, takingOver, ticket, rounds = null, effort, noKey, projectName, checks, turns }: {
  readonly task: Task;
  /** The member viewing: the driver row says ` · you` when it's them. */
  readonly meId?: string | null;
  /** The newest turn's checks, for the Code group's `Checks` row (task-checks.md); `null` when none ran. */
  readonly checks: ChecksSummary | null;
  /** F-137: the Effort row, built by the view (it holds the change's mutation). */
  readonly effort: ReactNode;
  /** F-135: queued with no key for its model. */
  readonly noKey: boolean;
  readonly projectName: string;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean };
  /** F-137: the reasoning tokens inside `out`, from the stream's fold. */
  readonly reasoningTokens: number;
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly now: number;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
  /** The Ticket and On Linear groups (ticket 36) and a refine task's draft groups: after Properties for a task from a ticket, else after Session. */
  readonly ticket: ReactNode;
  /** Milestone 6's Rounds group, after Session. */
  readonly rounds?: ReactNode;
  readonly turns: PanelTurns;
}) => {
  const usage = task.usage?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, spentMicroUsd: null, agentMs: 0, estimated: false };
  const live = { inputTokens: Math.max(tokens.inputTokens, task.session?.inputTokens ?? 0), outputTokens: Math.max(tokens.outputTokens, task.session?.outputTokens ?? 0) };
  const boxSize = task.box?.size ?? null;
  // A released box's runner is the one the task last ran on (`s3.md`); a reopen picks one again, so its kinds go with the box.
  const released = task.box?.state === "released";
  const review = task.kind === "review" ? task.review : null;
  const handedIn = review !== null && (review.state === "submitted" || review.state === "posted");
  // The Checks tab's count of the newest turn (it knows a run in progress), else what the newest save counted.
  const boxChecks = checks ?? (turns.savedChecks === null ? null : { failing: turns.savedChecks.failed, passed: turns.savedChecks.passed, running: false });
  const checksRow = boxChecks === null ? null : <ChecksRow checks={boxChecks} />;
  // A finished task's time is how long it ran, to its last turn's end (`s3.md`: `9 min`); else it counts on.
  const finished = task.state === "done" || task.state === "merged" || task.state === "stopped";
  const lastEnd = Math.max(0, ...(task.usage?.turns ?? []).map((turn) => turn.endedAt ?? 0));
  const timeEnd = finished && lastEnd > task.createdAt ? lastEnd : now;
  // A task from a ticket reads its ticket's groups after Properties (`s5.md`); a prompt task's offer to create one waits after Session.
  const ticketFirst = task.ticket !== null;
  return (
    <PropDensity value="compact">
      <div data-testid="task-properties">
        <PropGroup title={t("taskPage.properties")}>
          <PropRow label={t("taskPage.status")}>
            <Status tone={stateTone(task.state)} className="min-w-0">
              {/* A sub-state makes it long (`In review · waiting for a reviewer`): it wraps rather than cut a word. */}
              <span className="min-w-0 break-words" data-testid="task-status">{noKey ? t("noKey.queued") : statusWithSubState(task)}</span>
            </Status>
          </PropRow>
          {/* A review task nobody drives says nothing of a driver (`s3.md`). */}
          {task.kind === "review" && task.driver === null ? null : (
            <PropRow label={t("taskPage.driver")}>
              {task.driver === null ? <span className="text-faint">–</span> : (
                <>
                  <Avatar name={task.driver.name} />
                  <span className="truncate">{task.driver.name}</span>
                  {task.driver.memberId === meId ? <Tail>{t("taskPage.panel.you")}</Tail> : null}
                </>
              )}
              {task.capabilities.takeOver ? (
                <>
                  {task.driver === null ? null : <span aria-hidden className="text-faint">·</span>}
                  <Button variant="link" className="text-ui font-normal" onClick={onTakeOver} disabled={takingOver} data-action="take-over">{t("taskPage.takeOver")}</Button>
                </>
              ) : null}
            </PropRow>
          )}
          {task.kind === "code" ? null : (
            <PropRow label={t("draft.kind")}><span data-testid="task-kind">{task.kind === "refine" ? t("draft.kindRefine") : t("taskPage.panel.aiReview")}</span></PropRow>
          )}
          {review === null ? null : (
            <>
              <ReviewsRow review={review} prs={task.reviewOf?.prs ?? []} />
              <PropRow label={t("taskPage.panel.round")}>
                <span className="flex items-center gap-[7px]" data-testid="task-round">
                  <Mono>{review.round}</Mono>
                  <span className="text-muted">{t("taskPage.panel.roundOf", { limit: review.limit })}</span>
                </span>
              </PropRow>
            </>
          )}
          {task.agent === null ? null : (
            <>
              <PropRow label={t("taskPage.agent")}><span className="truncate">{task.agent.agentName}</span></PropRow>
              {task.agent.model === null ? null : (
                <PropRow label={t("taskPage.model")}>
                  <span className="max-w-full shrink-0 truncate">{task.agent.model.name}</span>
                  {task.session?.providerName === undefined || task.session.providerName === null ? null : (
                    <span className="min-w-0 truncate" data-testid="task-key">
                      <span className="text-muted">{t("noKey.keyPrefix")}</span> <span className="font-mono text-[13.5px]">{task.session.providerName}</span>
                    </span>
                  )}
                </PropRow>
              )}
              {noKey ? <KeyRow providerName={null} projectName={projectName} /> : null}
            </>
          )}
          <PropRow label={t("taskAnswers.usage.profile")}>
            {task.agent === null ? <span className="text-faint">{t("taskAnswers.usage.none")}</span> : <span className="truncate" data-testid="task-profile">{task.agent.name}</span>}
            {task.agent?.builtInKind === null || task.agent?.builtInKind === undefined ? null : <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("draft.builtIn")}</Chip>}
          </PropRow>
          {effort}
          <PropRow label={t("taskPage.runner")}>
            {task.runner === null ? <span className="text-faint">{released ? t("taskPage.panel.none") : t("taskPage.noRunner")}</span> : <Mono>{task.runner.name}</Mono>}
          </PropRow>
          {task.runner === null || released ? null : <div className="pb-1 pl-[104px]"><RunnerKind runner={task.runner} /></div>}
          {task.plan === null ? null : <PropRow label={t("taskAnswers.usage.plan")}><span className="truncate" data-testid="task-plan-row">{planRowText(task.plan)}</span></PropRow>}
          {task.kind === "refine" ? (
            <PropRow label={t("draft.pushes")}><span className="truncate text-muted" data-testid="task-pushes">{task.state === "done" ? t("draft.pushesNoneDone") : t("draft.pushesNone")}</span></PropRow>
          ) : null}
        </PropGroup>
        {review !== null && handedIn ? <ResultGroup review={review} /> : null}
        {ticketFirst ? ticket : null}
        <PropGroup title={t("taskPage.panel.usage")}>
          <PropRow label={t("taskPage.tokens")}>
            <Mono><span data-testid="task-tokens">{tokensWords(usage, live, usage.estimated)}</span></Mono>
            {/* F-089: a call whose endpoint reported no usage was estimated by the key proxy, and the count says so. */}
            {tokens.estimated ? (
              <span data-testid="task-tokens-estimated" className="truncate text-[13px] text-faint" title={t("taskPage.estimatedHelp")}>
                {t("taskPage.estimated")}
              </span>
            ) : null}
          </PropRow>
          <ReasoningRow tokens={Math.max(reasoningTokens, usage.reasoningTokens)} />
          {/* F-084: the four kinds of tokens; the cache's two once a call read or wrote it. */}
          {usage.cacheReadTokens + usage.cacheWriteTokens === 0 ? null : (
            <PropRow label={t("taskAnswers.usage.cache")}>
              <Mono><span data-testid="task-cache">{formatTokens(usage.cacheReadTokens)} {t("taskAnswers.usage.read")} · {formatTokens(usage.cacheWriteTokens)} {t("taskAnswers.usage.write")}</span></Mono>
            </PropRow>
          )}
          <PropRow label={t("taskPage.spend")}>
            <span className="flex min-w-0 items-center gap-1.5 truncate" data-testid="task-spend" data-reached={task.spend.reached}><SpendValue spend={task.spend} /></span>
          </PropRow>
          <PropRow label={t("taskPage.time")}><Mono><span data-testid="task-time">{formatElapsed(task.createdAt, timeEnd)}</span></Mono></PropRow>
          {usage.agentMs === 0 ? null : (
            <PropRow label={t("taskAnswers.usage.agentTime")}><Mono><span data-testid="task-agent-time">{formatDuration(usage.agentMs)}</span></Mono></PropRow>
          )}
        </PropGroup>
        {/* A review or refine task has no branch or PR of its own (the README's choice 10). */}
        {task.kind === "code" ? (
          <PropGroup title={t("taskPage.code")}>
            {task.repos.map((repo, index) => (
              <RepoRows key={repo.repoId} repo={repo} checks={task.repos.length === 1 && index === 0 ? checksRow : null} />
            ))}
            {task.repos.length === 1 ? null : checksRow}
          </PropGroup>
        ) : null}
        <PropGroup title={t("taskPage.session.label")}>
          {task.box === null ? null : (
            <PropRow label={t("taskPage.box.label")}><Words words={boxRowWords(task.box, task.state, now)} testId="task-box" /></PropRow>
          )}
          {boxSize === null ? null : <PropRow label={t("waitLine.panelBoxSize")}><Mono><span data-testid="task-box-size">{boxSizeText(boxSize)}</span></Mono></PropRow>}
          {context === null ? null : (
            <PropRow label={t("taskPage.context")}>
              <span className="inline-block h-1 w-[60px] shrink-0 overflow-hidden rounded-sm bg-line-2" aria-hidden>
                <i className="block h-full bg-muted" style={{ width: `${String(Math.min(100, Math.round((context.used / Math.max(1, context.size)) * 100)))}%` }} />
              </span>
              <Mono className="text-muted">{formatTokens(context.used)} / {formatTokens(context.size)}</Mono>
            </PropRow>
          )}
          {/* A review or refine task keeps no work (the README's choice 10). */}
          {readOnlyKind(task.kind) ? null : (
            <PropRow label={t("taskPage.panel.savedWork")}>
              <Words words={savedWorkWords(turns.saved)} testId="task-saved-work" monoTail />
            </PropRow>
          )}
          {turns.anyEnded ? <PropRow label={t("taskPage.panel.turns")}><Mono><span data-testid="task-turns">{turns.count}</span></Mono></PropRow> : null}
        </PropGroup>
        {rounds}
        {ticketFirst ? null : ticket}
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
        <TaskAttachmentsGroup taskId={task.id} pr={task.repos.flatMap((repo) => (repo.pr === null ? [] : [{ number: repo.pr.number, url: repo.pr.url }]))[0] ?? null} />
        <TaskMemory taskId={task.id} />
      </div>
    </PropDensity>
  );
};
