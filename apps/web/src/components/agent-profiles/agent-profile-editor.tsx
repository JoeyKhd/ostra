"use client";

import { skipToken, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CpuIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { AgentProfileId, ApprovalRulePreset } from "@ostra/protocol";

import { PageFrame } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { EditorSection } from "./editor-section";
import { draftFromDetail, draftProblem, isDirty, newDraft, nextKey, saveInputOf } from "./editor-draft";
import type { ProfileDraft, SkillDraft } from "./editor-draft";
import { McpSection } from "./mcp-section";
import { EditorPanel } from "./profile-editor-panel";
import type { ProfileDetail } from "./profile-types";
import { dayText, modelName } from "./profile-words";
import { draftToRules, emptyRule, groupRules } from "./rule-drafts";
import { RulesSection } from "./rules-section";
import type { Coverage } from "./rules-section";
import { SkillsSection } from "./skills-section";

// One agent profile's editor (F-021, F-026, F-063; agent-profile.md): the main column holds the
// agent and model, instructions, skills, MCP servers and approval rules; the panel holds plan
// first, who may use it, the defaults and archive. "Save profile" saves it all at once.

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

type ModelOption = { readonly id: string; readonly name: string; readonly mono: boolean; readonly custom: boolean; readonly logoPath: string | null };

const ModelLogo = ({ path }: { readonly path: string | null }) =>
  path === null ? <CpuIcon aria-hidden className="size-[15px] shrink-0 text-muted" /> : <img src={path} alt="" className="size-[15px] shrink-0 opacity-75 invert" />;

/** Agent and model: Name, Agent and Model in one row (one per line below 900px). */
const AgentAndModel = ({ draft, readOnly, detail, onChange }: {
  readonly draft: ProfileDraft;
  readonly readOnly: boolean;
  readonly detail: ProfileDetail | null;
  readonly onChange: (draft: ProfileDraft) => void;
}) => {
  const id = useId();
  const trpc = useTRPC();
  const agents = useQuery(trpc.agentProfiles.agents.queryOptions());
  const providers = useQuery(trpc.providers.list.queryOptions(undefined, { enabled: !readOnly }));
  const models = useQueries({
    queries: (providers.data ?? []).map((provider) => trpc.providers.models.queryOptions({ providerId: provider.id })),
  });
  const groups = (providers.data ?? []).map((provider, i) => ({
    provider,
    models: (models[i]?.data ?? [])
      .filter((model) => model.listed || model.id === draft.modelId)
      .map((model): ModelOption => ({ id: model.id, name: model.displayName ?? model.endpointModelId, mono: model.displayName === null, custom: model.custom, logoPath: model.logoPath })),
  }));
  const anyModel = groups.some((group) => group.models.length > 0);
  const label = "mb-1.5 block text-sm font-medium text-muted";

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
          <label id={`${id}-model`} className={label}>{t("agentProfiles.editor.model")}</label>
          {readOnly ? (
            <p className="flex h-8 items-center text-body">{detail?.model === null || detail?.model === undefined ? <span className="text-red">{t("agentProfiles.noModel")}</span> : modelName(detail.model)}</p>
          ) : (
            <>
              <Select value={draft.modelId ?? ""} disabled={providers.isSuccess && !anyModel} onValueChange={(modelId) => { onChange({ ...draft, modelId }); }}>
                <SelectTrigger className="h-8 w-full bg-surface" aria-labelledby={`${id}-model`} data-testid="profile-model">
                  <SelectValue placeholder={providers.isSuccess && !anyModel ? t("agentProfiles.editor.noModels") : t("agentProfiles.editor.pickModelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {groups.filter((group) => group.models.length > 0).map((group) => (
                    <SelectGroup key={group.provider.id}>
                      <SelectLabel>{group.provider.name}</SelectLabel>
                      {group.models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <ModelLogo path={model.logoPath} />
                          <span className={model.mono ? "truncate font-mono text-ui" : "truncate"}>{model.name}</span>
                          <span className="truncate text-faint">{group.provider.name}</span>
                          {model.custom ? <Chip className="h-5 px-1.5 text-xs">{t("agentProfiles.editor.custom")}</Chip> : null}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {providers.isSuccess && !anyModel ? (
                <Link href="/organization/models" className="mt-1.5 inline-block text-sm text-teal hover:underline">{t("agentProfiles.editor.addProvider")}</Link>
              ) : null}
            </>
          )}
        </div>
      </div>
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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  // The draft starts from what loaded, once; a save resets it from the saved profile.
  useEffect(() => {
    if (loaded === null || saved !== null) return;
    const builtInModel = list.data?.find((profile) => profile.builtIn)?.model?.id ?? null;
    const first = loaded === "new" ? newDraft("opencode", builtInModel) : draftFromDetail(loaded);
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
    save.mutate(saveInputOf(current, profileId, newId, new Map()));
  };
  const newSkill = (): SkillDraft => ({ key: nextKey("skill"), name: "", body: "", files: [] });
  const title = current.name.trim() === "" ? (profileId === null ? t("agentProfiles.editor.newTitle") : (data?.name ?? "")) : current.name;
  const memberList = (members.data ?? []).map((member) => ({ memberId: member.memberId, name: member.name, email: member.email }));

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
        />
      }
    >
      <div className="max-w-[760px]" data-testid="profile-editor">
        <Heading eyebrow={eyebrowOf(data, savedAt)} title={title} builtIn={builtIn} loading={loading} />
        {savedAt !== null && !dirty ? (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-ui text-green"><CheckIcon aria-hidden className="size-[14px]" /> {t("agentProfiles.editor.saved")}</p>
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
            <AgentAndModel draft={current} readOnly={readOnly} detail={data} onChange={update} />
            <EditorSection title={t("agentProfiles.editor.instructions")} note={t("agentProfiles.editor.instructionsNote")}>
              {readOnly && current.instructions === "" ? (
                <p className="text-ui text-faint">{t("agentProfiles.none")}</p>
              ) : (
                <Instructions value={current.instructions} readOnly={readOnly} onChange={(instructions) => { update({ ...current, instructions }); }} />
              )}
            </EditorSection>
            <SkillsSection skills={current.skills} readOnly={readOnly} newSkill={newSkill} onChange={(skills) => { update({ ...current, skills }); }} />
            <McpSection servers={current.servers} readOnly={readOnly} onChange={(servers) => { update({ ...current, servers }); }} />
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
