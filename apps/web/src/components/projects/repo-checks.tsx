"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, BanIcon, GitBranchIcon, InfoIcon, LockIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { RepoCheckLine } from "./repo-check-line";
import { accountOf, checkLines, checkedAge, oldestCheck, repoVerdict, reposByAccount, selectedRepo, unsupportedRepos } from "./repo-checks-words";
import type { RepoDetail, RepoVerdict } from "./repo-checks-words";

const verdictStyle: Readonly<Record<RepoVerdict, string>> = {
  notLinked: "font-medium text-red",
  ready: "text-muted",
  warning: "font-medium text-text",
  unsupported: "font-medium text-red",
  unknown: "text-faint",
};

/** The red-ruled notice: tasks can't start while a repo requires signed commits. */
export const BlockedNotice = ({ repos }: { readonly repos: readonly RepoDetail[] }) => {
  const blocked = unsupportedRepos(repos);
  const first = blocked[0];
  if (first === undefined) return null;
  const [before = "", after = ""] = t("repos.blocked.one").split("{repo}");
  return (
    <div role="alert" className="mt-[18px] flex items-start gap-3 rounded-r-md border-l-2 border-red bg-surface px-3.5 py-2.5">
      <BanIcon aria-hidden className="mt-[3px] size-[15px] shrink-0 stroke-[1.75] text-red" />
      <div className="min-w-0">
        <div className="text-body font-medium text-text">{t("repos.blocked.title")}</div>
        <div className="text-ui text-muted">
          {blocked.length > 1 ? (
            t("repos.blocked.many", { n: blocked.length })
          ) : (
            <>
              {before}
              <code className="font-mono text-sm text-text">{first.fullName}</code>
              {after}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/** One repo: its header line (name, lock, branch, verdict) and its check lines; a button that selects it. */
export const RepoBlock = ({ repo, selected, onSelect }: { readonly repo: RepoDetail; readonly selected: boolean; readonly onSelect: () => void }) => {
  const verdict = repoVerdict(repo);
  return (
    <li className="border-b border-line first:border-t">
      <button
        type="button"
        aria-pressed={selected}
        data-verdict={verdict}
        onClick={onSelect}
        className={cn(
          "my-1 block w-full rounded-md px-3 py-2 text-left hover:bg-raise focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted",
          selected && "bg-sel hover:bg-sel",
        )}
      >
        <div className="flex min-h-7 items-center gap-3">
          <GitBranchIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
          <span className="min-w-0 truncate font-mono text-body text-text">{repo.fullName}</span>
          {repo.private === true ? <LockIcon aria-label={t("repos.private")} className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : null}
          <span className="ml-1 hidden font-mono text-ui text-faint sm:inline">{repo.defaultBranch}</span>
          <span className={cn("ml-auto shrink-0 text-ui", verdictStyle[verdict])}>{t(`repos.verdict.${verdict}`)}</span>
        </div>
        <ul className="pl-[27px]">
          {checkLines(repo).map((line) => (
            <RepoCheckLine key={line.kind} line={line} />
          ))}
        </ul>
      </button>
    </li>
  );
};

export const RepoBlocksLoading = () => (
  <ul aria-busy className="mt-[18px]">
    {[0, 1, 2].map((i) => (
      <li key={i} className="space-y-3 border-b border-line px-3 py-3.5 first:border-t">
        <Skeleton className="w-[260px]" />
        <Skeleton className="ml-[27px] w-[200px]" />
        <Skeleton className="ml-[27px] w-[180px]" />
      </li>
    ))}
  </ul>
);

const PanelLabel = ({ children, mono = false }: { readonly children: ReactNode; readonly mono?: boolean }) => (
  <h3 className={cn("mb-2", mono ? "font-mono text-sm text-muted" : "text-xs font-medium text-faint")}>{children}</h3>
);
const Sep = () => <div className="my-3.5 h-px bg-line" />;

/** `{branch}` in mono inside a sentence. */
const WithBranch = ({ text, branch }: { readonly text: string; readonly branch: string }) => (
  <>
    {text.split("{branch}").map((part, i) => (
      <span key={`${part}-${String(i)}`}>
        {i > 0 ? <code className="font-mono text-sm text-text">{branch}</code> : null}
        {part}
      </span>
    ))}
  </>
);

const RulesLink = ({ repo }: { readonly repo: RepoDetail }) => (
  <a
    href={`https://github.com/${repo.fullName}/settings/rules`}
    target="_blank"
    rel="noopener noreferrer"
    className="mt-2.5 inline-flex items-center gap-1 text-ui text-teal hover:underline"
  >
    {t("repos.panel.openRules")}
    <ArrowUpRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
  </a>
);

/** The properties panel: the selected repo's rows, why its result is allowed or blocked, and how to fix it. */
export const RepoProperties = ({ repo, now }: { readonly repo: RepoDetail | undefined; readonly now: number }) => {
  if (repo === undefined)
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="w-[160px]" />
        <Skeleton className="w-[220px]" />
        <Skeleton className="w-[200px]" />
      </div>
    );
  const verdict = repoVerdict(repo);
  const check = (result: boolean | "unknown", yes: string, no: string) => (result === "unknown" ? <span className="text-faint">{t("repos.panel.unknown")}</span> : result ? yes : no);
  const unknownReason = [repo.defaultBranchProtected, repo.signedCommitsRequired].find((c) => c.result === "unknown")?.reason ?? t("repos.check.noReason");
  return (
    <div data-testid="repo-properties">
      <PanelLabel mono>{repo.fullName}</PanelLabel>
      <PropRow label={t("repos.panel.defaultBranch")} labelWidth={112}>
        <span className="font-mono">{repo.defaultBranch}</span>
      </PropRow>
      <PropRow label={t("repos.panel.visibility")} labelWidth={112}>
        {repo.private === null ? "–" : repo.private ? t("repos.private") : t("repos.panel.public")}
      </PropRow>
      <PropRow label={t("repos.panel.checked")} labelWidth={112}>
        <span className="font-mono">{repo.checkedAt === null ? "–" : checkedAge(repo.checkedAt, now)}</span>
      </PropRow>
      <PropRow label={t("repos.panel.protected")} labelWidth={112}>
        {check(repo.defaultBranchProtected.result, t("repos.panel.yes"), t("repos.panel.no"))}
      </PropRow>
      <PropRow label={t("repos.panel.signedCommits")} labelWidth={112}>
        {repo.signedCommitsRequired.result === true ? <span className="text-red">{t("repos.panel.required")}</span> : check(repo.signedCommitsRequired.result, "", t("repos.panel.notRequired"))}
      </PropRow>
      {verdict === "ready" ? null : (
        <>
          <Sep />
          <PanelLabel>
            {t(verdict === "notLinked" ? "repos.panel.whyNotLinked" : verdict === "warning" ? "repos.panel.whyAllowed" : verdict === "unsupported" ? "repos.panel.whyBlocked" : "repos.panel.whyUnknown")}
          </PanelLabel>
          <div className="space-y-2 text-ui leading-[1.55] text-muted">
            {verdict === "notLinked" ? (
              <>
                <p>{t("repos.panel.whyNotLinkedBody", { account: repo.installation?.accountLogin ?? "" })}</p>
                <Link href="/organization/github" className="inline-flex items-center gap-1 text-teal hover:underline">
                  {t("repos.panel.openGitHub")}
                </Link>
              </>
            ) : verdict === "warning" ? (
              <p>
                <WithBranch text={t("repos.panel.whyAllowedBody")} branch={repo.defaultBranch} />
              </p>
            ) : verdict === "unsupported" ? (
              <p>{t("repos.panel.whyBlockedBody")}</p>
            ) : (
              <>
                <p>{unknownReason}</p>
                <p>{t("repos.panel.whyUnknownAfter")}</p>
              </>
            )}
          </div>
        </>
      )}
      {verdict === "warning" ? (
        <>
          <Sep />
          <PanelLabel>
            <WithBranch text={t("repos.panel.protect")} branch={repo.defaultBranch} />
          </PanelLabel>
          <ol className="space-y-1.5 text-ui text-muted">
            {[t("repos.panel.protectStep1"), t("repos.panel.protectStep2")].map((step, i) => (
              <li key={step} className="grid grid-cols-[24px_minmax(0,1fr)]">
                <span className="font-mono text-faint">{i + 1}</span>
                <span>
                  <WithBranch text={step} branch={repo.defaultBranch} />
                </span>
              </li>
            ))}
          </ol>
          <RulesLink repo={repo} />
        </>
      ) : verdict === "unsupported" ? (
        <>
          <Sep />
          <PanelLabel>{t("repos.panel.toStart")}</PanelLabel>
          <p className="text-ui text-muted">
            <WithBranch text={t("repos.panel.toStartBody")} branch={repo.defaultBranch} />
          </p>
          <RulesLink repo={repo} />
        </>
      ) : null}
    </div>
  );
};

/** The lede: the account, the repo count and the oldest check's age. */
export const ReposLede = ({ repos, now }: { readonly repos: readonly RepoDetail[]; readonly now: number }) => {
  const account = accountOf(repos);
  const oldest = oldestCheck(repos);
  return (
    <>
      {account === null ? null : <code className="font-mono text-ui text-text">{account}</code>}
      {account === null ? null : " · "}
      {plural(repos.length, "repos.count.one", "repos.count.other")}
      {" · "}
      {oldest === null ? t("repos.neverChecked") : t("repos.checkedAgo", { age: checkedAge(oldest, now) })}
    </>
  );
};

/** Project › Repos (F-060, F-055; repo-checks.md): each repo's two checks, and why. */
export const RepoChecksView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const [mounted] = useState(() => Date.now());
  const check = useMutation(
    trpc.projects.checkRepos.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) });
      },
    }),
  );
  const repos = project.data?.repos ?? [];
  const selected = selectedRepo(repos, params.get("repo"));
  const now = project.dataUpdatedAt === 0 ? mounted : project.dataUpdatedAt;
  const admin = project.data?.role === "admin";
  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("repos.title") }]}
      actions={
        admin ? (
          <Button onClick={() => { check.mutate({ projectId }); }} disabled={check.isPending}>
            <RefreshCwIcon className={cn("stroke-[1.75]", check.isPending && "animate-spin motion-reduce:animate-none")} />
            {check.isPending ? t("repos.checking") : t("repos.checkAgain")}
          </Button>
        ) : undefined
      }
      properties={<RepoProperties repo={project.data === undefined ? undefined : selected} now={now} />}
    >
      <PageHeading title={t("repos.title")} lede={project.data === undefined ? <Skeleton className="mt-1 w-[240px]" /> : <ReposLede repos={repos} now={now} />} />
      {project.isError ? (
        <p role="alert" className="mt-6 flex items-start gap-2 text-ui text-red">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {errorText(project.error)}
        </p>
      ) : project.data === undefined ? (
        <RepoBlocksLoading />
      ) : (
        <div className="max-w-[760px]">
          <BlockedNotice repos={repos} />
          {check.error === null ? null : <p role="alert" className="mt-3 text-ui text-red">{errorText(check.error)}</p>}
          <div className="mt-[18px] space-y-5" data-testid="repo-checks">
            {reposByAccount(repos).map((group, _, groups) => (
              <section key={group.account} data-testid="repo-account" data-account={group.account} aria-label={groups.length > 1 ? group.account : undefined}>
                {groups.length > 1 ? (
                  <h2 className="mb-1.5 text-xs font-medium text-faint">
                    <span className="font-mono">{group.account}</span>
                    {group.kind === null ? null : ` · ${t(`repos.accountKind.${group.kind}`)}`}
                  </h2>
                ) : null}
                <ul>
                  {group.repos.map((repo) => (
                    <RepoBlock
                      key={repo.repoId}
                      repo={repo}
                      selected={repo.repoId === selected?.repoId}
                      onSelect={() => {
                        router.replace(`${pathname}?repo=${repo.repoId}`, { scroll: false });
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs text-faint">
            <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
            {t("repos.footnote")}
          </p>
        </div>
      )}
    </PageFrame>
  );
};
