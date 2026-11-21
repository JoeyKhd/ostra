"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleXIcon, DownloadIcon, LockIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useShellActions } from "@/components/shell/actions/shell-actions";
import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Status } from "@/components/ui/status";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge, formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ageWords, dayText, lookSubject, sizeText, skillRowsOf, suggestionKind, suggestionTabs, versionText } from "./library-model";
import type { Suggestion, SuggestionTab } from "./library-model";
import { HashText, KindIcon } from "./library-parts";

// The admins' suggestions (F-145; app-targets/m8/library-suggestions.md): what members asked to add
// to the library, newest first, each with what its reference holds at the source today, and two
// answers: install it through the one install flow, or dismiss it. The member sees the answer on
// their suggestion. A chore for an admin, never "needs you": no amber.

const columns = "grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(0,1fr)_150px_178px_40px]";

const nameOf = (suggestion: Suggestion): string => suggestion.suggestedBy.name ?? t("library.someone");

/** A reference's last part, as the dismiss popover names it: `db-seeding`, `incidents`. */
const shortName = (reference: string): string => reference.replace(/^registry:/, "").split("#")[0]?.split(/[@/]/).at(-1) ?? reference;

const AtTheSource = ({ suggestion }: { readonly suggestion: Suggestion }) => {
  const trpc = useTRPC();
  const look = useMutation(trpc.library.resolve.mutationOptions());
  const items = useQuery(trpc.library.list.queryOptions());
  useEffect(() => {
    look.mutate({ reference: suggestion.reference });
    // One look per suggestion opened.
  }, [suggestion.reference]);
  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[78px_minmax(0,1fr)] gap-2 border-b border-line py-2 text-[13.5px]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-text">{value}</span>
    </div>
  );
  const resolved = look.data?.resolved;
  return (
    <div data-testid="at-the-source">
      <h3 className="mb-1 text-xs font-medium text-faint">{t("library.suggestions.atSource")} <span className="font-normal">{`· ${t("library.suggestions.lookedUp")}`}</span></h3>
      {look.isPending || look.isIdle ? (
        <div aria-busy className="space-y-2">{[0, 1, 2, 3].map((n) => <Skeleton key={n} className="h-5 w-full" />)}</div>
      ) : look.error !== null ? (
        <p className="flex items-start gap-1.5 text-sm text-red" role="alert"><CircleXIcon aria-hidden className="mt-[2px] size-[14px] shrink-0" />{t("library.suggestions.gone", { reference: suggestion.reference, reason: errorText(look.error) ?? "" })}</p>
      ) : resolved === undefined ? null : resolved.kind === "skills" ? (
        (() => {
          const [first] = skillRowsOf(resolved, items.data ?? []);
          return (
            <>
              {first === undefined ? null : row(t("library.suggestions.skill"), <><span className="font-mono">{first.name}</span>{first.description === null ? null : <span className="block text-sm text-muted">{first.description}</span>}</>)}
              {row(t("library.item.commit"), <span className="font-mono">{resolved.commit?.slice(0, 7) ?? "—"}</span>)}
              {first === undefined ? null : row(t("library.suggestions.files"), `${String(first.files)} · ${sizeText(first.size)} · ${t("library.suggestions.scripts", { n: first.skill.scripts.length })}`)}
              {first === undefined ? null : row(t("library.item.hash"), <HashText hash={first.skill.computedHash} />)}
              {row(t("library.suggestions.allowlist"), resolved.allowed.allowed ? <span className="flex items-center gap-1.5"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.suggestions.onIt")}</span> : <span><LockIcon aria-hidden className="mr-1 inline size-[13px] text-faint" /><span className="font-mono">{lookSubject(resolved)}</span> {t("library.suggestions.notOnIt")}</span>)}
            </>
          );
        })()
      ) : (
        <>
          {row(t("library.suggestions.server"), <span className="font-mono">{resolved.name}</span>)}
          {row(t("library.item.version"), <span className="font-mono">{versionText(resolved.version)}</span>)}
          {row(t("library.suggestions.remote"), resolved.remoteUrl === null ? "—" : <span className="break-all font-mono text-sm">{resolved.remoteUrl}</span>)}
          {row(t("library.suggestions.inputs"), t("library.suggestions.inputsCount", { n: resolved.inputs.length, k: resolved.inputs.filter((input) => input.isSecret).length }))}
          {row(t("library.suggestions.allowlist"), resolved.allowed.allowed ? <span className="flex items-center gap-1.5"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.suggestions.onIt")}</span> : <span><LockIcon aria-hidden className="mr-1 inline size-[13px] text-faint" />{lookSubject(resolved)} {t("library.suggestions.notOnIt")}</span>)}
        </>
      )}
    </div>
  );
};

export const SuggestionsPage = () => {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const { announce } = useShellActions();
  const me = useQuery(trpc.me.get.queryOptions());
  const admin = me.data?.organization?.role === "admin";
  const organization = me.data?.organization?.name ?? "";
  const list = useQuery(trpc.library.suggestions.list.queryOptions(undefined, { enabled: admin }));
  // Who decides: the organization's active admins, by name (library-suggestions.md, "Properties").
  const members = useQuery(trpc.members.list.queryOptions({ includeRemoved: false }, { enabled: admin }));
  const deciders = (members.data ?? []).filter((member) => member.role === "admin" && member.state === "active");
  const decide = useMutation(trpc.library.suggestions.decide.mutationOptions({ onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }); } }));
  const [dismissOpen, setDismissOpen] = useState(false);
  const tab: SuggestionTab = params.get("tab") === "decided" ? "decided" : "open";
  const all = list.data ?? [];
  const rows = all.filter((entry) => (tab === "open" ? entry.state === "open" : entry.state !== "open"));
  const selected = rows.find((entry) => entry.suggestionId === params.get("suggestion")) ?? rows[0] ?? null;
  const go = (changes: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${path}?${next.toString()}`, { scroll: false });
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    const next = event.key === "ArrowDown" ? rows[index + 1] : event.key === "ArrowUp" ? rows[index - 1] : undefined;
    if (event.key === "Enter") {
      event.preventDefault();
      document.querySelector<HTMLElement>("[data-action='install-suggestion']")?.focus();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    go({ suggestion: next.suggestionId });
    document.querySelector<HTMLElement>(`[data-suggestion-id="${next.suggestionId}"]`)?.focus();
  };
  const now = Date.now();
  const month = new Date(now).getMonth();
  const thisMonth = all.filter((entry) => entry.decidedAt !== null && new Date(entry.decidedAt).getMonth() === month);

  if (me.data !== undefined && !admin) {
    return (
      <PageFrame crumbs={[{ label: t("shell.organization") }, { label: t("shell.skills"), href: "/organization/skills" }, { label: t("library.suggestions.title") }]}>
        <p className="py-10 text-ui text-muted">{t("common.adminsOnly")}</p>
      </PageFrame>
    );
  }

  return (
    <PageFrame
      crumbs={[{ label: t("shell.organization") }, { label: t("shell.skills"), href: "/organization/skills" }, { label: t("library.suggestions.title") }]}
      properties={
        selected === null ? undefined : (
          <div data-testid="suggestion-properties">
            <PropGroup title={t("library.suggestions.suggestion")}>
              <PropRow label={t("library.suggestions.kind")}>{suggestionKind(selected.reference) === "skill" ? t("library.kind.skill") : t("library.kind.server")}</PropRow>
              <PropRow label={t("library.suggestions.from")}><Avatar name={nameOf(selected)} className="size-5 text-[10px]" /><span className="truncate">{nameOf(selected)}</span></PropRow>
              <PropRow label={t("library.suggestions.sent")}>{`${dayText(selected.createdAt)}, ${formatClock(selected.createdAt)}`}</PropRow>
              <PropRow label={t("library.suggestions.source")}><span className="truncate font-mono" title={selected.reference}>{selected.reference.split("#")[0]}</span></PropRow>
              <PropRow label={t("library.item.ref")}>{selected.reference.includes("#") ? <span className="font-mono">{selected.reference.split("#")[1]}</span> : <span className="text-faint">{t("library.suggestions.theDefault")}</span>}</PropRow>
              <PropRow label={t("library.suggestions.status")}>
                <Status tone={selected.state === "installed" ? "green" : "grey"}>{selected.state === "open" ? t("library.suggestions.open") : selected.state === "installed" ? t("library.suggestions.installed") : t("library.suggestions.dismissed")}</Status>
              </PropRow>
            </PropGroup>
            <PropGroup title={t("library.suggestions.whoDecides")}>
              <PropRow label={t("library.props.orgAdmins")}>
                {deciders.length === 0 ? (
                  t("library.suggestions.anyAdmin")
                ) : (
                  <>
                    <span className="flex shrink-0 -space-x-1">{deciders.slice(0, 3).map((member) => <Avatar key={member.memberId} name={member.name} className="size-5 text-[10px] ring-2 ring-bg" />)}</span>
                    <span className="truncate" title={deciders.map((member) => member.name).join(", ")}>{deciders.map((member) => member.name).join(", ")}</span>
                  </>
                )}
              </PropRow>
              <p className="mt-1 text-[12.5px] text-faint">{t("library.suggestions.whoDecidesNote")}</p>
            </PropGroup>
            <PropGroup title={t("library.suggestions.thisMonth")}>
              <PropRow label={t("library.suggestions.installed")}><span className="font-mono">{thisMonth.filter((entry) => entry.state === "installed").length}</span></PropRow>
              <PropRow label={t("library.suggestions.dismissed")}><span className="font-mono">{thisMonth.filter((entry) => entry.state === "dismissed").length}</span></PropRow>
            </PropGroup>
          </div>
        )
      }
    >
      <div data-testid="suggestions-page">
        <PageHeading title={t("library.suggestions.title")} lede={t("library.suggestions.lede", { organization })} />
        <UnderlineTabs
          className="mt-4"
          label={t("library.suggestions.title")}
          idPrefix={id}
          selected={tab}
          onSelect={(next) => { go({ tab: next === "open" ? null : next, suggestion: null }); }}
          tabs={suggestionTabs.map((entry) => ({ id: entry, label: entry === "open" ? t("library.suggestions.openTab") : t("library.suggestions.decidedTab"), extra: entry === "open" ? <span className="font-mono text-[12px] font-normal text-faint">{list.data === undefined ? "" : all.filter((row) => row.state === "open").length}</span> : undefined }))}
        />
        <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
          {list.data === undefined ? (
            <div aria-busy className="mt-4 space-y-2">{[0, 1, 2].map((n) => <Skeleton key={n} className="h-10 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <div className="mt-10 flex max-w-[520px] flex-col items-start gap-2" data-testid="suggestions-empty">
              <MessageSquarePlusIcon aria-hidden className="size-7 stroke-[1.5] text-faint" />
              <p className="text-[16px] font-semibold text-text">{tab === "open" ? t("library.suggestions.emptyTitle") : t("library.suggestions.emptyDecided")}</p>
              <p className="text-ui text-muted">{t("library.suggestions.emptyBody")}</p>
            </div>
          ) : (
            <>
              <ul className="mt-4" aria-label={t("library.suggestions.title")}>
                {rows.map((entry, index) => {
                  const isSelected = entry.suggestionId === selected?.suggestionId;
                  return (
                    <li key={entry.suggestionId}>
                      <button
                        type="button"
                        aria-current={isSelected}
                        data-suggestion-id={entry.suggestionId}
                        data-suggestion={entry.reference}
                        onClick={() => { go({ suggestion: entry.suggestionId }); }}
                        onKeyDown={(event) => { onRowKey(event, index); }}
                        className={cn("grid min-h-10 w-full items-center gap-x-3 border-b border-line py-1.5 pl-1 pr-2 text-left", columns, isSelected ? "rounded-[6px] bg-sel" : "hover:bg-hover")}
                      >
                        <KindIcon kind={suggestionKind(entry.reference)} />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-ui font-medium text-text">{entry.reference}</span>
                          <span className="block truncate text-[12.5px] text-muted sm:hidden">{`${nameOf(entry)} · ${formatAge(entry.createdAt)}`}</span>
                        </span>
                        <span className="hidden truncate text-sm text-muted sm:block">{nameOf(entry)}</span>
                        <span className="hidden items-center gap-1.5 text-sm text-faint sm:flex">
                          {tab === "open" ? (
                            entry.sourceAllowed ? <><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.suggestions.onAllowlist")}</> : <><LockIcon aria-hidden className="size-[13px]" />{t("library.suggestions.notOnAllowlist")}</>
                          ) : entry.state === "installed" ? <><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.suggestions.installed")}</> : <><XIcon aria-hidden className="size-[13px]" />{t("library.suggestions.dismissed")}</>}
                        </span>
                        <span className="justify-self-end font-mono text-[12px] text-faint">{formatAge(entry.createdAt)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {selected === null ? null : (
                <div className="mt-6" data-testid="suggestion-detail">
                  <div className="grid gap-7 lg:grid-cols-[44%_minmax(0,1fr)]">
                    <div className="min-w-0">
                      <h3 className="text-xs font-medium text-faint">{t("library.suggestions.suggested")}</h3>
                      <p className="mt-1 break-all font-mono text-[15px] font-semibold text-text">{selected.reference}</p>
                      <p className="mt-2 flex items-center gap-2 text-sm text-muted">
                        <Chip>{suggestionKind(selected.reference) === "skill" ? t("library.suggestions.skillChip") : t("library.kind.server")}</Chip>
                        {t("library.suggestions.forLibrary", { organization })}
                      </p>
                      {selected.note === null ? null : <p className="mt-3 whitespace-pre-wrap break-words text-ui leading-[1.6] text-text" data-testid="suggestion-note">{selected.note}</p>}
                      <p className="mt-2.5 flex items-center gap-2 text-sm text-muted">
                        <Avatar name={nameOf(selected)} className="size-5 text-[10px]" />
                        {`${nameOf(selected)} · ${ageWords(selected.createdAt, now)}`}
                      </p>
                      {selected.state === "open" ? null : (
                        <p className="mt-2.5 text-sm text-muted">
                          {selected.state === "installed" ? t("library.suggest.installedBy", { name: selected.decidedBy?.name ?? t("library.someone"), date: dayText(selected.decidedAt ?? now) }) : t("library.suggest.dismissedBy", { name: selected.decidedBy?.name ?? t("library.someone"), date: dayText(selected.decidedAt ?? now) })}
                          {selected.state === "installed" && selected.itemId !== null ? <> <Link href={`/organization/skills/${selected.itemId}`} className="text-teal hover:underline">{t("library.suggestions.openItem", { name: shortName(selected.reference) })}</Link></> : null}
                        </p>
                      )}
                    </div>
                    {selected.state === "open" ? <AtTheSource key={selected.suggestionId} suggestion={selected} /> : null}
                  </div>
                  {selected.state === "open" ? (
                    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                      <Button variant="primary" className="h-[44px] flex-1 sm:h-[30px] sm:flex-none" asChild>
                        <Link href={`/organization/skills?add=${suggestionKind(selected.reference) === "skill" ? "skill" : "mcp"}&source=${encodeURIComponent(selected.reference)}&suggestion=${selected.suggestionId}`} data-action="install-suggestion">
                          <DownloadIcon aria-hidden />{t("library.suggestions.install")}
                        </Link>
                      </Button>
                      <Popover open={dismissOpen} onOpenChange={setDismissOpen}>
                        <PopoverTrigger asChild>
                          <Button className={cn("h-[44px] flex-1 sm:h-[30px] sm:flex-none", dismissOpen && "bg-sel")} aria-expanded={dismissOpen} data-action="dismiss-suggestion">
                            {t("library.row.dismiss")}
                            {dismissOpen ? <ChevronUpIcon aria-hidden className="!size-[14px]" /> : <ChevronDownIcon aria-hidden className="!size-[14px]" />}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[min(380px,calc(100vw-32px))] p-4">
                          <p className="text-[14.5px] font-semibold text-text">{t("library.suggestions.dismissTitle", { name: shortName(selected.reference) })}</p>
                          <p className="mt-1.5 text-sm text-muted">{t("library.suggestions.dismissBody", { name: nameOf(selected) })}</p>
                          {decide.error === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{errorText(decide.error)}</p>}
                          <div className="mt-3 flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => { setDismissOpen(false); }}>{t("common.cancel")}</Button>
                            <Button
                              disabled={decide.isPending}
                              data-action="confirm-dismiss"
                              onClick={() => {
                                decide.mutate(
                                  { suggestionId: selected.suggestionId, decision: { kind: "dismissed" } },
                                  { onSuccess: () => { setDismissOpen(false); announce(t("library.suggestions.dismissedToast", { name: nameOf(selected) })); go({ suggestion: null }); } },
                                );
                              }}
                            >
                              {t("library.suggestions.dismissConfirm")}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                      <span className="ml-auto text-[12.5px] text-faint">{t("library.suggestions.toldEither", { name: nameOf(selected) })}</span>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </PageFrame>
  );
};
