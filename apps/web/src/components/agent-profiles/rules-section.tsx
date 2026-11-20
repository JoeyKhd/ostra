"use client";

import { CheckIcon, FilePenIcon, GlobeIcon, MinusIcon, PlugIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import type { ApprovalRulePreset, ApprovalTool } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chip } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { EditorSection } from "./editor-section";
import { matchText } from "./profile-words";
import { anyMatchKey, longMatch, matchKey, matchKindsFor, ruleProblem, takesText, toolKey, withTool } from "./rule-drafts";
import type { RuleDraft } from "./rule-drafts";

// The editor's Approval rules section (agent-profile.md, "Approval rules"): the four presets as
// one-click rules that open editable, each rule's tool and match, the open rule's coverage line, and
// the custom rule.

export const presetOrder: readonly ApprovalRulePreset[] = ["dependency", "migration", "allowlist", "network"];

const presetKey = {
  dependency: "agentProfiles.presets.dependency",
  migration: "agentProfiles.presets.migration",
  allowlist: "agentProfiles.presets.allowlist",
  network: "agentProfiles.presets.network",
} as const;

const tools: readonly ApprovalTool[] = ["edit", "execute", "fetch", "mcp"];

export const ToolIcon = ({ tool, className }: { readonly tool: ApprovalTool; readonly className?: string }) => {
  const props = { "aria-hidden": true, className: cn("size-[15px] shrink-0 stroke-[1.75] text-faint", className) } as const;
  switch (tool) {
    case "edit":
      return <FilePenIcon {...props} />;
    case "execute":
      return <TerminalIcon {...props} />;
    case "fetch":
      return <GlobeIcon {...props} />;
    case "mcp":
      return <PlugIcon {...props} />;
    default:
      return tool satisfies never;
  }
};

/** What the open rule covers on the sample subjects: the first matched and the first unmatched. */
export type Coverage = { readonly matched: string | null; readonly unmatched: string | null };

const CoverageLine = ({ draft, coverage }: { readonly draft: RuleDraft; readonly coverage: Coverage | undefined }) => {
  if (coverage === undefined) return <p className="mt-2 h-5 text-ui text-faint" aria-hidden />;
  const commands = draft.tool === "execute";
  if (coverage.matched === null) {
    return (
      <p className="mt-2 text-ui text-muted" data-testid="rule-coverage">
        {commands ? t("agentProfiles.rules.matchesNoneCommands") : t("agentProfiles.rules.matchesNone")}
      </p>
    );
  }
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui" data-testid="rule-coverage">
      <span className="flex min-w-0 items-center gap-1.5">
        <CheckIcon aria-hidden className="size-[13px] shrink-0 text-muted" />
        <span className="text-muted">{t("agentProfiles.rules.asksFor")}</span>
        <span className="truncate font-mono text-text">{coverage.matched}</span>
      </span>
      {coverage.unmatched === null ? null : (
        <span className="flex min-w-0 items-center gap-1.5">
          <MinusIcon aria-hidden className="size-[13px] shrink-0 text-faint" />
          <span className="text-faint">{t("agentProfiles.rules.notFor")}</span>
          <span className="truncate font-mono text-faint">{coverage.unmatched}</span>
        </span>
      )}
    </p>
  );
};

/** A rule open for editing: a 2px `--line-2` left rule, never a card. */
const OpenRule = ({ draft, coverage, onChange, onDone }: {
  readonly draft: RuleDraft;
  readonly coverage: Coverage | undefined;
  readonly onChange: (draft: RuleDraft) => void;
  readonly onDone: () => void;
}) => {
  const id = useId();
  const problem = ruleProblem(draft);
  const kinds = matchKindsFor(draft.tool);
  return (
    <li className="border-b border-line py-2.5" data-rule-open={draft.name}>
      <div className="border-l-2 border-line-2 pl-3">
        <label htmlFor={`${id}-name`} className="mb-1.5 block text-xs font-medium text-muted">{t("agentProfiles.rules.name")}</label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${id}-name`}
            value={draft.name}
            onChange={(event) => { onChange({ ...draft, name: event.target.value }); }}
            className="h-8 w-full sm:w-[200px]"
            aria-invalid={problem?.key === "agentProfiles.rules.errorName"}
          />
          <Select value={draft.tool} onValueChange={(value) => { onChange(withTool(draft, tools.find((tool) => tool === value) ?? draft.tool)); }}>
            <SelectTrigger className="h-8 w-[150px]" aria-label={t("agentProfiles.rules.toolLabel")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {tools.map((tool) => <SelectItem key={tool} value={tool}>{t(toolKey(tool))}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={draft.matchKind}
            onValueChange={(value) => {
              const kind = kinds.find((entry) => entry === value);
              if (kind !== undefined) onChange({ ...draft, matchKind: kind, text: takesText(kind) && takesText(draft.matchKind) ? draft.text : "" });
            }}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label={t("agentProfiles.rules.matchLabel")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {kinds.map((kind) => <SelectItem key={kind} value={kind}>{kind === "any" ? t(anyMatchKey(draft.tool)) : t(matchKey(kind))}</SelectItem>)}
            </SelectContent>
          </Select>
          {takesText(draft.matchKind) ? (
            <Input
              value={draft.text}
              onChange={(event) => { onChange({ ...draft, text: event.target.value }); }}
              aria-label={t("agentProfiles.rules.matchInput")}
              aria-invalid={problem !== null && problem.key !== "agentProfiles.rules.errorName"}
              className="h-8 min-w-[140px] flex-1 font-mono text-ui"
              spellCheck={false}
            />
          ) : null}
        </div>
        {problem === null ? null : (
          <p role="alert" className="mt-1.5 text-sm text-red">{t(problem.key, problem.reason === undefined ? undefined : { reason: problem.reason })}</p>
        )}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">{problem === null ? <CoverageLine draft={draft} coverage={coverage} /> : null}</div>
          <Button size="sm" className="mt-1.5 shrink-0" onClick={onDone} disabled={problem !== null}>{t("agentProfiles.rules.done")}</Button>
        </div>
      </div>
    </li>
  );
};

const ClosedRule = ({ draft, readOnly, onEdit, onRemove }: {
  readonly draft: RuleDraft;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) => {
  const match = matchText(longMatch(draft));
  return (
    <li className="flex items-center gap-3 border-b border-line py-[9px]" data-rule={draft.name}>
      <ToolIcon tool={draft.tool} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body text-text">{draft.name}</span>
          {draft.preset === null ? null : <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("agentProfiles.preset")}</Chip>}
        </div>
        <div className="truncate text-sm text-faint" title={match}>
          {t(toolKey(draft.tool))} <span aria-hidden>·</span> <span className="font-mono">{match}</span>
        </div>
      </div>
      {readOnly ? null : (
        <>
          <Button variant="link" className="shrink-0 text-ui font-normal no-underline hover:underline" onClick={onEdit}>{t("agentProfiles.editor.edit")}</Button>
          <RemoveButton label={t("agentProfiles.editor.remove", { name: draft.name })} onClick={onRemove} />
        </>
      )}
    </li>
  );
};

/** The ghost `x` at a row's end: `--faint`, `--red` on hover. */
export const RemoveButton = ({ label, onClick }: { readonly label: string; readonly onClick: () => void }) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded-sm text-faint hover:bg-sel hover:text-red">
    <XIcon aria-hidden className="size-[14px]" />
  </button>
);

/** A ghost add button under a list: `plus` and `--muted` text. */
export const AddButton = ({ children, onClick, disabled }: { readonly children: ReactNode; readonly onClick: () => void; readonly disabled?: boolean }) => (
  <Button variant="ghost" size="sm" className="-ml-1.5 [&_svg]:size-[13px]" onClick={onClick} disabled={disabled}>
    <PlusIcon aria-hidden /> {children}
  </Button>
);

export type RulesSectionProps = {
  readonly rules: readonly RuleDraft[];
  readonly openKey: string | null;
  readonly readOnly: boolean;
  readonly coverage: Coverage | undefined;
  readonly onChange: (rules: readonly RuleDraft[]) => void;
  readonly onOpen: (key: string | null) => void;
  readonly onPreset: (preset: ApprovalRulePreset) => void;
  readonly onCustom: () => void;
};

export const RulesSection = ({ rules, openKey, readOnly, coverage, onChange, onOpen, onPreset, onCustom }: RulesSectionProps) => {
  const used = new Set(rules.flatMap((rule) => (rule.preset === null ? [] : [rule.preset])));
  return (
    <EditorSection title={t("agentProfiles.editor.rules")} count={rules.length} note={t("agentProfiles.editor.rulesNote")}>
      {readOnly ? null : (
        <div className="mb-2.5 flex flex-wrap gap-2" data-testid="rule-presets">
          {presetOrder.map((preset) => {
            const done = used.has(preset);
            const button = (
              <button
                type="button"
                key={preset}
                disabled={done}
                aria-disabled={done}
                onClick={() => { onPreset(preset); }}
                className={cn(
                  "inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-control-line px-2.5 text-sm [&_svg]:size-[13px]",
                  done ? "cursor-default text-faint" : "text-muted hover:bg-sel hover:text-text",
                )}
              >
                {done ? <CheckIcon aria-hidden /> : <PlusIcon aria-hidden />}
                {t(presetKey[preset])}
              </button>
            );
            return done ? (
              <Tooltip key={preset} content={t("agentProfiles.editor.alreadyIn")}>
                <span tabIndex={0}>{button}</span>
              </Tooltip>
            ) : button;
          })}
        </div>
      )}
      {rules.length === 0 ? (
        <p className="flex h-10 items-center border-y border-line text-ui text-faint">{t("agentProfiles.editor.noRules")}</p>
      ) : (
        <ul className="border-t border-line" data-testid="rules">
          {rules.map((rule, index) =>
            rule.key === openKey && !readOnly ? (
              <OpenRule
                key={rule.key}
                draft={rule}
                coverage={coverage}
                onChange={(next) => { onChange(rules.map((entry, i) => (i === index ? next : entry))); }}
                onDone={() => { onOpen(null); }}
              />
            ) : (
              <ClosedRule
                key={rule.key}
                draft={rule}
                readOnly={readOnly}
                onEdit={() => { onOpen(rule.key); }}
                onRemove={() => {
                  onChange(rules.filter((_, i) => i !== index));
                  if (openKey === rule.key) onOpen(null);
                }}
              />
            ),
          )}
        </ul>
      )}
      {readOnly ? null : <div className="mt-2"><AddButton onClick={onCustom}>{t("agentProfiles.editor.customRule")}</AddButton></div>}
    </EditorSection>
  );
};
