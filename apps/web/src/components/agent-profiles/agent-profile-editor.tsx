"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { modelIdSchema } from "@ostra/protocol";
import type { AgentProfileId, ApprovalRulePreset } from "@ostra/protocol";

import { PageFrame } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { EditorSection } from "./editor-section";
import { EffortField, effortChoiceOf } from "./effort-field";
import { draftFromDetail, draftProblem, isDirty, modelsOfProvider, newDraft, nextKey, sameModel, saveInputOf, withProvider } from "./editor-draft";
import type { ModelName, ProfileDraft, SkillDraft } from "./editor-draft";
import { McpSection } from "./mcp-section";
import { ModelInProjects, ModelPicker } from "./model-picker";
import type { ModelOption } from "./model-picker";
import { EditorPanel } from "./profile-editor-panel";
import type { ProfileDetail } from "./profile-types";
import type { RouterOutputs } from "@/lib/trpc";
import { dayText, modelName } from "./profile-words";
import { draftToRules, emptyRule, groupRules } from "./rule-drafts";
import { RulesSection } from "./rules-section";
import { RunnerLabelsSection } from "./runner-labels-section";
import type { Coverage } from "./rules-section";
import { SkillsSection } from "./skills-section";

// One agent profile's editor (F-021, F-026, F-063; agent-profile.md): the main column holds the
// agent and model, instructions, skills, MCP servers and approval rules; the panel holds plan
// first, who may use it, the defaults and archive. "Save profile" saves it all at once.

/** One of the organization's providers, with each project's allowance (F-135, ADR 0065 amended 2026-11-20). */
type ProviderOption = RouterOutputs["agentProfiles"]["providerOptions"][number];

const newId = (): string => crypto.randomUUID();

/** The typed name, or `fallback` while it's empty. */
const nameOr = (name: string | undefined, fallback: string): string => {
  const typed = name?.trim() ?? "";
  return typed === "" ? fallback : typed;
};

/** The value after `ms` without a change: the coverage line waits 300ms. */
const useDebounced = <T,>(value: T, ms: number): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setSettled(value); }, ms);
    return () => { clearTimeout(timer); };
  }, [value, ms]);
  return settled;
};

/** Leaving the page with unsaved changes asks first: links in the page and the browser's own leave. */
const useLeaveGuard = (dirty: boolean, onLeaveAttempt: (href: string) => void): void => {
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    const click = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      onLeaveAttempt(`${url.pathname}${url.search}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, onLeaveAttempt]);
};

/** The instructions box: Plex Mono, at least three lines, growing with its text. */
const Instructions = ({ value, readOnly, onChange }: { readonly value: string; readonly readOnly: boolean; readonly onChange: (value: string) => void }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (box === null) return;
    box.style.height = "auto";
    box.style.height = `${String(box.scrollHeight + 2)}px`;
  }, [value]);
  return (
    <Textarea
      ref={ref}
      value={value}
      readOnly={readOnly}
      aria-label={t("agentProfiles.editor.instructions")}
      placeholder={t("agentProfiles.editor.instructionsPlaceholder")}
      rows={2}
      spellCheck={false}
      onChange={(event) => { onChange(event.target.value); }}
      className="min-h-[64px] resize-none overflow-hidden rounded-lg px-3.5 py-2.5 font-mono text-ui leading-[1.75]"
    />
  );
};

/** The words of a model by name: a catalog ID or a custom model's endpoint ID. */
const modelText = (name: ModelName): string => (name.kind === "catalog" ? name.catalogId : name.endpointModelId);

/** `globex-shop doesn't allow Client B…`, or `2 projects don't…`; `null` when every project allows it. */
const notAllowedText = (provider: ProviderOption | undefined): string | null => {
  const blocked = (provider?.projects ?? []).filter((project) => !project.allowed);
  const [only] = blocked;
  if (provider === undefined || only === undefined) return null;
  return blocked.length === 1
    ? t("agentProfiles.editor.providerNotAllowedIn", { projects: only.name, provider: provider.name })
    : t("agentProfiles.editor.providerNotAllowedInMany", { n: blocked.length, provider: provider.name });
};

/**
 * Agent and model (agent-profile-model.md, ADR 0065 amended 2026-11-20): Name, Agent and Provider
 * in one row, then the Model the provider lists, then its Effort (one per line below 900px). The
 * provider comes first: "you should first select the provider and then you get to see which models
 * are available under that provider" (the maintainer, 2026-11-20).
 */
const AgentAndModel = ({ draft, readOnly, detail, options, providers, onChange, onHighlight }: {
  readonly draft: ProfileDraft;
  readonly readOnly: boolean;
  readonly detail: ProfileDetail | null;
  readonly options: readonly ModelOption[] | undefined;
  /** The organization's providers, by name (`agentProfiles.providerOptions`); `undefined` while they load. */
  readonly providers: readonly ProviderOption[] | undefined;
  readonly onChange: (draft: ProfileDraft) => void;
  readonly onHighlight: (option: ModelOption | null) => void;
}) => {
  const id = useId();
  const trpc = useTRPC();
  const agents = useQuery(trpc.agentProfiles.agents.queryOptions());
  const provider = providers?.find((entry) => entry.providerId === draft.providerId);
  // Only the chosen provider's models, with its own listing of each (none before a provider is picked).
  const offered = useMemo(() => (options === undefined ? undefined : modelsOfProvider(options, draft.providerId)), [options, draft.providerId]);
  const chosen = offered?.find((option) => sameModel(option.name, draft.model));
  const chosenKey = chosen?.text ?? null;
  // F-137: the levels the agent offers on the chosen model, on its provider's row, rebuilt as either changes.
  const effortModelId = chosen?.providers[0]?.modelId ?? detail?.model?.id ?? null;
  const effort = useQuery(
    trpc.agentProfiles.effortLevels.queryOptions(effortModelId === null ? skipToken : { adapter: draft.adapter, modelId: modelIdSchema.parse(effortModelId) }),
  );
  const label = "mb-1.5 block text-sm font-medium text-muted";
  const savedModelText = draft.model === null ? "" : detail?.model !== null && detail?.model !== undefined && sameModel(draft.model, detail.modelName) ? modelName(detail.model) : modelText(draft.model);
  // A profile saved before the profile's provider: it names none yet, and the editor asks for one.
  const unset = draft.providerId === null && detail !== null && detail.provider === null && draft.model !== null;
  const notListed = provider !== undefined && offered !== undefined && draft.model !== null && chosen === undefined;
  const blocked = readOnly ? null : notAllowedText(provider);

  return (
    <EditorSection title={t("agentProfiles.editor.agentAndModel")}>
      <div className="grid gap-3 min-[900px]:grid-cols-[212px_190px_minmax(0,1fr)]">
        <div className="min-w-0">
          <label htmlFor={`${id}-name`} className={label}>{t("agentProfiles.editor.name")}</label>
          {readOnly ? <p className="flex h-8 items-center text-body">{draft.name}</p> : (
            <Input id={`${id}-name`} value={draft.name} maxLength={100} onChange={(event) => { onChange({ ...draft, name: event.target.value }); }} className="h-8" data-testid="profile-name" />
          )}
        </div>
        <div className="min-w-0">
          <label id={`${id}-agent`} className={label}>{t("agentProfiles.editor.agent")}</label>
          {readOnly ? <p className="flex h-8 items-center text-body">{detail?.agentName ?? draft.adapter}</p> : (
            <Select value={draft.adapter} onValueChange={(adapter) => { onChange({ ...draft, adapter }); }}>
              <SelectTrigger className="h-8 w-full bg-surface" aria-labelledby={`${id}-agent`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {(agents.data ?? [{ adapter: draft.adapter, name: detail?.agentName ?? draft.adapter }]).map((agent) => (
                  <SelectItem key={agent.adapter} value={agent.adapter}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="min-w-0">
          <label id={`${id}-provider`} className={label}>{t("agentProfiles.editor.provider")}</label>
          {readOnly ? (
            <p className="flex h-8 min-w-0 items-center text-body" data-testid="profile-provider">
              {detail?.provider === null || detail?.provider === undefined ? (
                <span className="truncate text-muted">{t("agentProfiles.editor.providerNone", { model: savedModelText })}</span>
              ) : (
                <span className="truncate">{detail.provider.name}</span>
              )}
            </p>
          ) : providers === undefined ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <Select
              value={draft.providerId ?? ""}
              onValueChange={(value) => {
                const next = providers.find((entry) => entry.providerId === value);
                if (next !== undefined) onChange(withProvider(draft, next.providerId, options ?? []));
              }}
            >
              <SelectTrigger className="h-8 w-full bg-surface" aria-labelledby={`${id}-provider`} data-testid="profile-provider">
                <SelectValue placeholder={t("agentProfiles.editor.pickProviderPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((entry) => (
                  <SelectItem key={entry.providerId} value={entry.providerId} data-provider={entry.name}>{entry.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="min-w-0 min-[900px]:col-span-3 min-[900px]:max-w-[520px]">
          <label id={`${id}-model`} className={label}>{t("agentProfiles.editor.model")}</label>
          {readOnly ? (
            <p className="flex h-8 items-center text-body">{detail?.model === null || detail?.model === undefined ? <span className="text-red">{t("agentProfiles.noModel")}</span> : modelName(detail.model)}</p>
          ) : draft.providerId === null ? (
            <button type="button" disabled className="flex h-8 w-full items-center rounded-[7px] border border-line-2 bg-surface px-2.5 text-left text-faint" data-testid="profile-model">
              {draft.model === null ? t("agentProfiles.editor.pickProviderFirst") : savedModelText}
            </button>
          ) : (
            <ModelPicker
              options={offered}
              chosenKey={chosenKey}
              loading={offered === undefined}
              labelledBy={`${id}-model`}
              provider={provider === undefined ? null : { name: provider.name }}
              onHighlight={onHighlight}
              onPick={(option) => { onChange({ ...draft, model: option.name }); }}
            />
          )}
          {notListed ? (
            <p className="mt-1.5 text-[12.5px] text-red" data-testid="profile-model-not-listed">{t("agentProfiles.editor.modelPicker.notListedNow", { provider: provider.name, model: savedModelText })}</p>
          ) : null}
        </div>
      </div>
      {unset ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-[13px] text-muted" data-testid="profile-provider-unset">
          <TriangleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75]" />
          {t("agentProfiles.editor.providerUnset", { model: savedModelText })}
        </p>
      ) : null}
      {blocked === null ? null : <p className="mt-2.5 text-[12.5px] text-muted" data-testid="profile-provider-blocked">{blocked}</p>}
      {draft.model === null ? null : (
        <EffortField
          choice={effortChoiceOf(
            effort.data,
            {
              model: chosen === undefined ? savedModelText : chosen.displayName,
              agent: agents.data?.find((agent) => agent.adapter === draft.adapter)?.name ?? detail?.agentName ?? draft.adapter,
            },
            readOnly || effortModelId === null ? null : `/organization/models?model=${effortModelId}`,
          )}
          value={draft.effort}
          readOnly={readOnly}
          onChange={(level) => { onChange({ ...draft, effort: level }); }}
        />
      )}
    </EditorSection>
  );
};

/** The coverage of the open rule, from `agentProfiles.ruleCoverage`, 300ms after the last change. */
const useCoverage = (draft: ProfileDraft, openKey: string | null): Coverage | undefined => {
  const trpc = useTRPC();
  const open = draft.rules.find((rule) => rule.key === openKey);
  const rules = useMemo(() => {
    if (open === undefined) return null;
    try {
      return [...draftToRules(open, () => "01900000-0000-7000-8000-000000000000")];
    } catch {
      return null;
    }
  }, [open]);
  const servers = useMemo(() => draft.servers.map((server) => ({ name: server.name, readOnly: server.readOnly })), [draft.servers]);
  const input = useDebounced(rules === null || rules.length === 0 ? null : { rules, mcpServers: servers }, 300);
  const coverage = useQuery(trpc.agentProfiles.ruleCoverage.queryOptions(input ?? skipToken, { placeholderData: (previous) => previous }));
  if (coverage.data === undefined || open === undefined) return undefined;
  const value = (subject: { readonly value: string }): string => subject.value;
  const matched = coverage.data.flatMap((entry) => entry.matched.map(value));
  const unmatched = coverage.data
    .flatMap((entry) => entry.unmatched.map(value))
    .filter((subject, index, all) => all.indexOf(subject) === index && !matched.includes(subject));
  return { matched: matched[0] ?? null, unmatched: unmatched[0] ?? null };
};

const Heading = ({ eyebrow, title, builtIn, loading }: { readonly eyebrow: string; readonly title: string; readonly builtIn: boolean; readonly loading: boolean }) => (
  <div>
    <div className="font-mono text-sm text-faint" data-testid="profile-eyebrow">{loading ? <Skeleton className="w-[160px]" /> : eyebrow}</div>
    <div className="my-1.5 flex min-w-0 items-center gap-2.5">
      {loading ? <Skeleton className="h-7 w-[180px]" /> : <h1 className="page-title break-words">{title}</h1>}
      {builtIn ? <Chip className="shrink-0">{t("agentProfiles.builtIn")}</Chip> : null}
    </div>
    <p className="max-w-[760px] text-lede text-muted">{t("agentProfiles.editor.lede")}</p>
  </div>
);

/** `Agent profile · saved 2h ago`, `New agent profile`, `Archived 3 Nov`. */
const eyebrowOf = (detail: ProfileDetail | null, savedAt: number | null): string => {
  if (detail === null) return t("agentProfiles.editor.eyebrowNew");
  if (detail.archivedAt !== null) return t("agentProfiles.editor.eyebrowArchived", { date: dayText(detail.archivedAt) });
  const at = savedAt ?? detail.lastEdit?.at ?? detail.createdAt;
  const age = formatAge(at);
  return t("agentProfiles.editor.eyebrow", { age: age === "now" ? t("agentProfiles.editor.justNow") : t("agentProfiles.editor.eyebrowAgo", { age }) });
};

/** Organization › Agent profiles › one profile, or `new` (F-021). */
export const AgentProfileEditor = ({ profileId }: { readonly profileId: AgentProfileId | null }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const me = useQuery(trpc.me.get.queryOptions());
  const admin = me.data?.organization?.role === "admin";
  const detail = useQuery(trpc.agentProfiles.get.queryOptions(profileId === null ? skipToken : { profileId }));
  const list = useQuery(trpc.agentProfiles.list.queryOptions({ includeArchived: false }, { enabled: profileId === null || admin }));
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { enabled: admin }));
  const presets = useQuery(trpc.agentProfiles.presets.queryOptions(undefined, { enabled: admin }));

  const loaded = profileId === null ? (list.data === undefined ? null : "new") : (detail.data ?? null);
  const [saved, setSaved] = useState<ProfileDraft | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [highlighted, setHighlighted] = useState<ModelOption | null>(null);
  const modelOptions = useQuery(trpc.agentProfiles.modelOptions.queryOptions(undefined, { enabled: admin }));
  const providerOptions = useQuery(trpc.agentProfiles.providerOptions.queryOptions(undefined, { enabled: admin }));
  // After a save, where its tasks can't start: no key for the name, or a project that doesn't allow its provider.
  const savedProvider = providerOptions.data?.find((provider) => provider.providerId === saved?.providerId);
  const savedNoKey = (modelOptions.data?.find((option) => sameModel(option.name, saved?.model ?? null))?.projectsWithout ?? []).map((project) => project.name);
  const savedNotAllowed = (savedProvider?.projects ?? []).filter((project) => !project.allowed).map((project) => project.name);

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  // The draft starts from what loaded, once; a save resets it from the saved profile.
  useEffect(() => {
    if (loaded === null || saved !== null) return;
    const builtIn = list.data?.find((profile) => profile.builtIn);
    const first = loaded === "new" ? newDraft("opencode", builtIn?.modelName ?? null, builtIn?.provider?.providerId ?? null) : draftFromDetail(loaded);
    setSaved(first);
    setDraft(first);
  }, [loaded, saved, list.data]);

  const data = detail.data ?? null;
  const builtIn = data?.builtIn ?? false;
  const readOnly = !admin || (data !== null && !data.canEdit);
  const dirty = draft !== null && saved !== null && isDirty(draft, saved);
  const problem = draft === null ? null : draftProblem(draft);
  useLeaveGuard(dirty && !readOnly, setLeaving);

  const coverage = useCoverage(draft ?? newDraft("opencode", null), openKey);

  const save = useMutation(
    trpc.agentProfiles.save.mutationOptions({
      onSuccess: async (result) => {
        setSavedAt(Date.now());
        await queryClient.invalidateQueries({ queryKey: trpc.agentProfiles.list.queryKey() });
        if (profileId === null) {
          setSaved(draft);
          router.replace(`/organization/agent-profiles/${result.profileId}?saved=1`);
          return;
        }
        await queryClient.invalidateQueries({ queryKey: trpc.agentProfiles.get.queryKey({ profileId }) });
        setSaved(draft);
      },
    }),
  );
  const archive = useMutation(
    trpc.agentProfiles.archive.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.agentProfiles.list.queryKey() });
        router.push(`/organization/agent-profiles?profile=${profileId ?? ""}`);
      },
    }),
  );

  // Arriving from a first save (`?saved=1`) shows "Saved." once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("saved") === "1") {
      setSavedAt(Date.now());
      params.delete("saved");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest === "" ? "" : `?${rest}`}`);
    }
  }, []);

  const crumbs = [
    { label: me.data?.organization?.name ?? t("shell.organization") },
    { label: t("agentProfiles.title"), href: "/organization/agent-profiles" },
    { label: nameOr(draft?.name, profileId === null ? t("agentProfiles.editor.newTitle") : (data?.name ?? "")) },
  ];

  if (profileId !== null && detail.error !== null) {
    const notFound = detail.error.data?.code === "NOT_FOUND";
    return (
      <PageFrame crumbs={[crumbs[0] ?? { label: "" }, { label: t("agentProfiles.title"), href: "/organization/agent-profiles" }]}>
        {notFound ? (
          <div className="py-10" data-testid="profile-not-found">
            <h1 className="page-title">{t("agentProfiles.editor.noSuchProfile")}</h1>
            <Link href="/organization/agent-profiles" className="mt-2 inline-block text-teal hover:underline">{t("agentProfiles.editor.allProfiles")}</Link>
          </div>
        ) : (
          <p role="alert" className="text-sm text-red">{errorText(detail.error)}</p>
        )}
      </PageFrame>
    );
  }

  const loading = draft === null;
  const current = draft ?? newDraft("opencode", null);
  const update = (next: ProfileDraft): void => {
    setDraft(next);
    if (savedAt !== null) setSavedAt(null);
  };
  const addPreset = (preset: ApprovalRulePreset): void => {
    const rules = presets.data?.find((entry) => entry.preset === preset)?.rules ?? [];
    const added = groupRules(rules).map((rule) => ({ ...rule, key: nextKey("rule"), ruleIds: [] }));
    update({ ...current, rules: [...current.rules, ...added] });
    setOpenKey(added[0]?.key ?? null);
  };
  const addCustom = (): void => {
    const rule = emptyRule(nextKey("rule"));
    update({ ...current, rules: [...current.rules, rule] });
    setOpenKey(rule.key);
  };
  const submit = (): void => {
    save.mutate(saveInputOf(current, profileId, newId, saved?.effort ?? "default"));
  };
  const newSkill = (): SkillDraft => ({ key: nextKey("skill"), name: "", body: "", files: [] });
  const title = current.name.trim() === "" ? (profileId === null ? t("agentProfiles.editor.newTitle") : (data?.name ?? "")) : current.name;
  // A removed member can be granted nothing (ADR 0053): the list keeps them for history only.
  const memberList = (members.data ?? []).filter((member) => member.state !== "removed").map((member) => ({ memberId: member.memberId, name: member.name, email: member.email }));

  return (
    <PageFrame
      crumbs={crumbs}
      wideProperties
      actions={
        readOnly ? undefined : (
          <Button variant="primary" onClick={submit} disabled={!dirty || problem !== null || save.isPending} data-action="save-profile">
            {save.isPending ? t("agentProfiles.editor.saving") : t("agentProfiles.editor.save")}
          </Button>
        )
      }
      properties={
        <EditorPanel
          detail={data}
          loading={loading}
          draft={current}
          readOnly={readOnly}
          builtIn={builtIn}
          members={memberList}
          onChange={update}
          onArchive={readOnly || builtIn ? null : () => { setConfirmArchive(true); }}
          modelGroup={
            current.providerId === null ? (
              <ModelInProjects option={highlighted ?? modelOptions.data?.find((option) => sameModel(option.name, current.model))} organizationAdmin={admin} />
            ) : (
              <ModelInProjects option={undefined} organizationAdmin={admin} provider={providerOptions.data?.find((provider) => provider.providerId === current.providerId)} />
            )
          }
        />
      }
    >
      <div className="max-w-[760px]" data-testid="profile-editor">
        <Heading eyebrow={eyebrowOf(data, savedAt)} title={title} builtIn={builtIn} loading={loading} />
        {savedAt !== null && !dirty ? (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-ui text-green"><CheckIcon aria-hidden className="size-[14px]" /> {saved?.providerId !== null && saved?.providerId !== undefined
              ? savedNotAllowed.length === 0 || savedProvider === undefined
                ? t("agentProfiles.editor.saved")
                : t("agentProfiles.editor.modelPicker.savedNotAllowed", { projects: savedNotAllowed.join(", "), provider: savedProvider.name })
              : savedNoKey.length === 0
                ? t("agentProfiles.editor.saved")
                : t("agentProfiles.editor.modelPicker.savedNoKey", { projects: savedNoKey.join(", ") })}</p>
        ) : null}
        {save.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(save.error)}</p>}
        {archive.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(archive.error)}</p>}

        {loading ? (
          <div aria-busy>
            {[t("agentProfiles.editor.agentAndModel"), t("agentProfiles.editor.instructions"), t("agentProfiles.editor.skills")].map((section) => (
              <EditorSection key={section} title={section}>
                <Skeleton className="mb-3 h-8 w-full" />
                <Skeleton className="h-8 w-2/3" />
              </EditorSection>
            ))}
          </div>
        ) : (
          <>
            <AgentAndModel draft={current} readOnly={readOnly} detail={data} options={modelOptions.data} providers={providerOptions.data} onChange={update} onHighlight={setHighlighted} />
            <EditorSection title={t("agentProfiles.editor.instructions")} note={t("agentProfiles.editor.instructionsNote")}>
              {readOnly && current.instructions === "" ? (
                <p className="text-ui text-faint">{t("agentProfiles.none")}</p>
              ) : (
                <Instructions value={current.instructions} readOnly={readOnly} onChange={(instructions) => { update({ ...current, instructions }); }} />
              )}
            </EditorSection>
            <SkillsSection skills={current.skills} readOnly={readOnly} newSkill={newSkill} onChange={(skills) => { update({ ...current, skills }); }} />
            <McpSection servers={current.servers} readOnly={readOnly} onChange={(servers) => { update({ ...current, servers }); }} />
            <RunnerLabelsSection profileId={profileId} labels={data?.runnerLabels ?? []} readOnly={readOnly} />
            <RulesSection
              rules={current.rules}
              openKey={openKey}
              readOnly={readOnly}
              coverage={coverage}
              onChange={(rules) => { update({ ...current, rules }); }}
              onOpen={setOpenKey}
              onPreset={addPreset}
              onCustom={addCustom}
            />
            <p className="mt-[22px] flex items-start gap-2 text-ui text-muted">
              <ShieldCheckIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 text-faint" />
              {t("agentProfiles.editor.footnote")}
            </p>
          </>
        )}
      </div>

      <AlertDialog open={leaving !== null} onOpenChange={(open) => { if (!open) setLeaving(null); }}>
        <AlertDialogContent
          title={t("agentProfiles.editor.leaveTitle")}
          body={t("agentProfiles.editor.leaveBody", { name: title })}
          cancel={t("agentProfiles.editor.stay")}
          action={t("agentProfiles.editor.leave")}
          onAction={() => {
            const href = leaving;
            setSaved(draft);
            setLeaving(null);
            if (href !== null) router.push(href);
          }}
        />
      </AlertDialog>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent
          title={t("agentProfiles.props.archiveTitle", { name: data?.name ?? "" })}
          body={
            <>
              {t("agentProfiles.props.archiveBody")}
              {(data?.defaults ?? []).map((entry) => (
                <span key={`${entry.projectId}-${entry.kind}`} className="mt-2 block">
                  {t("agentProfiles.props.archiveMoves", { project: entry.projectName, kind: t(`agentProfiles.kindTasks.${entry.kind}`), builtIn: list.data?.find((profile) => profile.builtIn)?.name ?? "OpenCode" })}
                </span>
              ))}
            </>
          }
          cancel={t("common.cancel")}
          action={archive.isPending ? t("agentProfiles.props.archiving") : t("agentProfiles.props.archiveProfile")}
          onAction={() => { if (profileId !== null) archive.mutate({ profileId }); }}
        />
      </AlertDialog>
    </PageFrame>
  );
};
