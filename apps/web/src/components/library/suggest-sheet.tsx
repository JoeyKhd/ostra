"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenIcon, CheckIcon, ClockIcon, LockIcon, PlugIcon, SendIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorText } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { serverReference, sourceText, suggestionAnswer } from "./library-model";
import type { LibraryItem, MySuggestion } from "./library-model";
import { focusBack, Note } from "./library-parts";

// A member's Suggest sheet (F-145; app-targets/m8/library-suggestions.md, "A member's form"): a
// reference and why the team wants it, sent to the organization's admins, who install it or say
// why not. Under it, the member's own suggestions with each answer (`library.suggestions.mine`).
// Only admins look a reference up at its source, so the member learns whether its source is on
// the allowlist when they send it.

/** The note's longest, as the target counts it (the server takes up to 2,000). */
export const SUGGESTION_NOTE_LIMIT = 1000;

type Kind = "skill" | "mcp";

const AnswerIcon = ({ state }: { readonly state: MySuggestion["state"] }) => {
  switch (state) {
    case "open":
      return <ClockIcon aria-hidden className="mt-[3px] size-[14px] text-faint" />;
    case "installed":
      return <CheckIcon aria-hidden className="mt-[3px] size-[14px] text-green" />;
    case "dismissed":
      return <XIcon aria-hidden className="mt-[3px] size-[14px] text-faint" />;
    default:
      return state satisfies never;
  }
};

export const MySuggestions = ({ suggestions }: { readonly suggestions: readonly MySuggestion[] | undefined }) => {
  const now = Date.now();
  return (
    <section className="mt-[18px]" aria-label={t("library.suggest.yours")} data-testid="my-suggestions">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold text-text">
        {t("library.suggest.yours")}
        <span className="font-mono text-[12px] font-normal text-faint">{suggestions?.length ?? ""}</span>
      </h3>
      {suggestions === undefined ? (
        <div aria-busy className="mt-2 space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
      ) : suggestions.length === 0 ? (
        <p className="mt-2 text-sm text-faint">{t("library.suggest.noneYet")}</p>
      ) : (
        <ul className="mt-1">
          {suggestions.map((suggestion) => (
            <li key={suggestion.suggestionId} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 border-b border-line py-2" data-my-suggestion={suggestion.reference} data-state={suggestion.state}>
              <AnswerIcon state={suggestion.state} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[13.5px] font-medium text-text">{suggestion.reference}</span>
                <span className="block text-[12.5px] text-muted">{suggestionAnswer(suggestion, now)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const SuggestSheet = ({ open, organization, items, onClose, returnFocusTo }: { readonly open: boolean; readonly organization: string; readonly items: readonly LibraryItem[]; readonly onClose: () => void; readonly returnFocusTo?: string }) => {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mine = useQuery(trpc.library.suggestions.mine.queryOptions(undefined, { enabled: open }));
  const [kind, setKind] = useState<Kind>("skill");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<{ readonly reference: string; readonly sourceAllowed: boolean } | null>(null);
  const suggest = useMutation(
    trpc.library.suggest.mutationOptions({
      onSuccess: async (result, input) => {
        setSent({ reference: input.reference, sourceAllowed: result.sourceAllowed });
        setReference("");
        setNote("");
        await queryClient.invalidateQueries({ queryKey: trpc.library.suggestions.mine.queryKey() });
      },
    }),
  );
  const typed = kind === "skill" ? reference.trim() : serverReference(reference, null);
  // What's in the library already, by its source as the table writes it.
  const installed = items.find((item) => sourceText(item) === reference.trim() || (item.source.kind === "registry" && item.source.name === reference.trim()));
  const canSend = reference.trim() !== "" && note.trim() !== "" && note.length <= SUGGESTION_NOTE_LIMIT && installed === undefined && !suggest.isPending;
  const send = (): void => {
    if (canSend) suggest.mutate({ reference: typed, note: note.trim() });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent title={t("library.suggest.title")} className="w-full sm:w-[min(480px,100vw)]" onKeyDown={onKeyDown} onCloseAutoFocus={focusBack(returnFocusTo)}>
        <div className="shrink-0 px-6 pt-5" data-testid="suggest-sheet">
          <h2 className="text-[17px] font-semibold text-text">{t("library.suggest.title")}</h2>
          <p className="mt-0.5 text-[13.5px] text-muted">{t("library.suggest.lede", { organization })}</p>
          <ToggleGroup type="single" value={kind} onValueChange={(value) => { if (value === "skill" || value === "mcp") setKind(value); }} aria-label={t("library.install.kind")} className="mt-3 h-7">
            <ToggleGroupItem value="skill" className="flex items-center gap-1.5 px-2.5 text-sm [&_svg]:size-[14px]"><BookOpenIcon aria-hidden /> {t("library.kind.skill")}</ToggleGroupItem>
            <ToggleGroupItem value="mcp" className="flex items-center gap-1.5 px-2.5 text-sm [&_svg]:size-[14px]"><PlugIcon aria-hidden /> {t("library.kind.server")}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          <label htmlFor={`${id}-source`} className="mb-1.5 mt-3.5 block text-xs font-medium text-muted">{kind === "skill" ? t("library.install.source") : t("library.install.serverName")}</label>
          <Input id={`${id}-source`} autoFocus value={reference} onChange={(event) => { setReference(event.target.value); setSent(null); }} spellCheck={false}
            placeholder={kind === "skill" ? t("library.install.sourcePlaceholder") : t("library.install.serverPlaceholder")} className="h-[44px] font-mono text-[13.5px] sm:h-8" data-testid="suggest-reference" />
          <p className="mt-1.5 text-[12.5px] text-faint">{kind === "skill" ? t("library.install.sourceHelp") : t("library.suggest.serverHelp")}</p>
          {installed === undefined ? null : (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted" data-testid="suggest-in-library">
              <CheckIcon aria-hidden className="size-[13px] text-green" />
              {t("library.suggest.inLibrary", { name: installed.name })}
            </p>
          )}

          <label htmlFor={`${id}-note`} className="mb-1.5 mt-3.5 block text-xs font-medium text-muted">{t("library.suggest.why")}</label>
          <Textarea id={`${id}-note`} value={note} rows={3} onChange={(event) => { setNote(event.target.value); }} className="min-h-[76px] text-[13.5px] leading-[1.55]" aria-describedby={`${id}-note-help`} data-testid="suggest-note" />
          <p id={`${id}-note-help`} className="mt-1.5 flex items-center justify-between gap-3 text-[12px] text-faint">
            <span>{t("library.suggest.whyHelp")}</span>
            <span className="font-mono">{`${formatCount(note.length)} / ${formatCount(SUGGESTION_NOTE_LIMIT)}`}</span>
          </p>
          {suggest.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(suggest.error)}</p>}
          {sent === null ? null : (
            <Note icon={sent.sourceAllowed ? <CheckIcon aria-hidden /> : <LockIcon aria-hidden />} className="mt-3" role="status">
              <span data-testid="suggest-sent">{sent.sourceAllowed ? t("library.suggest.sentAllowed") : t("library.suggest.sentNotAllowed", { organization })}</span>
            </Note>
          )}
          <MySuggestions suggestions={mine.data} />
        </div>
        <div className="shrink-0 border-t border-line px-6 pb-4 pt-3">
          <p className="text-sm text-muted">{t("library.suggest.footer")}</p>
          <div className="mt-2.5 flex gap-2">
            <Button variant="ghost" className="ml-auto h-[44px] flex-1 sm:h-[30px] sm:flex-none" onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" className="h-[44px] flex-1 sm:h-[30px] sm:flex-none" disabled={!canSend} onClick={send} data-action="send-suggestion">
              <SendIcon aria-hidden />
              {suggest.isPending ? t("library.suggest.sending") : t("library.suggest.send")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
