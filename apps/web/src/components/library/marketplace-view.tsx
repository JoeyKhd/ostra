"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpenIcon, CheckIcon, CircleAlertIcon, DownloadIcon, ExternalLinkIcon, FileCodeIcon, FileTextIcon, InfoIcon, LinkIcon, LockIcon, PlugIcon, SearchIcon, StoreIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { installsText, pinText, resultKey, resultStateOf, searchSourceHost, sizeText, skillRowsOf, versionText } from "./library-model";
import type { LibraryItem, Look, ResultState, SearchResult, SearchSource } from "./library-model";
import { Note } from "./library-parts";

// The marketplace browser (F-146; app-targets/m8/library-browse.md): an org admin searches
// skills.sh or the organization's MCP registries, from the ostra server and never the browser, and
// installs a result through the library's one install (its allowlist and its pin). Search is off
// until an admin turns it on; a source that fails says its search is unavailable, while installing
// by reference still works. No third-party audit verdict is shown (Q319).

type Kind = "skills" | "servers";

/** What a search's words must be before Enter sends them: 2 characters for skills, 3 for servers (the registry's own floor). */
const MIN_WORDS: Readonly<Record<Kind, number>> = { skills: 2, servers: 3 };

/** The address that opens the install sheet over the library with a result's reference, looked up at once. */
const installHref = (result: SearchResult, host: string): string =>
  `/organization/skills?add=${result.kind === "skill" ? "skill" : "mcp"}&source=${encodeURIComponent(result.reference)}&from=marketplace&host=${encodeURIComponent(host)}`;

const LastCell = ({ state, onInstall }: { readonly state: ResultState; readonly onInstall: () => void }) => {
  switch (state.kind) {
    case "in-library":
      return <span className="inline-flex items-center gap-1.5 text-sm text-faint"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("library.market.inLibrary")}</span>;
    case "not-allowed":
      return (
        <span className="flex flex-col items-end gap-1">
          <Button size="sm" className="h-[26px]" disabled aria-disabled>{t("library.row.install")}</Button>
          <span className="inline-flex items-center gap-1 text-[11.5px] text-faint"><LockIcon aria-hidden className="size-[11px]" />{t("library.row.sourceNotAllowed")}</span>
        </span>
      );
    case "refused":
      return <span className="text-[12px] text-faint">{t("library.market.notSupported")}</span>;
    case "installable":
      return <Button size="sm" className="h-[26px]" onClick={(event) => { event.stopPropagation(); onInstall(); }} data-action="install-result">{t("library.row.install")}</Button>;
    default:
      return state satisfies never;
  }
};

export const MarketplaceView = () => {
  const id = useId();
  const trpc = useTRPC();
  const router = useRouter();
  const me = useQuery(trpc.me.get.queryOptions());
  const admin = me.data?.organization?.role === "admin";
  const state = useQuery(trpc.library.searchState.queryOptions(undefined, { enabled: admin }));
  const items = useQuery(trpc.library.list.queryOptions(undefined, { enabled: admin }));
  const setSearch = useMutation(trpc.library.setMarketplaceSearch.mutationOptions({ onSuccess: async () => { await state.refetch(); } }));
  const search = useMutation(trpc.library.search.mutationOptions());
  const inspect = useMutation(trpc.library.resolve.mutationOptions());
  const [kind, setKind] = useState<Kind>("skills");
  const [words, setWords] = useState("");
  const [sent, setSent] = useState<{ readonly kind: Kind; readonly words: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const sources: readonly SearchSource[] = search.data?.sources ?? [];
  const results = sources.flatMap((source) => (source.state === "ok" ? source.results.map((result) => ({ result, host: searchSourceHost(source.source) })) : []));
  const unavailable = sources.filter((source) => source.state === "unavailable");
  const chosen = results.find((entry) => resultKey(entry.result) === selected) ?? null;
  const registries = state.data?.sendsTo.registries ?? [];
  const registryHost = registries[0] === undefined ? t("library.market.registries") : URL.canParse(registries[0]) ? new URL(registries[0]).host : registries[0];

  const send = (): void => {
    const typed = words.trim();
    if (typed.length < MIN_WORDS[kind]) return;
    setSent({ kind, words: typed });
    setSelected(null);
    search.mutate({ kind, words: typed });
  };
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && words !== "") {
      event.preventDefault();
      setWords("");
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length > 0) {
      event.preventDefault();
      const at = results.findIndex((entry) => resultKey(entry.result) === selected);
      const next = results[event.key === "ArrowDown" ? Math.min(results.length - 1, at + 1) : Math.max(0, at - 1)];
      if (next !== undefined) setSelected(resultKey(next.result));
    }
  };
  // Selecting a skill result reads it at its source (the server's look), for its files and SKILL.md.
  useEffect(() => {
    if (chosen?.result.kind !== "skill") return;
    inspect.mutate({ reference: chosen.result.reference });
    // The look is asked for once per selection.
  }, [selected]);

  const crumbs = [{ label: t("shell.organization") }, { label: t("shell.skills"), href: "/organization/skills" }, { label: t("library.market.title") }];
  const off = me.data !== undefined && (!admin || (state.data !== undefined && !state.data.enabled));

  return (
    <PageFrame
      crumbs={crumbs}
      wideProperties
      actions={admin ? <Button asChild aria-label={t("library.addFromSource")}><Link href="/organization/skills?add=skill"><LinkIcon aria-hidden /><span className="hidden sm:inline">{t("library.addFromSource")}</span></Link></Button> : undefined}
      properties={off ? undefined : <ResultDetail chosen={chosen} items={items.data ?? []} look={inspect.data ?? null} looking={inspect.isPending} lookError={inspect.error === null ? null : errorText(inspect.error)} onInstall={(href) => { router.push(href); }} />}
    >
      <div data-testid="marketplace">
        <PageHeading title={t("library.market.title")} lede={t("library.market.lede")} />
        <Note icon={<InfoIcon aria-hidden />} className="mt-3.5 max-w-[720px]">
          {t("library.market.notice")}{" "}
          <Link href="/organization/skills" className="text-teal hover:underline">{t("library.props.policy")}</Link>
        </Note>

        {me.data === undefined || (admin && state.data === undefined) ? (
          <div aria-busy className="mt-5 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : off ? (
          <div className="mt-10 flex max-w-[560px] flex-col items-start gap-2" data-testid="marketplace-off">
            <StoreIcon aria-hidden className="size-7 stroke-[1.5] text-faint" />
            <p className="text-[16px] font-semibold text-text">{t("library.market.offTitle")}</p>
            <p className="text-ui text-muted">{admin && state.data?.offWords !== null && state.data?.offWords !== undefined ? state.data.offWords : t("library.market.offBody")}</p>
            {admin ? (
              <>
                {state.data?.sendsWords === undefined ? null : <p className="text-[12.5px] text-faint" data-testid="search-sends">{state.data.sendsWords}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {state.data?.instanceAllows === true ? (
                    <Button onClick={() => { setSearch.mutate({ enabled: true }); }} disabled={setSearch.isPending} data-action="turn-search-on">{t("library.market.turnOn")}</Button>
                  ) : null}
                  <Link href="/organization/skills?add=skill" className="text-ui text-teal hover:underline">{t("library.addFromSource")}</Link>
                </div>
                {setSearch.error === null ? null : <p role="alert" className="text-sm text-red">{errorText(setSearch.error)}</p>}
              </>
            ) : (
              <Button asChild className="mt-2"><Link href="/organization/skills?suggest=1">{t("library.suggest.button")}</Link></Button>
            )}
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <ToggleGroup type="single" value={kind} onValueChange={(value) => { if (value === "skills" || value === "servers") { setKind(value); setSelected(null); } }} aria-label={t("library.market.source")} className="h-[44px] w-full shrink-0 sm:h-7 sm:w-auto">
                <ToggleGroupItem value="skills" className="flex flex-1 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm [&_svg]:size-[14px]"><BookOpenIcon aria-hidden /> {t("library.market.skills")}<span className="text-faint">{`· ${state.data?.sendsTo.skills ?? ""}`}</span></ToggleGroupItem>
                <ToggleGroupItem value="servers" className="flex flex-1 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm [&_svg]:size-[14px]"><PlugIcon aria-hidden /> {t("library.market.servers")}<span className="text-faint">{`· ${registryHost}`}</span></ToggleGroupItem>
              </ToggleGroup>
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">{t("library.market.searchLabel")}</span>
                <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 text-faint" />
                <Input autoFocus value={words} onChange={(event) => { setWords(event.target.value); }} onKeyDown={onFieldKey} placeholder={kind === "skills" ? t("library.market.searchSkills") : t("library.market.searchServers")}
                  className="h-[44px] pl-8 pr-8 text-ui sm:h-[30px]" data-testid="marketplace-search" aria-describedby={`${id}-count`} />
                {words === "" ? null : (
                  <button type="button" aria-label={t("library.market.clear")} className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-text" onClick={() => { setWords(""); }}>
                    <XIcon aria-hidden className="size-[14px]" />
                  </button>
                )}
              </label>
            </div>

            <p id={`${id}-count`} className="mt-3 flex items-center gap-2 text-sm text-faint" aria-live="polite" data-testid="marketplace-count">
              {search.isPending
                ? t("library.market.searching", { host: kind === "skills" ? (state.data?.sendsTo.skills ?? "") : registryHost })
                : sent === null
                  ? t("library.market.before", { n: MIN_WORDS[kind] })
                  : t(sent.kind === "skills" ? "library.market.countSkills" : "library.market.countServers", { n: results.length })}
            </p>
            {search.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(search.error)}</p>}
            {unavailable.map((source) => (
              <p key={searchSourceHost(source.source)} role="alert" className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-text" data-testid="search-unavailable">
                <CircleAlertIcon aria-hidden className="size-[14px] text-red" />
                {t("library.market.unavailable", { host: searchSourceHost(source.source), reason: source.message })}
                <button type="button" className="text-teal hover:underline" onClick={send}>{t("library.tryAgain")}</button>
              </p>
            ))}

            {sent !== null && !search.isPending && results.length === 0 && unavailable.length === 0 && search.error === null ? (
              <p className="mt-4 text-ui text-muted" data-testid="marketplace-none">
                {t("library.market.noResults", { query: sent.words, host: sent.kind === "skills" ? (state.data?.sendsTo.skills ?? "") : registryHost })}{" "}
                <Link href={`/organization/skills?add=${sent.kind === "skills" ? "skill" : "mcp"}`} className="text-teal hover:underline">{t("library.market.bySource")}</Link>
              </p>
            ) : null}

            <ul role="listbox" aria-label={t("library.market.results")} className={cn("mt-2", search.isPending && "opacity-50")} data-testid="marketplace-results">
              {results.map(({ result, host }) => {
                const key = resultKey(result);
                const resultState = resultStateOf(result, items.data ?? []);
                const isSelected = key === selected;
                return (
                  <li
                    key={key}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => { setSelected(key); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { setSelected(key); } }}
                    className={cn("grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_84px_118px]", isSelected ? "rounded-[6px] bg-sel" : "hover:bg-hover")}
                    data-result={result.kind === "skill" ? result.skill : result.name}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-mono text-ui font-medium text-text">{result.kind === "skill" ? result.skill : result.name}</span>
                        <span className="truncate font-mono text-[12.5px] text-faint">{result.kind === "skill" ? result.source : (result.title ?? "")}</span>
                      </span>
                      {result.kind === "server" && result.description !== null ? <span className="block truncate text-sm text-muted">{result.description}</span> : null}
                      {result.kind === "server" ? <span className="mt-1 flex gap-1.5"><Chip className="h-5 px-1.5 text-[11.5px]">{result.refusal === null ? t("library.market.remote") : t("library.market.packagesOnly")}</Chip></span> : null}
                    </span>
                    <span className="hidden text-right sm:block">
                      <span className="block font-mono text-sm text-muted">{result.kind === "skill" ? installsText(result.installs) : versionText(result.version)}</span>
                      <span className="block text-[11.5px] text-faint">{result.kind === "skill" ? t("library.market.installs") : t("library.market.version")}</span>
                    </span>
                    <span className="justify-self-end"><LastCell state={resultState} onInstall={() => { router.push(installHref(result, host)); }} /></span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </PageFrame>
  );
};

/** The selected result's detail (380px): its source, what the server read at HEAD, and Install. */
const ResultDetail = ({ chosen, items, look, looking, lookError, onInstall }: {
  readonly chosen: { readonly result: SearchResult; readonly host: string } | null;
  readonly items: readonly LibraryItem[];
  readonly look: Look | null;
  readonly looking: boolean;
  readonly lookError: string | null;
  readonly onInstall: (href: string) => void;
}) => {
  if (chosen === null) return <p className="text-ui text-faint" data-testid="result-detail-empty">{t("library.market.selectOne")}</p>;
  const { result, host } = chosen;
  const state = resultStateOf(result, items);
  const skills = look?.resolved.kind === "skills" ? look.resolved : null;
  const row = skills === null ? undefined : skillRowsOf(skills, items).find((entry) => entry.name === (result.kind === "skill" ? result.skill : "")) ?? skillRowsOf(skills, items)[0];
  return (
    <div className="flex min-h-full flex-col" data-testid="result-detail">
      <h2 className="font-mono text-[17px] font-semibold text-text">{result.kind === "skill" ? result.skill : result.name}</h2>
      <p className="font-mono text-sm text-muted">{result.kind === "skill" ? result.source : result.registryUrl}</p>
      {row === undefined ? null : <p className="font-mono text-sm text-faint">{row.folder}</p>}
      {result.kind === "server" ? (result.description === null ? null : <p className="mt-2.5 text-ui text-text-2">{result.description}</p>) : row?.description === null || row?.description === undefined ? null : <p className="mt-2.5 text-ui text-text-2">{row.description}</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {result.kind === "skill" && result.installs !== null ? <Chip>{t("library.market.installsChip", { n: installsText(result.installs) })}</Chip> : null}
        {result.kind === "server" ? <Chip>{versionText(result.version)}</Chip> : null}
      </div>
      {result.kind === "skill" ? (
        <>
          <h3 className="mt-4 text-xs font-medium text-faint">{t("library.market.skillMd")}</h3>
          {looking ? <Skeleton className="mt-1.5 h-20 w-full" /> : lookError !== null ? <p role="alert" className="mt-1.5 text-sm text-red">{lookError}</p> : row === undefined ? null : (
            <pre className="mt-1.5 max-h-[220px] overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-text-2">
              {["---", `name: ${row.name}`, `description: ${row.description ?? ""}`, "---"].join("\n")}
            </pre>
          )}
          {row === undefined ? null : (
            <>
              <h3 className="mt-4 text-xs font-medium text-faint">{t("library.market.files", { n: row.files })}</h3>
              <ul className="mt-1">
                {row.skill.files.slice(0, 8).map((file) => (
                  <li key={file.path} className="flex h-[26px] items-center gap-2">
                    {row.skill.scripts.some((script) => script.path === file.path) ? <FileCodeIcon aria-hidden className="size-[14px] text-faint" /> : <FileTextIcon aria-hidden className="size-[14px] text-faint" />}
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{file.path}</span>
                    <span className="font-mono text-[12px] text-faint">{sizeText(file.size)}</span>
                  </li>
                ))}
              </ul>
              {row.skill.files.length > 8 ? <p className="text-sm text-faint">{t("library.props.andMore", { n: row.skill.files.length - 8 })}</p> : null}
            </>
          )}
        </>
      ) : null}
      <div className="mt-auto border-t border-line pt-3">
        {state.kind === "in-library" ? (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-sm text-muted">{t("library.market.inLibraryAt", { pin: pinText(state.item.pin) })}</span>
            <Button asChild className="ml-auto"><Link href={`/organization/skills/${state.item.itemId}`}>{t("library.market.open")}</Link></Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              {result.kind === "skill"
                ? t("library.market.pinLine", { commit: skills?.commit?.slice(0, 7) ?? "…" })
                : t("library.market.pinLineServer", { version: versionText(result.version) })}
            </p>
            {state.kind === "not-allowed" ? <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted"><LockIcon aria-hidden className="size-[13px]" />{t("library.market.notAllowedLine", { source: result.kind === "skill" ? result.source : result.name })}</p> : null}
            {state.kind === "refused" ? <p className="mt-1.5 text-sm text-muted">{t("library.market.notSupportedLine")}</p> : null}
            <div className="mt-2.5 flex items-center gap-2">
              {result.kind === "skill" ? (
                <Button variant="ghost" asChild>
                  <a href={`https://github.com/${result.source}`} target="_blank" rel="noreferrer"><ExternalLinkIcon aria-hidden />{t("library.market.source")}</a>
                </Button>
              ) : null}
              <Button variant="primary" className="h-[44px] flex-1 sm:h-[30px]" disabled={state.kind !== "installable"} onClick={() => { onInstall(installHref(result, host)); }} data-action="install-selected">
                <DownloadIcon aria-hidden />{t("library.row.install")}
              </Button>
            </div>
            {state.kind === "not-allowed" ? <Link href={installHref(result, host)} className="mt-1.5 inline-block text-sm text-teal hover:underline">{t("library.market.allowIt")}</Link> : null}
          </>
        )}
      </div>
    </div>
  );
};
