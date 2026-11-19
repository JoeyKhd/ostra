"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  BoxIcon,
  CornerDownLeftIcon,
  CpuIcon,
  GitPullRequestIcon,
  HouseIcon,
  ListChecksIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { destinations, matchDestinations } from "@/components/shell/destinations";
import type { Destination, DestinationIcon } from "@/components/shell/destinations";
import { projectColour } from "@/components/shell/project-colour";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { Highlight, resultHref, SnippetLine } from "./search/highlight";
import { joinQuery, pendingKey, pendingValue, splitQuery, statusValues, tokenKeys } from "./search/search-query";
import type { Token } from "./search/search-query";

type Result = RouterOutputs["search"]["suggest"]["results"][number];

const icons: Record<Exclude<DestinationIcon, "project">, ReactNode> = {
  home: <HouseIcon />,
  "new-task": <SquarePenIcon />,
  tasks: <ListChecksIcon />,
  environment: <BoxIcon />,
  "new-project": <PlusIcon />,
  runners: <ServerIcon />,
  models: <CpuIcon />,
  github: <GitPullRequestIcon />,
  "agent-profiles": <SlidersHorizontalIcon />,
};

const DestinationMark = ({ destination }: { readonly destination: Destination }) =>
  destination.icon === "project" ? (
    <span aria-hidden className="mx-[3.5px] size-2 shrink-0 rounded-[2px]" style={{ background: destination.colour }} />
  ) : (
    icons[destination.icon]
  );

/** The 150 ms the palette waits after a key before it asks (search-palette.md, "Typing"). */
const DEBOUNCE_MS = 150;

const useDebounced = (value: string, ms: number): string => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); }, ms);
    return () => { clearTimeout(timer); };
  }, [value, ms]);
  return debounced;
};

const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type Item = { readonly kind: "result"; readonly result: Result } | { readonly kind: "all" } | { readonly kind: "page"; readonly destination: Destination } | { readonly kind: "value"; readonly value: string };

const stateWord = (state: string): string => state.replaceAll("_", " ");

/**
 * The search palette (F-080, ADR 0054; search-palette.md): Ctrl+K or ⌘K on every panel page. The query's
 * filter tokens become chips, the top tasks come from `search.suggest` with what matched marked, and
 * Enter opens a task at its matched event. The pages the sidebar has follow, as `Go to`.
 */
export const SearchPalette = ({ open, onOpenChange, admin }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const projects = useQuery(trpc.projects.list.queryOptions());
  const members = useQuery({ ...trpc.members.list.queryOptions(), enabled: open });
  const [tokens, setTokens] = useState<readonly Token[]>([]);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);

  const query = joinQuery(tokens, text);
  const asked = useDebounced(query, DEBOUNCE_MS);
  const pending = pendingKey(text);
  const suggest = useQuery({
    ...trpc.search.suggest.queryOptions({ query: asked }),
    enabled: open && asked.trim() !== "" && pending === null,
    placeholderData: keepPreviousData,
  });

  const all = useMemo(
    () => destinations((projects.data ?? []).map((project) => ({ id: project.id, name: project.name, colour: projectColour(project.id) })), admin),
    [projects.data, admin],
  );
  const pages = tokens.length === 0 && pending === null ? matchDestinations(all, text).slice(0, query.trim() === "" ? 8 : 3) : [];

  // A key with no value yet lists the values it takes.
  const values = useMemo((): readonly string[] => {
    if (pending === null) return [];
    const typed = pendingValue(text).toLowerCase();
    const candidates = (() => {
      switch (pending) {
        case "status":
          return [...statusValues];
        case "project":
          return (projects.data ?? []).map((project) => project.slug);
        case "by":
          return ["me", ...(members.data ?? []).flatMap((member) => (member.username === null ? [] : [member.username]))];
        case "after":
        case "before":
          return [new Date().toISOString().slice(0, 10)];
        case "repo":
        case "ticket":
          return [];
        default:
          return pending satisfies never;
      }
    })();
    return candidates.filter((value) => value.toLowerCase().startsWith(typed)).slice(0, 8);
  }, [pending, text, projects.data, members.data]);

  const results = query.trim() === "" ? [] : (suggest.data?.results ?? []);
  const total = suggest.data?.total ?? 0;
  const items: readonly Item[] =
    pending !== null
      ? values.map((value) => ({ kind: "value" as const, value }))
      : [
          ...results.map((result) => ({ kind: "result" as const, result })),
          ...(query.trim() === "" ? [] : [{ kind: "all" as const }]),
          ...pages.map((destination) => ({ kind: "page" as const, destination })),
        ];

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [open, onOpenChange]);

  const close = () => { onOpenChange(false); };
  const seeAll = () => {
    close();
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };
  const choose = (item: Item) => {
    switch (item.kind) {
      case "result":
        close();
        router.push(resultHref(item.result.taskId, item.result.snippets));
        return;
      case "all":
        seeAll();
        return;
      case "page":
        close();
        router.push(item.destination.href);
        return;
      case "value":
        complete(item.value);
        return;
      default:
        item satisfies never;
    }
  };

  /** The typed text, with its finished tokens moved into chips. */
  const takeText = (next: string) => {
    const split = splitQuery(next);
    if (split.tokens.length > 0) setTokens((previous) => [...previous, ...split.tokens]);
    setText(split.tokens.length > 0 ? split.text.trimStart() : next);
    setActive(0);
  };
  const complete = (value: string) => {
    const words = text.split(/(\s+)/);
    const last = words.pop() ?? "";
    const key = last.slice(0, last.indexOf(":"));
    takeText(`${words.join("")}${key}:${value} `);
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (items.length === 0 ? 0 : (index + 1) % items.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (items.length === 0 ? 0 : (index - 1 + items.length) % items.length));
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (query.trim() !== "") seeAll();
    } else if (event.key === "Enter" || (event.key === "Tab" && pending !== null)) {
      const item = items[active];
      if (item !== undefined) {
        event.preventDefault();
        choose(item);
      }
    } else if (event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && tokens.length > 0) {
      event.preventDefault();
      const last = tokens.at(-1);
      if (last === undefined) return;
      setTokens(tokens.slice(0, -1));
      setText(`${last.key}:${last.value}${text === "" ? "" : ` ${text}`}`);
    } else if (event.key === "Escape" && pending !== null) {
      event.preventDefault();
      setText(text.replace(/\S+$/, ""));
    }
  };

  const activeId = items[active] === undefined ? undefined : `${listId}-${String(active)}`;
  const mac = isMac();
  const searching = suggest.isFetching && query.trim() !== "";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setActive(0);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="search-palette"
          className="fixed left-1/2 top-[14vh] z-50 flex max-h-[min(560px,70vh)] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-[0_16px_48px_rgba(0,0,0,0.5)] focus:outline-none max-sm:top-[58px]"
        >
          <Dialog.Title className="sr-only">{t("search.palette.title")}</Dialog.Title>
          <div className="relative flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <SearchIcon aria-hidden className="mr-1 size-4 shrink-0 stroke-[1.75] text-muted" />
            {tokens.map((token, index) => (
              <span key={`${token.key}-${String(index)}`} data-testid="search-chip" className="inline-flex h-6 shrink-0 items-center rounded-[5px] border border-line-2 bg-bg px-2 font-mono text-[12.5px]">
                <span className="text-faint">{token.key}:</span>
                <span className="text-text">{token.value}</span>
              </span>
            ))}
            <input
              ref={input}
              autoFocus
              value={text}
              onChange={(event) => { takeText(event.target.value); }}
              onKeyDown={onKeyDown}
              placeholder={tokens.length === 0 ? t("search.palette.placeholder") : ""}
              role="combobox"
              aria-label={t("search.palette.title")}
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeId}
              className="min-w-[120px] flex-1 bg-transparent text-[15px] text-text placeholder:text-faint focus:outline-none"
            />
            <Kbd className="shrink-0">esc</Kbd>
            {searching ? <span aria-hidden className="absolute bottom-0 left-0 h-0.5 w-1/3 animate-pulse bg-line-2" /> : null}
          </div>

          <div id={listId} role="listbox" aria-label={t("search.palette.title")} className="min-h-0 flex-1 overflow-y-auto py-1">
            {pending !== null ? (
              values.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-faint">{t("search.palette.typeValue", { key: pending })}</p>
              ) : (
                values.map((value, index) => (
                  <div
                    key={value}
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => { setActive(index); }}
                    onClick={() => { complete(value); }}
                    className={cn("mx-1.5 flex h-8 cursor-default items-center rounded-lg px-2.5 font-mono text-[13px] text-text", index === active && "bg-sel")}
                  >
                    <span className="text-faint">{pending}:</span>
                    {value}
                  </div>
                ))
              )
            ) : null}

            {pending === null && query.trim() !== "" ? (
              <>
                <div className="flex h-[30px] items-center px-4 text-xs font-medium text-faint">
                  {t("search.palette.tasks")}
                  {suggest.data === undefined ? null : <span className="ml-auto font-mono" data-testid="search-palette-total">{plural(total, "search.palette.matchOne", "search.palette.matchOther")}</span>}
                </div>
                {suggest.isError ? (
                  <p className="px-4 py-3 text-[13px] text-red">
                    {t("search.palette.failed", { error: errorText(suggest.error) ?? "" })}{" "}
                    <button type="button" className="text-teal hover:underline" onClick={() => { void suggest.refetch(); }}>{t("search.palette.tryAgain")}</button>
                  </p>
                ) : suggest.data === undefined ? (
                  <div className="space-y-2 px-4 py-2" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
                ) : results.length === 0 ? (
                  <div className="px-4 py-7 text-center">
                    <p className="text-ui text-muted">{t("search.palette.none")}</p>
                    <p className="mt-1 text-[13px] text-faint">{t("search.palette.noneHint")}</p>
                  </div>
                ) : (
                  results.map((result, index) => {
                    const titleSnippet = result.snippets.find((snippet) => snippet.kind === "title");
                    const lines = result.snippets.filter((snippet) => snippet.kind !== "title").slice(0, 2);
                    return (
                      <div
                        key={result.taskId}
                        id={`${listId}-${String(index)}`}
                        role="option"
                        aria-selected={index === active}
                        data-testid="search-palette-result"
                        data-task={result.taskId}
                        onMouseMove={() => { setActive(index); }}
                        onClick={() => { choose({ kind: "result", result }); }}
                        className={cn(
                          "mx-1.5 grid cursor-default grid-cols-[minmax(0,1fr)_40px] gap-x-3 rounded-lg border-b border-line px-2.5 py-2.5 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)_130px_104px_40px]",
                          index === active && "bg-sel",
                        )}
                      >
                        <span className="hidden truncate pt-0.5 font-mono text-[12.5px] text-faint sm:inline">{result.ticketKey ?? result.taskId.slice(0, 8)}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-ui text-text">{titleSnippet === undefined ? result.title : <Highlight parts={titleSnippet.parts} />}</span>
                          {lines.map((snippet, line) => <SnippetLine key={line} snippet={snippet} className="mt-0.5" />)}
                        </span>
                        <span className="hidden min-w-0 items-start gap-2 pt-1 sm:flex">
                          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(result.projectId) }} />
                          <span className="truncate text-[13px] text-muted">{result.projectName}</span>
                        </span>
                        <span className="hidden truncate pt-0.5 text-[13px] text-muted sm:inline">{stateWord(result.state)}</span>
                        <span className="flex justify-end pt-0.5">{index === active ? <Kbd><CornerDownLeftIcon aria-hidden className="size-3" /></Kbd> : null}</span>
                      </div>
                    );
                  })
                )}
                {(() => {
                  const index = results.length;
                  return (
                    <div
                      id={`${listId}-${String(index)}`}
                      role="option"
                      aria-selected={index === active}
                      data-testid="search-palette-all"
                      onMouseMove={() => { setActive(index); }}
                      onClick={seeAll}
                      className={cn("mx-1.5 mt-1 flex h-11 cursor-default items-center gap-2.5 rounded-lg border-t border-line px-2.5", index === active && "bg-sel")}
                    >
                      <ArrowRightIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                      <span className="text-ui font-medium text-text">
                        {results.length === 0 ? t("search.palette.openPage") : plural(total, "search.palette.seeAllOne", "search.palette.seeAllOther")}
                      </span>
                      <span className="ml-auto flex gap-1"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd></span>
                    </div>
                  );
                })()}
              </>
            ) : null}

            {pending === null && pages.length > 0 ? (
              <>
                <div className="flex h-[30px] items-center px-4 text-xs font-medium text-faint">{t("search.palette.goTo")}</div>
                {pages.map((destination, offset) => {
                  const index = (query.trim() === "" ? 0 : results.length + 1) + offset;
                  return (
                    <div
                      key={`${destination.href}-${destination.icon}`}
                      id={`${listId}-${String(index)}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseMove={() => { setActive(index); }}
                      onClick={() => { choose({ kind: "page", destination }); }}
                      className={cn(
                        "mx-1.5 flex h-8 cursor-default items-center gap-[9px] rounded-lg px-2.5 text-text [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
                        index === active && "bg-sel",
                      )}
                    >
                      <DestinationMark destination={destination} />
                      <span className="min-w-0 truncate">{destination.label}</span>
                      {destination.context === undefined ? null : <span className="min-w-0 truncate text-faint">{destination.context}</span>}
                    </div>
                  );
                })}
              </>
            ) : null}
          </div>

          <div className="flex h-9 shrink-0 items-center gap-3.5 whitespace-nowrap border-t border-line px-4 text-xs text-faint">
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("search.palette.move")}</span>
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>↵</Kbd>{t("search.palette.open")}</span>
            <span className="hidden shrink-0 items-center gap-1.5 md:flex"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd>{t("search.palette.seeAll")}</span>
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>esc</Kbd>{t("search.palette.close")}</span>
            <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
              {t("search.palette.filters")}
              {tokenKeys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="font-mono hover:text-text"
                  onClick={() => {
                    takeText(`${text}${text === "" || text.endsWith(" ") ? "" : " "}${key}:`);
                    input.current?.focus();
                  }}
                >
                  {key}:
                </button>
              ))}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
