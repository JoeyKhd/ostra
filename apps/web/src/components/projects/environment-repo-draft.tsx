"use client";

import { CheckIcon, ChevronRightIcon, ChevronsUpDownIcon, GitBranchPlusIcon, KeyRoundIcon, LockIcon, PencilIcon, VariableIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode, Ref } from "react";

import { andList } from "@/components/effort/effort-words";
import { PropGroup } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-112/c2 (Q345 option (b), environment-repo-draft.md): a repo added after the environment was
// saved has its own draft, held beside the saved setup for a project admin: the band and the draft
// above the setup script on the Setup tab (what detection found, the lines Apply adds, and Apply,
// Edit first and Dismiss), the panel's `Found in` groups, and a one-line pointer on the other tabs.
// No amber: the saved setup keeps working.

export type RepoDraft = RouterOutputs["environments"]["repoDrafts"][number];
type DraftLine = RepoDraft["lines"][number];

/** Words with `backtick` spans in mono (a repo's name, `case`): text only, never markup. */
export const withMono = (text: string, className = "font-mono text-[13px] text-text-2"): ReactNode[] =>
  text.split(/(`[^`\n]+`)/gu).map((part, index) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className={className}>{part.slice(1, -1)}</code>
    ) : (
      <span key={index}>{part}</span>
    ),
  );

const languageKey = {
  node: "environment.repoDraft.language.node",
  python: "environment.repoDraft.language.python",
  rust: "environment.repoDraft.language.rust",
  go: "environment.repoDraft.language.go",
  ruby: "environment.repoDraft.language.ruby",
} as const satisfies Record<NonNullable<RepoDraft["language"]>, MessageKey>;

/** What tasks in the repo get today, by the saved script's shape. */
const whyText = (draft: RepoDraft): string => {
  switch (draft.kind) {
    case "case":
      return t("environment.repoDraft.whyCase");
    case "plain":
      return draft.savedTool === null || draft.language === null
        ? t("environment.repoDraft.whyPlainBare")
        : t("environment.repoDraft.whyPlain", { saved: t("environment.repoDraft.savedLines", { tool: draft.savedTool }), language: t(languageKey[draft.language]) });
    case "nothing":
      return t("environment.repoDraft.whyNothing");
    default:
      return draft.kind satisfies never;
  }
};

/** Detection's one line for a folded draft: `Python · uv`. */
const summaryText = (draft: RepoDraft): string =>
  [draft.language === null ? null : t(languageKey[draft.language]), draft.tool].filter((part): part is string => part !== null).join(" · ");

/** Names in mono, as a list: `a`, `a` and `b`, `a`, `b` and `c`. */
const monoList = (names: readonly string[]): string => andList(names.map((name) => `\`${name}\``));

/**
 * The other new repos Apply gives no branch when it makes a plain script a `case` (their own drafts
 * add one): until then they set up nothing, so the draft names them under its diff.
 */
export const leftOutText = (leftOut: readonly string[]): string | null =>
  leftOut.length === 0 ? null : plural(leftOut.length, "environment.repoDraft.leftOutOne", "environment.repoDraft.leftOutMany", { repos: monoList(leftOut) });

/** The secrets Apply couldn't keep without a value, named after the save. */
export const appliedSecretsText = (secrets: readonly string[]): string =>
  plural(secrets.length, "environment.repoDraft.appliedSecretsOne", "environment.repoDraft.appliedSecretsMany", { names: monoList(secrets) });

const addedByText = (draft: RepoDraft, now: number): string =>
  t("environment.repoDraft.addedBy", { name: draft.createdBy ?? t("environment.repoDraft.someone"), age: formatElapsed(draft.createdAt, now) });

/** A run of the diff: lines to show, or unchanged lines folded into one row that opens them. */
type DiffPart = { readonly kind: "lines"; readonly lines: readonly DraftLine[] } | { readonly kind: "fold"; readonly id: number; readonly lines: readonly DraftLine[] };

/**
 * The lines as the diff block shows them: every added line, with one unchanged line of context on
 * each side, and each longer run of unchanged lines folded into a row (a fold of one line is just
 * the line).
 */
export const diffParts = (lines: readonly DraftLine[]): readonly DiffPart[] => {
  const parts: DiffPart[] = [];
  let shown: DraftLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === "add") {
      shown.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (lines[end]?.kind === "same") end += 1;
    const run = lines.slice(index, end);
    const before = index > 0 ? 1 : 0;
    const after = end < lines.length ? 1 : 0;
    const hidden = run.length - before - after;
    if (hidden < 2) {
      shown.push(...run);
    } else {
      shown.push(...run.slice(0, before));
      if (shown.length > 0) parts.push({ kind: "lines", lines: shown });
      shown = [];
      parts.push({ kind: "fold", id: index, lines: run.slice(before, run.length - after) });
      shown.push(...run.slice(run.length - after));
    }
    index = end;
  }
  if (shown.length > 0) parts.push({ kind: "lines", lines: shown });
  return parts;
};

const DiffRow = ({ line }: { readonly line: DraftLine }) => (
  <div className={cn("grid grid-cols-[26px_minmax(0,1fr)] whitespace-pre pr-3", line.kind === "add" && "bg-diff-add")} data-line={line.kind}>
    <span aria-hidden className={cn("text-center", line.kind === "add" ? "text-green" : "text-faint")}>{line.kind === "add" ? "+" : ""}</span>
    <span>
      {line.kind === "add" ? <span className="sr-only">{t("environment.repoDraft.added")} </span> : null}
      {line.text === "" ? "​" : line.text}
    </span>
  </div>
);

/** What Apply adds to the setup script: added lines in `--diff-add`, unchanged runs folded. */
const DiffBlock = ({ lines }: { readonly lines: readonly DraftLine[] }) => {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  return (
    <div className="overflow-x-auto rounded-lg border border-line-2 bg-surface py-[5px] font-mono text-[13px] leading-[22px] text-text max-md:text-[12.5px] max-md:leading-[21px]" data-testid="repo-draft-diff">
      <div className="w-max min-w-full">
        {diffParts(lines).map((part, i) =>
          part.kind === "lines" ? (
            part.lines.map((line, j) => <DiffRow key={`${String(i)}-${String(j)}`} line={line} />)
          ) : open.has(part.id) ? (
            part.lines.map((line, j) => <DiffRow key={`${String(i)}-${String(j)}`} line={line} />)
          ) : (
            <button
              key={`fold-${String(part.id)}`}
              type="button"
              aria-expanded={false}
              className="grid w-full grid-cols-[26px_minmax(0,1fr)] items-center pr-3 text-left font-sans text-[12.5px] leading-[22px] text-faint hover:text-muted"
              onClick={() => { setOpen((current) => new Set([...current, part.id])); }}
            >
              <span className="grid place-items-center"><ChevronsUpDownIcon aria-hidden className="size-3 stroke-[1.75]" /></span>
              <span>{t("environment.repoDraft.unchanged", { n: part.lines.length })}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
};

/** The outline chip of the draft (`secret`, `new`): `--line-2`, 11.5px. */
export const DraftChip = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-line-2 px-[7px] font-sans text-[11.5px] font-medium text-muted [&_svg]:size-3", className)}>{children}</span>
);

const VariableRows = ({ draft }: { readonly draft: RepoDraft }) => (
  <ul className="border-t border-line" aria-label={t("environment.repoDraft.variables")}>
    {draft.variables.map((variable) => {
      const Icon = variable.secret ? KeyRoundIcon : VariableIcon;
      return (
        <li key={variable.name} className="grid min-h-10 grid-cols-[20px_20px_minmax(0,1fr)_auto] items-center border-b border-line font-mono text-[13px] md:min-h-[34px] md:grid-cols-[26px_22px_210px_minmax(0,1fr)_auto] md:text-[13.5px]">
          <span aria-hidden className="text-center text-green">+</span>
          <Icon role="img" aria-label={t(variable.secret ? "environment.kind.secret" : "environment.kind.variable")} className="size-[14px] stroke-[1.75] text-faint" />
          <span className="truncate text-text">{variable.name}</span>
          <span className="hidden font-sans text-[13px] text-faint md:inline">{t("environment.repoDraft.noValue")}</span>
          {variable.secret ? (
            <DraftChip>
              <LockIcon aria-hidden className="stroke-[1.75]" />
              {t("environment.secretBadge")}
            </DraftChip>
          ) : <span />}
        </li>
      );
    })}
  </ul>
);

export type DraftActions = {
  readonly admin: boolean;
  /** The repo whose Apply is saving, if any: every draft's buttons wait meanwhile. */
  readonly applying: string | null;
  readonly busy: boolean;
  readonly error: { readonly repoId: string; readonly text: string } | null;
  readonly onApply: (draft: RepoDraft) => void;
  readonly onEditFirst: (draft: RepoDraft) => void;
  readonly onDismiss: (draft: RepoDraft) => void;
};

const DraftButtons = ({ draft, actions, phone }: { readonly draft: RepoDraft; readonly actions: DraftActions; readonly phone: boolean }) => {
  const disabled = actions.busy || actions.applying !== null;
  const applyLabel = actions.applying === draft.repoId ? t("environment.repoDraft.applying") : t("environment.repoDraft.apply");
  const dismiss = (
    <Button variant="ghost" size="sm" className={cn(phone ? "h-11 w-full text-[15px]" : "h-7 px-2.5 text-[13px]")} disabled={disabled} onClick={() => { actions.onDismiss(draft); }}>
      {t("environment.repoDraft.dismiss")}
    </Button>
  );
  if (draft.kind === "nothing") {
    return phone ? <div className="mt-3">{dismiss}</div> : dismiss;
  }
  const editFirst = (
    <Button size="sm" className={cn(phone ? "h-11 w-full text-[15px]" : "h-7 px-2.5 text-[13px]")} disabled={disabled} onClick={() => { actions.onEditFirst(draft); }} data-action="edit-first">
      {t("environment.repoDraft.editFirst")}
    </Button>
  );
  const apply = (
    <Button size="sm" className={cn(phone ? "h-11 w-full text-[15px]" : "h-7 px-2.5 text-[13px]")} disabled={disabled} onClick={() => { actions.onApply(draft); }} data-action="apply">
      {applyLabel}
    </Button>
  );
  // In the order they're read: Dismiss, Edit first, Apply. On a phone, Apply and Edit first side by side, Dismiss under them.
  return phone ? (
    <div className="mt-3 space-y-1">
      <div className="grid grid-cols-2 gap-2">{apply}{editFirst}</div>
      {dismiss}
    </div>
  ) : (
    <>
      {dismiss}
      {editFirst}
      {apply}
    </>
  );
};

/** One new repo's draft: its head, why, the lines Apply adds and its variables, and its foot. */
const Draft = ({ draft, actions, now, folded, onToggle, many }: { readonly draft: RepoDraft; readonly actions: DraftActions; readonly now: number; readonly folded: boolean; readonly onToggle: () => void; readonly many: boolean }) => {
  const error = actions.error?.repoId === draft.repoId ? actions.error.text : null;
  const leftOut = leftOutText(draft.leftOut);
  const name =<span className="truncate font-mono text-[15px] font-semibold text-text md:text-body">{draft.fullName}</span>;
  return (
    <div className="border-b border-line px-0.5 pb-3.5 pt-2.5 md:px-3 md:pt-3" data-testid="repo-draft" data-repo={draft.fullName}>
      <div className="flex min-h-[30px] items-center gap-2.5 whitespace-nowrap">
        {many ? (
          <button type="button" aria-expanded={!folded} className="-ml-1 flex min-w-0 items-center gap-2.5 rounded-sm px-1 text-left hover:bg-hover" onClick={onToggle}>
            <ChevronRightIcon aria-hidden className={cn("size-[14px] shrink-0 stroke-[1.75] text-faint transition-transform", !folded && "rotate-90")} />
            {name}
          </button>
        ) : (
          name
        )}
        <span className={cn("min-w-0 truncate text-sm text-faint", !folded && "max-md:hidden")}>{folded ? summaryText(draft) : addedByText(draft, now)}</span>
        {actions.admin ? (
          <span className="ml-auto hidden items-center gap-1.5 md:flex">
            <DraftButtons draft={draft} actions={actions} phone={false} />
          </span>
        ) : null}
      </div>
      {folded ? null : (
        <>
          <p className="text-sm text-faint md:hidden">{addedByText(draft, now)}</p>
          {error === null ? null : <p role="alert" className="mt-1 text-[13.5px] text-red">{error}</p>}
          <p className="mt-0.5 max-w-[640px] text-[14px] leading-normal text-muted md:text-[13.5px]">{withMono(whyText(draft))}</p>
          {draft.kind === "nothing" ? null : (
            <>
              <div className="mb-[5px] mt-3 flex items-baseline gap-2 text-[13px] font-medium text-muted">
                {t("environment.repoDraft.script")}
                <span className="text-[12.5px] font-normal text-faint">{t("environment.repoDraft.scriptNote")}</span>
              </div>
              <DiffBlock lines={draft.lines} />
              {leftOut === null ? null : (
                <p className="mt-1.5 max-w-[640px] text-[14px] leading-normal text-muted md:text-[13px]" data-testid="repo-draft-left-out">
                  {withMono(leftOut, "font-mono text-[12.5px] text-text-2")}
                </p>
              )}
              {draft.variables.length === 0 ? null : (
                <>
                  <div className="mb-[5px] mt-3 flex items-baseline gap-2 text-[13px] font-medium text-muted">
                    {t("environment.repoDraft.variables")}
                    <span className="text-[12.5px] font-normal text-faint">{withMono(t("environment.repoDraft.writtenTo", { file: `\`${draft.envFile}\`` }), "font-mono text-[12.5px]")}</span>
                  </div>
                  <VariableRows draft={draft} />
                </>
              )}
            </>
          )}
          {actions.admin ? (
            draft.kind === "nothing" ? null : <p className="mt-2 text-sm text-faint md:mt-2.5">{t("environment.repoDraft.foot")}</p>
          ) : (
            <p className="mt-2 text-sm text-faint md:mt-2.5">{t("environment.repoDraft.footMember")}</p>
          )}
          {actions.admin ? (
            <div className="md:hidden">
              <DraftButtons draft={draft} actions={actions} phone />
            </div>
          ) : null}
        </>
      )}
      {folded && actions.admin ? (
        <div className="mt-2 flex gap-1.5 md:hidden">
          <DraftButtons draft={draft} actions={actions} phone={false} />
        </div>
      ) : null}
    </div>
  );
};

/** The band and each new repo's draft, between the tabs and the setup script (the Setup tab). */
export const RepoDraftBand = ({ drafts, actions, now, bandRef }: { readonly drafts: readonly RepoDraft[]; readonly actions: DraftActions; readonly now: number; readonly bandRef?: Ref<HTMLDivElement> }) => {
  // The first open, the others folded to their head.
  const [openIds, setOpenIds] = useState<ReadonlySet<string> | null>(null);
  const many = drafts.length > 1;
  const isOpen = (draft: RepoDraft, index: number) => (openIds === null ? index === 0 : openIds.has(draft.repoId));
  return (
    <section className="mt-[18px]" aria-labelledby="repo-draft-band" data-testid="repo-draft-band">
      <div ref={bandRef} tabIndex={-1} className="flex h-[34px] items-center gap-[9px] rounded-[6px] bg-surface px-3 outline-none">
        <GitBranchPlusIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
        <h2 id="repo-draft-band" className="text-body font-semibold text-text">{many ? t("environment.repoDraft.bandMany") : t("environment.repoDraft.band")}</h2>
        <span className="font-mono text-sm font-medium text-faint">{drafts.length}</span>
      </div>
      {drafts.map((draft, index) => (
        <Draft
          key={draft.repoId}
          draft={draft}
          actions={actions}
          now={now}
          many={many}
          folded={many && !isOpen(draft, index)}
          onToggle={() => {
            setOpenIds((current) => {
              const next = new Set(current ?? (drafts[0] === undefined ? [] : [drafts[0].repoId]));
              if (next.has(draft.repoId)) next.delete(draft.repoId);
              else next.add(draft.repoId);
              return next;
            });
          }}
        />
      ))}
    </section>
  );
};

/** After "Edit first": the band as one line, with a 2px `--teal` rule, until the save or Cancel. */
export const RepoDraftEditing = ({ fullName, onCancel }: { readonly fullName: string; readonly onCancel: () => void }) => (
  <div className="mt-3 flex min-h-9 items-center gap-[9px] border-l-2 border-teal pl-3 text-ui text-text" data-testid="repo-draft-editing" role="status">
    <PencilIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
    <span className="min-w-0">
      {withMono(t("environment.repoDraft.editing", { repo: `\`${fullName}\`` }), "font-mono text-[13.5px] text-text")}{" "}
      <span className="text-muted">{t("environment.repoDraft.editingSave")}</span>
    </span>
    <Button variant="ghost" size="sm" className="ml-auto h-7 px-2.5 text-[13px]" onClick={onCancel}>{t("common.cancel")}</Button>
  </div>
);

/** "Dismissed." with Undo until the page is left, or the applied draft's save line. */
export const RepoDraftStatus = ({ said, onUndo, undoing }: { readonly said: { readonly kind: "dismissed" | "applied"; readonly fullName: string; readonly secrets: readonly string[] }; readonly onUndo: () => void; readonly undoing: boolean }) =>
  said.kind === "dismissed" ? (
    <p role="status" className="mt-3 flex min-h-9 flex-wrap items-center gap-x-1.5 text-ui text-muted" data-testid="repo-draft-said">
      <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />
      <span>{withMono(t("environment.repoDraft.dismissed", { repo: `\`${said.fullName}\`` }), "font-mono text-[13.5px] text-text")}</span>
      <button type="button" className="text-teal hover:underline disabled:opacity-50" disabled={undoing} onClick={onUndo}>{t("environment.repoDraft.undo")}</button>
    </p>
  ) : (
    <div role="status" className="mt-3 text-ui" data-testid="repo-draft-said">
      <p className="flex min-h-9 flex-wrap items-center gap-x-1.5 text-green">
        <CheckIcon aria-hidden className="size-[14px] stroke-[2]" />
        <span>{withMono(t("environment.repoDraft.applied", { repo: `\`${said.fullName}\`` }), "font-mono text-[13.5px]")}</span>
      </p>
      {said.secrets.length === 0 ? null : <p className="text-muted">{withMono(appliedSecretsText(said.secrets), "font-mono text-[13.5px] text-text")}</p>}
    </div>
  );

/** The other tabs' pointer: the band as one 36px line, with `Review it on Setup`. */
export const RepoDraftPointer = ({ count, onReview }: { readonly count: number; readonly onReview: () => void }) => (
  <p className="mt-2 flex min-h-9 items-center gap-2 text-ui text-text" data-testid="repo-draft-pointer">
    <GitBranchPlusIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
    {count > 1 ? t("environment.repoDraft.bandMany") : t("environment.repoDraft.band")}
    <span className="font-mono text-sm text-faint">{count}</span>
    <button type="button" className="text-teal hover:underline" onClick={onReview}>{t("environment.repoDraft.elsewhere")}</button>
  </p>
);

/** The panel's groups for each new repo, in the band's order: what detection found, its tools, and any services. */
export const RepoDraftProperties = ({ drafts, admin, onServices }: { readonly drafts: readonly RepoDraft[]; readonly admin: boolean; readonly onServices: () => void }) => (
  <>
    {drafts.map((draft) => (
      <div key={draft.repoId} data-testid="repo-draft-found">
        <PropGroup title={t("environment.foundIn", { repo: draft.fullName })}>
          {draft.reasons.length === 0 ? (
            <p className="text-ui text-muted">{t("environment.nothingFound")}</p>
          ) : (
            <ul className="space-y-[7px]">
              {draft.reasons.map((reason, i) => (
                <li key={`${reason.file}-${String(i)}`}>
                  <span className="block font-mono text-[13.5px] text-text">{reason.file}</span>
                  <span className="block text-sm text-muted">{withMono(reason.finding, "font-mono text-[12.5px] text-muted")}</span>
                </li>
              ))}
            </ul>
          )}
        </PropGroup>
        {draft.tools.length === 0 ? null : (
          <PropGroup title={t("environment.tools")}>
            <ul className="flex flex-wrap gap-1.5">
              {draft.tools.map((tool) => (
                <li key={`${tool.tool}-${tool.source}`}>
                  <span className="inline-flex h-6 items-center rounded-[5px] border border-line-2 px-[7px] font-mono text-[12.5px] text-text-2">{tool.tool} {tool.version}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-faint">{admin ? t("environment.repoDraft.toolsHelp") : t("environment.repoDraft.toolsHelpMember")}</p>
          </PropGroup>
        )}
        {draft.services.length === 0 ? null : (
          <PropGroup title={t("environment.services")}>
            <ul>
              {draft.services.map((service) => (
                <li key={service.name} className="flex h-[30px] items-center gap-3 text-ui">
                  <span className="font-mono text-text">{service.name}</span>
                  {service.image === null ? null : <span className="min-w-0 truncate font-mono text-faint">{service.image}</span>}
                  <DraftChip className="ml-auto font-mono">{t("environment.notOnHost")}</DraftChip>
                </li>
              ))}
            </ul>
            <button type="button" className="mt-1.5 text-sm text-teal hover:underline" onClick={onServices}>{t("environment.repoDraft.servicesHelp")}</button>
          </PropGroup>
        )}
      </div>
    ))}
  </>
);
