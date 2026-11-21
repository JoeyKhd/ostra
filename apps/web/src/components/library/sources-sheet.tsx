"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { dayText, sourceEntryText } from "./library-model";
import { focusBack } from "./library-parts";
import { RemoveButton } from "@/components/agent-profiles/rules-section";

// The library's allowlist (F-145; library.md, Policy's `Edit`): every source an install, an update
// or a suggestion is matched against, by source and never by a name (ADR 0069). An admin adds a
// GitHub owner or repo, a well-known host, or a registry and its namespace, and takes one off: its
// items stay installed, marked, and their updates are refused.

type EntryKind = "github_owner" | "github_repo" | "well_known_host" | "registry";

const kinds: readonly EntryKind[] = ["github_owner", "github_repo", "well_known_host", "registry"];

const kindLabel = (kind: EntryKind): string => {
  switch (kind) {
    case "github_owner":
      return t("library.sources.githubOwner");
    case "github_repo":
      return t("library.sources.githubRepo");
    case "well_known_host":
      return t("library.sources.wellKnownHost");
    case "registry":
      return t("library.sources.registry");
    default:
      return kind satisfies never;
  }
};

export const SourcesSheet = ({ open, onClose, returnFocusTo }: { readonly open: boolean; readonly onClose: () => void; readonly returnFocusTo?: string }) => {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sources = useQuery(trpc.library.sources.list.queryOptions(undefined, { enabled: open }));
  const [kind, setKind] = useState<EntryKind>("github_owner");
  const [value, setValue] = useState("");
  const [namespace, setNamespace] = useState("");
  const refresh = async (): Promise<void> => { await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }); };
  const add = useMutation(trpc.library.sources.add.mutationOptions({ onSuccess: async () => { setValue(""); setNamespace(""); await refresh(); } }));
  const remove = useMutation(trpc.library.sources.remove.mutationOptions({ onSuccess: refresh }));
  const submit = (): void => {
    if (value.trim() === "") return;
    add.mutate({ entry: kind === "registry" ? { kind, value: value.trim(), namespace: namespace.trim() === "" ? null : namespace.trim() } : { kind, value: value.trim() } });
  };
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent title={t("library.sources.title")} className="w-full sm:w-[min(480px,100vw)]" onCloseAutoFocus={focusBack(returnFocusTo)}>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-5" data-testid="sources-sheet">
          <h2 className="text-[17px] font-semibold text-text">{t("library.sources.title")}</h2>
          <p className="mt-0.5 text-[13.5px] text-muted">{t("library.sources.lede")}</p>
          {sources.data === undefined ? (
            <div aria-busy className="mt-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
          ) : sources.data.length === 0 ? (
            <p className="mt-4 text-ui text-faint">{t("library.props.noSources")}</p>
          ) : (
            <ul className="mt-4 border-t border-line">
              {sources.data.map((entry) => (
                <li key={entry.sourceId} className="flex min-h-[44px] items-center gap-3 border-b border-line py-1.5" data-source-entry={sourceEntryText(entry)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm text-text">{sourceEntryText(entry)}</span>
                    <span className="block truncate text-[12.5px] text-faint">
                      {entry.addedBy === null ? t("library.sources.seeded") : t("library.sources.addedBy", { name: entry.addedBy.name ?? t("library.someone"), date: dayText(entry.createdAt) })}
                      {" · "}
                      {plural(entry.items, "library.sources.itemsOne", "library.sources.itemsMany")}
                    </span>
                  </span>
                  <RemoveButton label={t("library.sources.remove", { entry: sourceEntryText(entry) })} onClick={() => { remove.mutate({ sourceId: entry.sourceId }); }} />
                </li>
              ))}
            </ul>
          )}
          {remove.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(remove.error)}</p>}

          <h3 className="mt-6 text-sm font-semibold text-text">{t("library.sources.add")}</h3>
          <div className="mt-2 grid gap-2.5">
            <div>
              <span id={`${id}-kind`} className="mb-1.5 block text-xs font-medium text-muted">{t("library.sources.kind")}</span>
              <Select value={kind} onValueChange={(next) => { const found = kinds.find((entry) => entry === next); if (found !== undefined) setKind(found); }}>
                <SelectTrigger className="h-[44px] w-full bg-surface sm:h-8" aria-labelledby={`${id}-kind`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {kinds.map((entry) => <SelectItem key={entry} value={entry}>{kindLabel(entry)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor={`${id}-value`} className="mb-1.5 block text-xs font-medium text-muted">{kind === "registry" ? t("library.sources.registryUrl") : t("library.sources.value")}</label>
              <Input id={`${id}-value`} value={value} onChange={(event) => { setValue(event.target.value); }} spellCheck={false} className="h-[44px] font-mono text-[13.5px] sm:h-8" data-testid="source-value"
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} />
            </div>
            {kind === "registry" ? (
              <div>
                <label htmlFor={`${id}-namespace`} className="mb-1.5 block text-xs font-medium text-muted">{t("library.sources.namespace")}</label>
                <Input id={`${id}-namespace`} value={namespace} onChange={(event) => { setNamespace(event.target.value); }} spellCheck={false} className="h-[44px] font-mono text-[13.5px] sm:h-8" />
                <p className="mt-1.5 text-[12.5px] text-faint">{t("library.sources.namespaceHelp")}</p>
              </div>
            ) : null}
          </div>
          {add.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(add.error)}</p>}
          <div className="mt-3 flex justify-end">
            <Button variant="primary" onClick={submit} disabled={add.isPending || value.trim() === ""} data-action="add-source">{t("library.sources.addButton")}</Button>
          </div>
          <p className="mt-4 text-[12.5px] text-faint">{t("library.sources.matchNote")}</p>
        </div>
      </SheetContent>
    </Sheet>
  );
};
