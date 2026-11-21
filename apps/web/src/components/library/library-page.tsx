"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BlocksIcon, ChevronDownIcon, CircleAlertIcon, MessageSquarePlusIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon, StoreIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { useShellActions } from "@/components/shell/actions/shell-actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AddFromSourceSheet } from "./add-from-source-sheet";
import type { InstallKind, SheetOrigin } from "./add-from-source-sheet";
import { bandsOf, callsOutTo, descriptionOf, libraryTabs, matchesFilter, onProfile, pinText, sizeText, sourceEntryText, sourceText, sourceTitle, statusOf, suggestionKind, tabCounts, tabOf, usedByOf, usedByText } from "./library-model";
import type { Band, LibraryItem, LibraryTab, Suggestion } from "./library-model";
import { EveryProfileChip, KindIcon, KindSquare, StatusCell } from "./library-parts";
import { SourcesSheet } from "./sources-sheet";
import { SuggestSheet } from "./suggest-sheet";

// Organization › Skills and MCP (F-145; app-targets/m8/library.md): every skill and MCP server the
// organization installed, each once, with its source, pin, who uses it and what waits on an admin
// (an update, a member's suggestion: never amber). Org admins add from a source and browse the
// marketplace; any other member reads it and suggests (`?suggest=1`). The install sheet opens over
// the page from `?add=skill|mcp` (and `&source=` from a suggestion or a marketplace result).

const columns = "lg:grid-cols-[232px_178px_74px_102px_minmax(0,1fr)]";

const tabLabel: Readonly<Record<LibraryTab, "library.tabs.all" | "library.tabs.skills" | "library.tabs.mcp" | "library.tabs.updates">> = {
  all: "library.tabs.all",
  skills: "library.tabs.skills",
  mcp: "library.tabs.mcp",
  updates: "library.tabs.updates",
};

/** A band's 30px head: the icon, the label, the count (milestone 1's lifecycle bands). */
const BandHead = ({ icon, label, count, end }: { readonly icon: ReactNode; readonly label: string; readonly count: number; readonly end?: ReactNode }) => (
  <div className="mt-2.5 flex h-[30px] items-center gap-2 rounded-[6px] bg-surface px-3 [&_svg]:size-[14px] [&_svg]:text-muted">
    {icon}
    <span className="text-[13.5px] font-semibold text-text">{label}</span>
    <span className="font-mono text-[12px] text-faint">{count}</span>
    {end === undefined ? null : <span className="ml-auto">{end}</span>}
  </div>
);

/** ↑ and ↓ move between the table's rows when one has focus. */
const moveBetweenRows = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-library-row]")];
  const at = rows.indexOf(event.currentTarget);
  const next = rows[event.key === "ArrowDown" ? at + 1 : at - 1];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

/** One installed item: the whole row is a link to its page. */
const ItemRow = ({ item }: { readonly item: LibraryItem }) => {
  const usedBy = usedByOf(item);
  return (
    <Link
      href={`/organization/skills/${item.itemId}`}
      data-library-row
      data-item={item.name}
      onKeyDown={moveBetweenRows}
      className={cn("grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-1 hover:bg-hover lg:min-h-[52px]", columns)}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <KindSquare kind={item.kind} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-ui font-medium text-text">{item.name}</span>
          <span className="hidden truncate text-sm text-muted lg:block">{descriptionOf(item, item.kind === "skill" ? `${plural(item.files.length, "library.row.filesOne", "library.row.filesMany")} · ${sizeText(item.files.reduce((total, file) => total + file.size, 0))}` : null)}</span>
          <span className="block truncate font-mono text-[12px] text-faint lg:hidden">{`${pinText(item.pin)} · ${usedByText(usedBy)}`}</span>
        </span>
      </span>
      <span className="hidden truncate font-mono text-sm text-muted lg:block" title={sourceTitle(item.source)}>{sourceText(item)}</span>
      <span className="hidden font-mono text-sm text-text lg:block" data-pin>{pinText(item.pin)}</span>
      <span className="hidden text-[13.5px] text-muted lg:block">{usedBy.kind === "every-profile" ? <EveryProfileChip /> : usedBy.kind === "none" ? <span className="text-faint">—</span> : usedByText(usedBy)}</span>
      <span className="justify-self-end" data-status>
        <StatusCell status={statusOf(item)} />
      </span>
    </Link>
  );
};

/** A member's suggestion, for an admin: who and when, with Dismiss and Install. */
const SuggestionRow = ({ suggestion, onInstall, onDismiss, dismissing }: { readonly suggestion: Suggestion; readonly onInstall: () => void; readonly onDismiss: () => void; readonly dismissing: boolean }) => (
  <div className={cn("grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-1 lg:min-h-[52px]", columns)} data-suggestion={suggestion.reference}>
    <span className="flex min-w-0 items-center gap-2.5">
      <KindSquare kind={suggestionKind(suggestion.reference)} />
      <span className="min-w-0">
        <Link href={`/organization/skills/suggestions?suggestion=${suggestion.suggestionId}`} className="block truncate font-mono text-ui font-medium text-text hover:underline">{suggestion.reference.split("@").at(-1)?.replace(/^registry:/, "") ?? suggestion.reference}</Link>
        <span className="block truncate text-sm text-muted">{t("library.row.suggestedBy", { name: suggestion.suggestedBy.name ?? t("library.someone"), age: formatAge(suggestion.createdAt) })}</span>
      </span>
    </span>
    <span className="hidden truncate font-mono text-sm text-muted lg:block" title={suggestion.reference}>{suggestion.reference}</span>
    <span className="hidden text-faint lg:block">—</span>
    <span className="hidden text-faint lg:block">—</span>
    <span className="flex items-center justify-self-end gap-1.5">
      <Button variant="ghost" size="sm" className="h-[26px]" onClick={onDismiss} disabled={dismissing} data-action="dismiss-suggestion">{t("library.row.dismiss")}</Button>
      <Button size="sm" className="h-[26px]" onClick={onInstall} data-action="install-suggestion">{t("library.row.install")}</Button>
    </span>
  </div>
);

const LoadingRows = () => (
  <div aria-busy>
    {[0, 1, 2, 3, 4].map((row) => (
      <div key={row} className={cn("grid h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-1", columns)}>
        <span className="flex items-center gap-2.5"><Skeleton className="size-[26px]" /><Skeleton className="h-3.5 w-[140px]" /></span>
        <Skeleton className="hidden h-3.5 w-[120px] lg:block" />
        <Skeleton className="hidden h-3.5 w-[56px] lg:block" />
        <span />
        <span />
      </div>
    ))}
  </div>
);

export const LibraryPage = () => {
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
  const items = useQuery(trpc.library.list.queryOptions());
  const counts = useQuery(trpc.library.counts.queryOptions(undefined, { enabled: admin }));
  const suggestions = useQuery(trpc.library.suggestions.list.queryOptions(undefined, { enabled: admin }));
  const mine = useQuery(trpc.library.suggestions.mine.queryOptions(undefined, { enabled: me.data !== undefined && !admin }));
  const searchState = useQuery(trpc.library.searchState.queryOptions(undefined, { enabled: admin }));
  const sources = useQuery(trpc.library.sources.list.queryOptions(undefined, { enabled: admin }));
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions({ includeArchived: false }));
  const dismiss = useMutation(trpc.library.suggestions.decide.mutationOptions({ onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }); } }));
  const setSearch = useMutation(trpc.library.setMarketplaceSearch.mutationOptions({ onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.library.searchState.queryKey() }); } }));

  const tab = tabOf(params.get("tab"));
  const add = params.get("add");
  const addKind: InstallKind | null = add === "skill" || add === "mcp" ? add : null;
  const addSource = params.get("source");
  const fromSuggestion = params.get("suggestion");
  // A sheet closes at once, and the address follows: the address it was closed at keeps it shut.
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const shut = closedAt !== null && closedAt === params.toString();
  const suggestOpen = params.get("suggest") === "1" && !shut;
  const [filter, setFilter] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<"skills" | "mcp">>(new Set());
  const [sourcesOpen, setSourcesOpen] = useState(false);

  /** The page's address with some of its parameters changed (`null` drops one). */
  const go = (changes: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query === "" ? path : `${path}?${query}`, { scroll: false });
  };

  const all = items.data ?? [];
  const shown = all.filter((item) => matchesFilter(item, filter) && onProfile(item, profileId));
  const bands = bandsOf(shown, tab, opened);
  const open = (suggestions.data ?? []).filter((suggestion) => suggestion.state === "open");
  const mineOpen = (mine.data ?? []).filter((suggestion) => suggestion.state === "open");
  const countsOf = tabCounts(all);
  const searchOn = searchState.data?.enabled === true;
  const suggestion = open.find((entry) => entry.suggestionId === fromSuggestion) ?? null;
  const origin: SheetOrigin = suggestion !== null ? { kind: "suggestion", suggestionId: suggestion.suggestionId, member: suggestion.suggestedBy.name ?? t("library.someone") } : params.get("from") === "marketplace" ? { kind: "marketplace", host: params.get("host") ?? "" } : null;
  const decide = useMutation(trpc.library.suggestions.decide.mutationOptions());

  const empty = items.data !== undefined && all.length === 0 && open.length === 0 && mineOpen.length === 0;
  const bandFor = (band: Band) => (
    <div key={band.kind} data-band={band.kind}>
      {tab === "all" ? <BandHead icon={<KindIcon kind={band.kind === "skills" ? "skill" : "mcp_server"} />} label={band.kind === "skills" ? t("library.band.skills") : t("library.band.mcp")} count={band.items.length} /> : null}
      {band.items.slice(0, band.shown).map((item) => <ItemRow key={item.itemId} item={item} />)}
      {band.shown < band.items.length ? (
        <button type="button" className="flex h-[34px] items-center gap-1.5 px-1 text-[13.5px] text-muted hover:text-text" onClick={() => { setOpened((current) => new Set([...current, band.kind])); }}>
          <ChevronDownIcon aria-hidden className="size-[14px]" />
          {t("library.showMore", { n: band.items.length - band.shown })}
        </button>
      ) : null}
    </div>
  );

  const actions = me.data === undefined ? undefined : admin ? (
    <>
      {searchOn ? (
        <Button asChild aria-label={t("library.browse")}>
          <Link href="/organization/skills/marketplace"><StoreIcon aria-hidden /><span className="hidden sm:inline">{t("library.browse")}</span></Link>
        </Button>
      ) : null}
      <Button variant="primary" onClick={() => { setClosedAt(null); go({ add: "skill", source: null, suggestion: null }); }} aria-label={t("library.addFromSource")} aria-haspopup="dialog" data-action="add-from-source">
        <PlusIcon aria-hidden /><span className="hidden sm:inline">{t("library.addFromSource")}</span>
      </Button>
    </>
  ) : (
    <Button onClick={() => { setClosedAt(null); go({ suggest: "1" }); }} aria-label={t("library.suggest.button")} aria-haspopup="dialog" data-action="suggest">
      <MessageSquarePlusIcon aria-hidden /><span className="hidden sm:inline">{t("library.suggest.button")}</span>
    </Button>
  );

  return (
    <PageFrame
      crumbs={[{ label: t("shell.organization") }, { label: t("shell.skills") }]}
      actions={actions}
      properties={
        <LibraryProperties
          admin={admin}
          items={items.data}
          counts={counts.data}
          searchState={searchState.data}
          searchError={setSearch.error === null ? null : errorText(setSearch.error)}
          sources={sources.data}
          onSearch={(enabled) => { setSearch.mutate({ enabled }); }}
          onEdit={() => { setSourcesOpen(true); }}
          searchPending={setSearch.isPending}
        />
      }
    >
      <div data-testid="library-page">
        <PageHeading title={t("library.title")} lede={t("library.lede", { organization })} />
        <UnderlineTabs
          className="mt-4"
          label={t("library.tabs.label")}
          idPrefix={id}
          selected={tab}
          onSelect={(next) => { go({ tab: next === "all" ? null : next }); }}
          tabs={libraryTabs.map((entry) => ({ id: entry, label: t(tabLabel[entry]), extra: <span className="font-mono text-[12px] font-normal text-faint">{items.data === undefined ? "" : countsOf[entry]}</span> }))}
        />
        <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <label className="relative w-full sm:w-[280px]">
              <span className="sr-only">{t("library.filter")}</span>
              <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 text-faint" />
              <Input value={filter} onChange={(event) => { setFilter(event.target.value); }} placeholder={t("library.filter")} className="h-[44px] pl-8 text-ui sm:h-[30px]" data-testid="library-filter" />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-[44px] sm:h-[30px]">
                  <SlidersHorizontalIcon aria-hidden />
                  {t("library.profileFilter", { profile: profiles.data?.find((profile) => profile.id === profileId)?.name ?? t("library.anyProfile") })}
                  <ChevronDownIcon aria-hidden className="!size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={profileId ?? ""} onValueChange={(value) => { setProfileId(value === "" ? null : value); }}>
                  <DropdownMenuRadioItem value="">{t("library.anyProfile")}</DropdownMenuRadioItem>
                  {(profiles.data ?? []).map((profile) => <DropdownMenuRadioItem key={profile.id} value={profile.id}>{profile.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {items.error !== null ? (
            <div className="mt-6 flex flex-wrap items-center gap-3 text-ui" role="alert">
              <CircleAlertIcon aria-hidden className="size-[15px] text-red" />
              {t("library.loadFailed")}
              <Button onClick={() => { void items.refetch(); }}>{t("library.tryAgain")}</Button>
            </div>
          ) : empty ? (
            <div className="mt-10 flex max-w-[520px] flex-col items-start gap-2" data-testid="library-empty">
              <BlocksIcon aria-hidden className="size-7 stroke-[1.5] text-faint" />
              <p className="text-[16px] font-semibold text-text">{t("library.empty.title")}</p>
              <p className="text-ui text-muted">{admin ? t("library.empty.body") : t("library.empty.memberBody")}</p>
              {admin ? (
                <div className="mt-2 flex gap-2">
                  {searchOn ? <Button asChild><Link href="/organization/skills/marketplace">{t("library.browse")}</Link></Button> : null}
                  <Button variant="primary" onClick={() => { go({ add: "skill" }); }}>{t("library.addFromSource")}</Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-3" data-testid="library-table">
              <div className={cn("hidden h-8 items-center gap-x-3 border-b border-line px-1 text-[12.5px] font-medium text-faint lg:grid", columns)}>
                <span>{t("library.col.name")}</span>
                <span>{t("library.col.source")}</span>
                <span>{t("library.col.pinned")}</span>
                <span>{t("library.col.usedBy")}</span>
                <span />
              </div>
              {items.data === undefined ? <LoadingRows /> : null}
              {tab === "all" && admin && open.length > 0 ? (
                <div data-band="suggested">
                  <BandHead icon={<MessageSquarePlusIcon aria-hidden />} label={t("library.band.suggested")} count={open.length} end={<Link href="/organization/skills/suggestions" className="text-sm text-teal hover:underline">{t("library.band.allSuggestions")}</Link>} />
                  {open.map((entry) => (
                    <SuggestionRow
                      key={entry.suggestionId}
                      suggestion={entry}
                      dismissing={dismiss.isPending}
                      onDismiss={() => { dismiss.mutate({ suggestionId: entry.suggestionId, decision: { kind: "dismissed" } }, { onSuccess: () => { announce(t("library.suggestions.dismissedToast", { name: entry.suggestedBy.name ?? t("library.someone") })); } }); }}
                      onInstall={() => { setClosedAt(null); go({ add: suggestionKind(entry.reference) === "skill" ? "skill" : "mcp", source: entry.reference, suggestion: entry.suggestionId }); }}
                    />
                  ))}
                </div>
              ) : null}
              {tab === "all" && !admin && mineOpen.length > 0 ? (
                <div data-band="suggested">
                  <BandHead icon={<MessageSquarePlusIcon aria-hidden />} label={t("library.band.suggested")} count={mineOpen.length} />
                  {mineOpen.map((entry) => (
                    <div key={entry.suggestionId} className={cn("grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-1", columns)} data-suggestion={entry.reference}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <KindSquare kind={suggestionKind(entry.reference)} />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-ui font-medium text-text">{entry.reference}</span>
                          <span className="block truncate text-sm text-muted">{t("library.row.youSuggested", { age: formatAge(entry.createdAt) })}</span>
                        </span>
                      </span>
                      <span className="hidden truncate font-mono text-sm text-muted lg:block">{entry.reference}</span>
                      <span className="hidden text-faint lg:block">—</span>
                      <span className="hidden text-faint lg:block">—</span>
                      <span />
                    </div>
                  ))}
                </div>
              ) : null}
              {items.data !== undefined && shown.length === 0 && all.length > 0 ? (
                <p className="mt-5 text-ui text-muted">
                  {t("library.noMatch", { query: filter })}{" "}
                  <button type="button" className="text-teal hover:underline" onClick={() => { setFilter(""); setProfileId(null); }}>{t("library.clearFilter")}</button>
                </p>
              ) : (
                bands.map(bandFor)
              )}
            </div>
          )}
        </div>
      </div>

      {admin ? (
        <AddFromSourceSheet
          open={addKind !== null && !shut}
          returnFocusTo="[data-action='add-from-source']"
          kind={addKind ?? "skill"}
          source={addSource}
          origin={origin}
          organization={organization}
          items={all}
          onKind={(kind) => { go({ add: kind, source: null }); }}
          onClose={() => { setClosedAt(params.toString()); go({ add: null, source: null, suggestion: null, from: null, host: null }); }}
          onInstalled={(installed) => {
            const [first] = installed;
            if (suggestion !== null && first !== undefined) {
              decide.mutate(
                { suggestionId: suggestion.suggestionId, decision: { kind: "installed", itemId: first.itemId } },
                { onSettled: () => { void queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }); } },
              );
            }
            setClosedAt(params.toString());
            go({ add: null, source: null, suggestion: null, from: null, host: null });
          }}
        />
      ) : null}
      {admin ? <SourcesSheet open={sourcesOpen} onClose={() => { setSourcesOpen(false); }} returnFocusTo="[data-action='edit-policy']" /> : null}
      {!admin && me.data !== undefined ? (
        <SuggestSheet open={suggestOpen} organization={organization} items={all} onClose={() => { setClosedAt(params.toString()); go({ suggest: null }); }} returnFocusTo="[data-action='suggest']" />
      ) : null}
    </PageFrame>
  );
};

/** The properties panel (library.md): the library's counts, its policy with the search switch and what it calls, and how repo skills are read. */
const LibraryProperties = ({ admin, items, counts, searchState, searchError, sources, onSearch, onEdit, searchPending }: {
  readonly admin: boolean;
  readonly items: readonly LibraryItem[] | undefined;
  readonly counts: { readonly openSuggestions: number; readonly updatesWaiting: number } | undefined;
  readonly searchState: Parameters<typeof callsOutTo>[0] | undefined;
  readonly searchError: string | null;
  readonly sources: Parameters<typeof callsOutTo>[1] | undefined;
  readonly onSearch: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly searchPending: boolean;
}) => {
  const id = useId();
  const value = (node: ReactNode, loaded: boolean) => (loaded ? node : <Skeleton className="w-[60px]" />);
  const list = sources ?? [];
  return (
    <div data-testid="library-properties">
      <PropGroup title={t("library.props.library")}>
        <PropRow label={t("library.props.skills")}>{value(<span className="font-mono">{items?.filter((item) => item.kind === "skill").length}</span>, items !== undefined)}</PropRow>
        <PropRow label={t("library.props.servers")}>{value(<span className="font-mono">{items?.filter((item) => item.kind === "mcp_server").length}</span>, items !== undefined)}</PropRow>
        {admin ? (
          <>
            <PropRow label={t("library.props.updates")}>{value(<><span className="font-mono">{counts?.updatesWaiting}</span><span className="truncate text-faint">{t("library.props.waitingForAdmin")}</span></>, counts !== undefined)}</PropRow>
            <PropRow label={t("library.props.suggested")}>{value(<Link href="/organization/skills/suggestions" className="font-mono hover:underline">{counts?.openSuggestions}</Link>, counts !== undefined)}</PropRow>
          </>
        ) : null}
      </PropGroup>
      <PropGroup title={<span className="flex items-center">{t("library.props.policy")}{admin ? <button type="button" className="ml-auto text-[12.5px] font-normal text-teal hover:underline" onClick={onEdit} aria-haspopup="dialog" data-action="edit-policy">{t("library.props.edit")}</button> : null}</span>}>
        <PropRow label={t("library.props.installs")}>{t("library.props.orgAdmins")}</PropRow>
        <PropRow label={t("library.props.members")}>{t("library.props.suggestWord")}</PropRow>
        {admin ? (
          <>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1.5 text-ui">
              <span className="text-muted">{t("library.props.sources")}</span>
              <span className="min-w-0 font-mono text-[12.5px] leading-[1.45] text-text" data-testid="policy-sources">
                {sources === undefined ? <Skeleton className="w-[120px]" /> : list.length === 0 ? <span className="font-sans text-faint">{t("library.props.noSources")}</span> : (
                  <>
                    {list.slice(0, 4).map((entry) => <span key={entry.sourceId} className="block truncate" title={sourceEntryText(entry)}>{sourceEntryText(entry)}</span>)}
                    {list.length > 4 ? <span className="block font-sans text-faint">{t("library.props.andMore", { n: list.length - 4 })}</span> : null}
                  </>
                )}
              </span>
            </div>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-2 py-1.5 text-ui">
              <span id={`${id}-search`} className="text-muted">{t("library.props.marketplace")}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <Switch
                    aria-labelledby={`${id}-search`}
                    checked={searchState?.enabled === true}
                    disabled={searchState === undefined || searchPending || (!searchState.instanceAllows && !searchState.organizationOn)}
                    onCheckedChange={onSearch}
                    data-testid="marketplace-switch"
                  />
                  <span className="text-text">{searchState?.enabled === true ? t("library.props.searchOn") : t("library.props.searchOff")}</span>
                </span>
                {searchState === undefined ? null : (
                  <span className="mt-1 block text-[12.5px] leading-[1.45] text-faint" data-testid="search-words">{searchState.offWords ?? searchState.sendsWords}</span>
                )}
                {searchError === null ? null : <span role="alert" className="mt-1 block text-sm text-red">{searchError}</span>}
              </span>
            </div>
            {searchState === undefined || sources === undefined ? null : (
              <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1.5 text-ui">
                <span className="text-muted">{t("library.props.callsOut")}</span>
                <span className="min-w-0 font-mono text-[12.5px] leading-[1.45] text-text">
                  {callsOutTo(searchState, list).map((host) => <span key={host} className="block truncate">{host}</span>)}
                </span>
              </div>
            )}
          </>
        ) : null}
      </PropGroup>
      <PropGroup title={t("library.props.repoSkills")}>
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1.5 text-ui">
          <span className="text-muted">{t("library.props.readFrom")}</span>
          <span className="font-mono text-[12.5px] leading-[1.45] text-text">
            {[".agents/skills", ".claude/skills", ".opencode/skills"].map((folder) => <span key={folder} className="block">{folder}</span>)}
          </span>
        </div>
        <PropRow label={t("library.props.sameName")}>{t("library.props.profileWins")}</PropRow>
        <p className="mt-1.5 text-[12.5px] text-faint">{t("library.props.sameNameNote")}</p>
      </PropGroup>
    </div>
  );
};
