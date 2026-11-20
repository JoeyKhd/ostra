"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { FilterMenu } from "@/components/organization/filter-menu";
import type { FilterOption } from "@/components/organization/filter-menu";
import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { Highlight, isCodeSnippet, resultHref, snippetLabel, SnippetLine } from "./highlight";
import { joinQuery, periodAfter, splitQuery, statusValues } from "./search-query";
import type { Token, TokenKey } from "./search-query";

type Result = RouterOutputs["search"]["tasks"]["results"][number];

const MAX_QUERY = 500;
const DEBOUNCE_MS = 250;
const LIMIT = 100;

/** The page's filters, each kept in the URL under its own name (search.md, "Filter row"). */
const filterParams = { project: "project", repo: "repo", ticket: "ticket", by: "by", status: "state" } as const satisfies Partial<Record<TokenKey, string>>;
type FilterKey = keyof typeof filterParams;
const filterKeys = ["project", "repo", "ticket", "by", "status"] as const satisfies readonly FilterKey[];
const isFilterKey = (key: TokenKey): key is FilterKey => key in filterParams;

const periods = ["7d", "30d", "90d", "any"] as const;
type Period = (typeof periods)[number];
const periodWord = (period: Period): string => (period === "7d" ? t("search.page.last7") : period === "30d" ? t("search.page.last30") : period === "90d" ? t("search.page.last90") : t("search.page.anyTime"));

const stateWord = (state: string): string => state.replaceAll("_", " ");

const ResultPanel = ({ result }: { readonly result: Result }) => {
  const href = resultHref(result.taskId, result.snippets);
  return (
    <div data-testid="search-panel">
      <div className="flex items-center">
        <span className="font-mono text-xs text-faint">{result.taskId.slice(0, 8)}</span>
        <Link href={href} className="ml-auto inline-flex items-center gap-1 text-sm text-teal hover:underline">
          {t("search.page.openTask")} <ArrowRightIcon aria-hidden className="size-3 stroke-[1.75]" />
        </Link>
      </div>
      <h2 className="mb-2.5 mt-1 break-words text-[15px] font-semibold text-text">{result.title}</h2>
      <PropGroup title={t("search.page.task")}>
        <PropRow label={t("search.page.state")} labelWidth={96}>{stateWord(result.state)}</PropRow>
        <PropRow label={t("search.page.project")} labelWidth={96}>
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(result.projectId) }} />
          <span className="truncate">{result.projectName}</span>
        </PropRow>
        <PropRow label={t("search.page.ticket")} labelWidth={96}>
          {result.ticketKey === null ? <span className="text-faint">–</span> : <span className="font-mono">{result.ticketKey}</span>}
        </PropRow>
      </PropGroup>
      <div className="mb-4">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-faint">
          {t("search.page.matches")}
          <span className="font-mono">{result.snippets.length}</span>
        </h3>
        <ul>
          {result.snippets.map((snippet, index) => (
            <li key={index}>
              <Link
                href={snippet.eventSeq === null ? `/tasks/${result.taskId}` : `/tasks/${result.taskId}?event=${String(snippet.eventSeq)}`}
                className="flex h-[30px] items-center gap-2 rounded-sm text-ui hover:bg-hover"
              >
                <span className="w-[96px] shrink-0 truncate text-xs text-faint">{snippetLabel(snippet)}</span>
                <Highlight parts={snippet.parts} lead={12} className={cn("min-w-0 flex-1 truncate text-muted", isCodeSnippet(snippet) && "font-mono text-[13px]")} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <Button asChild className="w-full">
        <Link href={href}>
          <ArrowRightIcon className="stroke-[1.75]" />
          {t("search.page.openTask")}
        </Link>
      </Button>
    </div>
  );
};

/**
 * The search page (F-080, ADR 0054; search.md): the query, its filters as controls kept in the URL, and
 * every matching task once, ranked, with what matched. Only tasks the member can open are ever found.
 */
export const SearchView = ({ organization }: { readonly organization: string }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [now] = useState(() => Date.now());

  const [typed, setTyped] = useState(() => params.get("q") ?? "");
  const [text, setText] = useState(typed);
  useEffect(() => {
    const timer = setTimeout(() => { setText(typed); }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [typed]);

  const filters: Readonly<Record<FilterKey, string | null>> = {
    project: params.get("project"),
    repo: params.get("repo"),
    ticket: params.get("ticket"),
    by: params.get("by"),
    status: params.get("state"),
  };
  const periodParam = params.get("period");
  const period: Period = periods.find((value) => value === periodParam) ?? "30d";

  const setParams = (changes: Readonly<Record<string, string | null>>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  // The text in the URL, as it settles. A token that set its control wrote the URL itself.
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (written.current === text) {
      written.current = null;
      return;
    }
    if ((params.get("q") ?? "") !== text.trim()) setParams({ q: text.trim() === "" ? null : text.trim(), task: null });
    // Only the text drives this; the other parameters are kept as they are.
  }, [text]);

  /** Typed tokens leave the text and set their control once the space after them is typed. */
  const onType = (value: string) => {
    const split = splitQuery(value.slice(0, MAX_QUERY));
    const moved = split.tokens.filter((token): token is Token & { readonly key: FilterKey } => isFilterKey(token.key));
    if (moved.length === 0) {
      setTyped(value.slice(0, MAX_QUERY));
      return;
    }
    const kept = split.tokens.filter((token) => !isFilterKey(token.key));
    const rest = joinQuery(kept, split.text);
    setTyped(rest);
    written.current = rest;
    setText(rest);
    setParams({ ...Object.fromEntries(moved.map((token) => [filterParams[token.key], token.value])), q: rest.trim() === "" ? null : rest.trim(), task: null });
  };

  const tokens: Token[] = [];
  for (const key of filterKeys) {
    const value = filters[key];
    if (value !== null) tokens.push({ key, value });
  }
  const after = periodAfter(period, now);
  if (after !== null) tokens.push({ key: "after", value: after });
  const query = joinQuery(tokens, text);
  const anyFilter = Object.values(filters).some((value) => value !== null);
  const active = text.trim() !== "" || anyFilter;

  const search = useQuery({ ...trpc.search.tasks.queryOptions({ query, limit: LIMIT }), enabled: active, placeholderData: keepPreviousData });
  const projects = useQuery(trpc.projects.list.queryOptions());
  const members = useQuery(trpc.members.list.queryOptions());

  const results = active ? (search.data?.results ?? []) : [];
  const picked = params.get("task");
  const selected = results.find((result) => result.taskId === picked) ?? results[0];

  const projectOptions: FilterOption[] = (projects.data ?? []).map((project) => ({ value: project.slug, label: project.name }));
  const memberOptions: FilterOption[] = [
    { value: "me", label: "me" },
    ...(members.data ?? []).flatMap((member) => (member.username === null || member.state !== "active" ? [] : [{ value: member.username, label: member.name }])),
  ];
  const stateOptions: FilterOption[] = statusValues.map((value) => ({ value, label: stateWord(value.replaceAll("-", "_")) }));
  const repoOptions: FilterOption[] = filters.repo === null ? [] : [{ value: filters.repo, label: filters.repo, mono: true }];
  const ticketOptions: FilterOption[] = [
    ...new Set([...(filters.ticket === null ? [] : [filters.ticket]), ...results.flatMap((result) => (result.ticketKey === null ? [] : [result.ticketKey]))]),
  ].map((key) => ({ value: key, label: key, mono: true }));

  const onListKey = (event: KeyboardEvent<HTMLElement>, result: Result) => {
    if (event.key === "Enter") {
      router.push(resultHref(result.taskId, result.snippets));
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = results.findIndex((candidate) => candidate.taskId === result.taskId);
    const next = results[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    setParams({ task: next.taskId });
    requestAnimationFrame(() => { document.querySelector<HTMLElement>(`[data-result="${next.taskId}"]`)?.focus(); });
  };

  const total = search.data?.total ?? 0;
  const countText = !active || search.data === undefined ? null : search.data.totalCapped ? t("search.page.countMore", { n: total }) : plural(total, "search.page.countOne", "search.page.countOther");
  const clearFilters = () => { setParams({ project: null, repo: null, ticket: null, by: null, state: null, period: null, task: null }); };
  const showPanel = active && selected !== undefined;

  return (
    <PageFrame
      crumbs={[{ label: organization }, { label: t("search.title") }]}
      {...(showPanel ? { properties: <ResultPanel result={selected} /> } : {})}
    >
      <PageHeading title={t("search.title")} lede={t("search.page.lede")} />
      <div className="relative mt-[18px]">
        <SearchIcon aria-hidden className="absolute left-3 top-1/2 size-[15px] -translate-y-1/2 stroke-[1.75] text-faint" />
        <Input
          autoFocus
          aria-label={t("search.title")}
          placeholder={t("search.page.placeholder")}
          value={typed}
          maxLength={MAX_QUERY}
          onChange={(event) => { onType(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onType("");
          }}
          className="h-9 rounded-lg border-line-2 bg-surface pl-9 pr-14 text-body"
          data-testid="search-query"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2">
          {search.isFetching && active ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin text-faint" /> : typed === "" ? null : <Kbd>Esc</Kbd>}
        </span>
      </div>
      {typed.length >= MAX_QUERY ? <p className="mt-1 text-xs text-faint">{t("search.page.tooLong")}</p> : null}

      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1" data-testid="search-filters">
        <FilterMenu testId="search-filter-project" label={t("search.page.project")} value={filters.project} defaultLabel={t("search.page.all")} options={projectOptions} searchable onChange={(value) => { setParams({ project: value, task: null }); }} />
        <FilterMenu
          testId="search-filter-repo"
          label={t("search.page.repo")}
          value={filters.repo}
          defaultLabel={t("search.page.all")}
          options={repoOptions}
          onChange={(value) => { setParams({ repo: value, task: null }); }}
          extra={<FreeValue label={t("search.page.repo")} onPick={(value) => { setParams({ repo: value, task: null }); }} />}
        />
        <FilterMenu
          testId="search-filter-ticket"
          label={t("search.page.ticket")}
          value={filters.ticket}
          defaultLabel={t("search.page.all")}
          options={ticketOptions}
          onChange={(value) => { setParams({ ticket: value, task: null }); }}
          extra={<FreeValue label={t("search.page.ticket")} onPick={(value) => { setParams({ ticket: value, task: null }); }} />}
        />
        <FilterMenu testId="search-filter-member" label={t("search.page.member")} value={filters.by} defaultLabel={t("search.page.all")} options={memberOptions} searchable onChange={(value) => { setParams({ by: value, task: null }); }} />
        <FilterMenu testId="search-filter-state" label={t("search.page.state")} value={filters.status} defaultLabel={t("search.page.any")} options={stateOptions} onChange={(value) => { setParams({ state: value, task: null }); }} />
        <FilterMenu
          testId="search-filter-period"
          label={t("search.page.period")}
          value={period === "30d" ? null : period}
          defaultLabel={periodWord("30d")}
          options={periods.map((value) => ({ value, label: periodWord(value) }))}
          onChange={(value) => { setParams({ period: value, task: null }); }}
        />
        {countText === null ? null : <span className="ml-auto shrink-0 font-mono text-xs text-faint" data-testid="search-count">{countText}</span>}
      </div>

      {!active ? (
        <div className="mx-auto mt-8 max-w-[480px] text-center">
          <img src="/search-empty-illustration.webp" alt="" width={480} height={320} className="mx-auto aspect-[3/2] h-auto w-full max-w-[480px] rounded-lg object-cover" />
          <p className="mt-4 text-[15px] font-semibold text-text">{t("search.page.emptyTitle")}</p>
          <p className="mt-2 text-[13.5px] text-muted">{t("search.page.emptyLede")}</p>
        </div>
      ) : search.isError ? (
        <p role="alert" className="mt-5 flex items-center gap-2 text-sm text-red"><CircleAlertIcon aria-hidden className="size-[15px]" />{errorText(search.error)}</p>
      ) : search.data === undefined ? (
        <div className="mt-4 space-y-3" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-2 border-b border-line px-3.5 py-3"><Skeleton className="w-[320px]" /><Skeleton className="w-[240px]" /><Skeleton className="w-[480px] max-w-full" /></div>
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="mt-6">
          <p className="text-[13.5px] text-muted">
            {text.trim() === "" ? t("search.page.noMatchNoText") : anyFilter ? t("search.page.noMatchFilters", { query: text.trim() }) : t("search.page.noMatch", { query: text.trim() })}{" "}
            {anyFilter ? <Button variant="link" onClick={clearFilters}>{t("search.page.clearFilters")}</Button> : null}
          </p>
          <p className="mt-1.5 text-[12.5px] text-faint">{t("search.page.covers")}</p>
        </div>
      ) : (
        <ul className={cn("mt-4", search.isPlaceholderData && "opacity-60")} aria-label={t("search.title")} data-testid="search-results">
          {results.map((result) => {
            const titleSnippet = result.snippets.find((snippet) => snippet.kind === "title");
            const lines = result.snippets.filter((snippet) => snippet.kind !== "title");
            const isSelected = selected?.taskId === result.taskId;
            return (
              <li key={result.taskId}>
                <div
                  role="button"
                  tabIndex={0}
                  data-result={result.taskId}
                  data-testid="search-result"
                  aria-pressed={isSelected}
                  onClick={() => { setParams({ task: result.taskId }); }}
                  onDoubleClick={() => { router.push(resultHref(result.taskId, result.snippets)); }}
                  onKeyDown={(event) => { onListKey(event, result); }}
                  className={cn("block cursor-default rounded-md border-b border-line px-3.5 py-3 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted", isSelected && "bg-sel hover:bg-sel")}
                >
                  <div className="flex h-[22px] items-center gap-3">
                    <span className="w-[110px] shrink-0 truncate text-sm text-muted">{stateWord(result.state)}</span>
                    <span className="min-w-0 flex-1 truncate text-body text-text">{titleSnippet === undefined ? result.title : <Highlight parts={titleSnippet.parts} />}</span>
                  </div>
                  <div className="flex h-5 items-center gap-1.5 text-[13px] text-faint sm:pl-[122px]">
                    <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(result.projectId) }} />
                    <span className="truncate text-muted">{result.projectName}</span>
                    {result.ticketKey === null ? null : <span className="font-mono">· {result.ticketKey}</span>}
                    <span className="hidden font-mono sm:inline">· {result.taskId.slice(0, 8)}</span>
                  </div>
                  {lines.slice(0, 2).map((snippet, index) => (
                    <Link
                      key={index}
                      href={snippet.eventSeq === null ? `/tasks/${result.taskId}` : `/tasks/${result.taskId}?event=${String(snippet.eventSeq)}`}
                      onClick={(event) => { event.stopPropagation(); }}
                      className="mt-1.5 flex items-baseline"
                    >
                      <SnippetLine snippet={snippet} className="min-w-0 flex-1" />
                      {index === 1 && lines.length > 2 ? <span className="shrink-0 pl-2 text-xs text-faint">{t("search.page.more", { n: lines.length - 2 })}</span> : null}
                    </Link>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageFrame>
  );
};

/** A value typed in a filter's menu (a repo or a ticket key the results don't list yet). */
const FreeValue = ({ label, onPick }: { readonly label: string; readonly onPick: (value: string) => void }) => {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-1 border-t border-line px-1 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        const picked = value.trim();
        if (/^[^\s"']{1,200}$/.test(picked)) onPick(picked);
      }}
    >
      <Input aria-label={t("search.page.typeKey")} placeholder={label} value={value} onChange={(event) => { setValue(event.target.value); }} className="h-8 font-mono text-[13px]" />
    </form>
  );
};
