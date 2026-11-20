"use client";

import { BookMarkedIcon, CheckIcon, OctagonAlertIcon, ScanSearchIcon, WrenchIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { findingStateWords } from "./review-words";
import type { ReviewFinding } from "./review-words";

// An AI review's finding on its line (review-screen.md, "A finding"): no box, a 2px `--line-2`
// rule, the header (round, severity, state), the title, the body as plain text with backtick spans
// in mono, the suggestion as a code block, and "Fix this" / "Remember this" on an open one. The
// finding's text is untrusted: it's text, never markdown or HTML.

/** Plain text with `code` spans in mono: nothing else of markdown, and no HTML. */
const withCode = (text: string): ReactNode[] =>
  text.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className="font-mono text-[12px] text-text">{part.slice(1, -1)}</code>
    ) : (
      <span key={index}>{part}</span>
    ),
  );

export type FindingActions = {
  readonly fixed: boolean;
  readonly proposalHref: string | null;
  readonly projectName: string;
  readonly canAct: boolean;
  readonly fixing: boolean;
  readonly remembering: boolean;
  readonly error: string | null;
  readonly onFix: () => void;
  readonly onRemember: () => void;
};

export const FindingBlock = ({ finding, actions }: { readonly finding: ReviewFinding; readonly actions: FindingActions }) => {
  const open = finding.state === "open";
  const quiet = finding.state !== "open";
  return (
    <div className="my-2 ml-6 mr-3 border-l-2 border-line-2 pl-3 sm:ml-[104px]" data-finding={finding.findingId} data-state={finding.state} data-severity={finding.severity}>
      <div className="flex min-h-[22px] flex-wrap items-center gap-2 text-sm">
        <ScanSearchIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />
        <span className={cn("font-semibold", quiet ? "text-muted" : "text-text")}>{t("review.finding.ai")}</span>
        <span className="font-mono text-xs text-faint">{t("review.finding.round", { n: finding.round })}</span>
        <span className={cn("inline-flex h-[22px] items-center gap-1 rounded-sm border border-line-2 px-2 text-xs", finding.severity === "blocking" ? "text-red" : "text-muted")}>
          {finding.severity === "blocking" ? <OctagonAlertIcon aria-hidden className="size-3" /> : null}
          {finding.severity === "blocking" ? t("review.finding.blocking") : t("review.finding.nit")}
        </span>
        <span className={cn("inline-flex h-[22px] items-center gap-1 rounded-sm border border-line-2 px-2 text-xs", finding.state === "outdated" ? "text-faint" : "text-muted")}>
          {finding.state === "resolved" ? <CheckIcon aria-hidden className="size-3 text-green" /> : null}
          {findingStateWords(finding.state)}
        </span>
        {finding.postedAs === "review_body" ? <span className="font-mono text-xs text-faint">{t("review.finding.line", { n: finding.line })}</span> : null}
      </div>
      <p className={cn("mt-1 text-ui font-medium", quiet ? "text-muted" : "text-text")}>{finding.title}</p>
      <p className={cn("mt-0.5 whitespace-pre-wrap text-sm leading-normal", quiet ? "text-faint" : "text-muted")}>{withCode(finding.body)}</p>
      {finding.suggestion === null ? null : (
        <div className="mt-2">
          <p className="text-xs text-faint">{t("review.finding.suggested")}</p>
          <pre className="mt-1 overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-text">{finding.suggestion}</pre>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 pb-1">
        {open ? (
          actions.fixed ? (
            <span className="flex items-center gap-1 text-xs text-faint" data-testid="finding-fixed"><CheckIcon aria-hidden className="size-3" /> {t("review.finding.added")}</span>
          ) : (
            <Button size="sm" disabled={!actions.canAct || actions.fixing} onClick={actions.onFix} data-action="fix-this" {...(actions.canAct ? {} : { title: t("review.finding.membersOnly", { project: actions.projectName }) })}>
              <WrenchIcon aria-hidden /> {t("review.finding.fix")}
            </Button>
          )
        ) : null}
        {actions.proposalHref === null ? (
          <Button size="sm" variant="ghost" disabled={!actions.canAct || actions.remembering} onClick={actions.onRemember} data-action="remember-finding" {...(actions.canAct ? {} : { title: t("review.finding.membersOnly", { project: actions.projectName }) })}>
            <BookMarkedIcon aria-hidden /> {t("review.finding.remember")}
          </Button>
        ) : (
          <span className="text-xs text-faint" data-testid="finding-proposed">
            {t("review.finding.proposed", { project: actions.projectName })}{" "}
            <Link href={actions.proposalHref} className="text-teal hover:underline">{t("review.finding.seeIt")}</Link>
          </span>
        )}
      </div>
      {actions.error === null ? null : <p role="alert" className="pb-1 text-xs text-red">{actions.error}</p>}
    </div>
  );
};
