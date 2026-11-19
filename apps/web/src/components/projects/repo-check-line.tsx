import { BanIcon, CircleHelpIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { t } from "@/lib/messages";

import { unprotectedRepos, unsupportedRepos } from "./repo-checks-words";
import type { CheckLine, RepoDetail } from "./repo-checks-words";

const icon = "mt-[3px] size-[15px] shrink-0 stroke-[1.75]";

const Line = ({ glyph, text, why }: { readonly glyph: ReactNode; readonly text: ReactNode; readonly why?: string | null }) => (
  <li className="flex items-start gap-3 py-[3px]">
    {glyph}
    <div className="min-w-0">
      <div className="text-ui text-text">{text}</div>
      {why === undefined || why === null ? null : <div className="text-xs text-faint">{why}</div>}
    </div>
  </li>
);

/** One check under a repo (repo-checks.md, the check table): an icon, the text, and why on its own line. */
export const RepoCheckLine = ({ line }: { readonly line: CheckLine }) => {
  switch (line.kind) {
    case "protected":
      return <Line glyph={<ShieldCheckIcon aria-hidden className={`${icon} text-green`} />} text={t("repos.check.protected")} />;
    case "notProtected":
      return <Line glyph={<TriangleAlertIcon aria-hidden className={`${icon} text-text`} />} text={t("repos.check.notProtected")} why={t("repos.check.notProtectedWhy")} />;
    case "signedNotRequired":
      return <Line glyph={<ShieldCheckIcon aria-hidden className={`${icon} text-green`} />} text={t("repos.check.signedNotRequired")} />;
    case "signedRequired":
      return (
        <Line
          glyph={<BanIcon aria-hidden className={`${icon} text-red`} />}
          text={
            <>
              {t("repos.check.signedRequired")}
              <span className="text-red">{t("repos.check.notSupportedYet")}</span>
            </>
          }
          why={t("repos.check.signedRequiredWhy")}
        />
      );
    case "protectedUnknown":
    case "signedUnknown":
    case "unknown":
      return (
        <Line
          glyph={<CircleHelpIcon aria-hidden className={`${icon} text-faint`} />}
          text={t(line.kind === "unknown" ? "repos.check.unknown" : line.kind === "protectedUnknown" ? "repos.check.protectedUnknown" : "repos.check.signedUnknown")}
          why={line.reason ?? t("repos.check.noReason")}
        />
      );
    default:
      return line satisfies never;
  }
};

/** `{repo}` set in mono inside a sentence. */
const WithRepo = ({ text, repo }: { readonly text: string; readonly repo: string }) => {
  const [before = "", after = ""] = text.split("{repo}");
  return (
    <>
      {before}
      <code className="font-mono text-xs text-text">{repo}</code>
      {after}
    </>
  );
};

/** The id the composer's Start button points its `aria-describedby` at, while a repo blocks it. */
export const repoBlockId = (projectId: string): string => `repo-block-${projectId}`;

/**
 * The checks where a task starts (the composer, the new-task form): a signed-commit repo blocks
 * Start, an unprotected branch warns. A check ostra couldn't make says nothing here.
 */
export const ComposerRepoNotes = ({ projectId, repos }: { readonly projectId: string; readonly repos: readonly RepoDetail[] }) => {
  const blocked = unsupportedRepos(repos);
  const unprotected = unprotectedRepos(repos).filter((repo) => !blocked.includes(repo));
  if (blocked.length === 0 && unprotected.length === 0) return null;
  return (
    <ul className="mt-2.5 space-y-1 text-sm text-muted" data-testid="repo-notes">
      {blocked.map((repo, i) => (
        <li key={repo.repoId} id={i === 0 ? repoBlockId(projectId) : undefined} className="flex items-start gap-2">
          <BanIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-red" />
          <span>
            <WithRepo text={t("repos.composer.unsupported")} repo={repo.fullName} />{" "}
            <Link href={`/projects/${projectId}/repos?repo=${repo.repoId}`} className="text-teal hover:underline">
              {t("repos.composer.seeRepos")}
            </Link>
          </span>
        </li>
      ))}
      {unprotected.map((repo) => (
        <li key={repo.repoId} className="flex items-start gap-2">
          <TriangleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-muted" />
          <span>
            <WithRepo text={t("repos.composer.unprotected")} repo={repo.fullName} />{" "}
            <Link href={`/projects/${projectId}/repos?repo=${repo.repoId}`} className="text-teal hover:underline">
              {t("repos.composer.why")}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
};
