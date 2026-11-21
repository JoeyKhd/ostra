"use client";

import { BlocksIcon, CheckIcon, CircleArrowUpIcon, CircleXIcon, KeyRoundIcon, LayersIcon, LockIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { KindIcon } from "@/components/library/library-parts";
import { PROFILE_LIMITS, pickabilityOf, pickReason, pinText, selectable, sourceText, sourceTitle } from "@/components/library/library-model";
import type { ItemKind, LibraryItem, Pickability, ProfileCounts, ProfileForPicker, ProfileLibrary } from "@/components/library/library-model";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { RemoveButton } from "./rules-section";

// A profile's library items in its editor (F-145; app-targets/m8/agent-profile-library.md): under a
// section's own rows, the items attached from the library (pinned there, detached here) and those on
// every profile (set in the library, never removed here), each group labelled by where it's
// changed. One picker for both kinds attaches from the library; it applies on "Save profile", as
// every other edit of the editor does. A pick past a profile's limit is refused, naming the counts.

type Entry = ProfileLibrary["attached"][number] | ProfileLibrary["inherited"][number];

/** A group's 28px label row: 12px weight 500 `--faint`, a mono count, a note at the right. */
export const GroupLabel = ({ label, count, note }: { readonly label: string; readonly count: number; readonly note?: string }) => (
  <div className="flex h-7 items-center gap-1.5 text-xs font-medium text-faint" data-group-label={label}>
    <span>{label}</span>
    <span className="font-mono font-normal">{count}</span>
    {note === undefined ? null : <span className="ml-auto hidden truncate pl-3 font-normal sm:block">{note}</span>}
  </div>
);

/** A section's count against its limit: `5 of 50`, the number mono `--text`, ` of 50` mono `--faint`. */
export const CountOfLimit = ({ n, limit }: { readonly n: number; readonly limit: number }) => (
  <span className="font-mono text-[12.5px] font-normal" data-count={n}>
    <span className="font-medium text-text">{n}</span>
    <span className="text-faint">{` ${t("agentProfiles.library.of")} ${String(limit)}`}</span>
  </span>
);

type RowState = "saved" | "added" | "removed";

/** One attached or inherited row: icon, name, the source as a link to the item, then its chips and pin. */
const LibraryRow = ({ origin, kind, name, item, entry, state, readOnly, onDetach, onUndo }: {
  readonly origin: "attached" | "every-profile";
  readonly kind: ItemKind;
  readonly name: string;
  readonly item: LibraryItem | undefined;
  readonly entry: Entry | undefined;
  readonly state: RowState;
  readonly readOnly: boolean;
  readonly onDetach: () => void;
  readonly onUndo: () => void;
}) => {
  const pin = pinText(item?.pin ?? entry?.pin ?? null);
  const secrets = item?.server?.inputs.filter((input) => input.secret).length ?? 0;
  const needsSignIn = item?.server?.needsOAuth === true || entry?.leftOut === "needs-oauth";
  return (
    <li
      className={cn("grid min-h-14 grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-line py-1.5 sm:min-h-10 sm:grid-cols-[26px_150px_minmax(0,1fr)_auto_52px] sm:py-0", state === "removed" && "opacity-45")}
      data-library-item={name}
      data-origin={origin}
      data-state={state}
    >
      <KindIcon kind={kind} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[13.5px] text-text">{name}</span>
        <span className="block truncate font-mono text-[12px] text-faint sm:hidden">{pin}</span>
      </span>
      <span className="hidden min-w-0 truncate sm:block">
        {item === undefined ? null : (
          <Link href={`/organization/skills/${item.itemId}`} className="font-mono text-[12.5px] text-teal hover:underline" title={sourceTitle(item.source)}>{sourceText(item)}</Link>
        )}
      </span>
      <span className="hidden items-center justify-end gap-1.5 sm:flex">
        {secrets === 0 ? null : <Chip className="h-5 gap-1 px-1.5 text-xs"><LockIcon aria-hidden />{t("agentProfiles.library.secrets", { n: secrets })}</Chip>}
        {needsSignIn ? <Chip className="h-5 gap-1 px-1.5 text-xs"><KeyRoundIcon aria-hidden />{t("library.row.needsSignIn")}</Chip> : null}
        {item !== undefined && !item.sourceAllowed ? <span className="inline-flex items-center gap-1 text-xs text-faint"><LockIcon aria-hidden className="size-3" />{t("agentProfiles.library.notAllowedChip")}</span> : null}
        {item?.update === null || item?.update === undefined ? null : (
          <Link href={`/organization/skills/${item.itemId}?tab=update`} className="inline-flex h-5 items-center gap-1 rounded-sm border border-line-2 px-1.5 text-xs text-text-2 hover:bg-sel">
            <CircleArrowUpIcon aria-hidden className="size-3 text-teal" />{t("agentProfiles.library.updateWaiting")}
          </Link>
        )}
        {origin === "every-profile" ? (
          item === undefined ? <Chip className="h-5 gap-1 px-1.5 text-xs"><LayersIcon aria-hidden />{t("library.row.everyProfile")}</Chip> : (
            <Link href={`/organization/skills/${item.itemId}?tab=used-by`} className="inline-flex h-5 items-center gap-1 rounded-sm border border-line-2 px-1.5 text-xs text-text-2 hover:bg-sel"><LayersIcon aria-hidden className="size-3" />{t("library.row.everyProfile")}</Link>
          )
        ) : null}
        {state === "added" ? <span className="inline-flex h-5 items-center rounded-sm border border-dashed border-line-2 px-1.5 text-xs text-text-2" data-testid="not-saved-yet">{t("agentProfiles.library.notSavedYet")}</span> : null}
        <span className="font-mono text-[12.5px] text-text">{pin}</span>
      </span>
      <span className="flex justify-end">
        {readOnly || origin === "every-profile" ? null : state === "removed" ? (
          <button type="button" className="text-ui text-teal hover:underline" onClick={onUndo}>{t("agentProfiles.library.undo")}</button>
        ) : (
          <RemoveButton label={t("agentProfiles.library.detach", { name })} onClick={onDetach} />
        )}
      </span>
    </li>
  );
};

export type LibraryGroupsProps = {
  readonly kind: ItemKind;
  /** The saved profile's attached and inherited items. */
  readonly saved: ProfileLibrary;
  /** The draft's attached item IDs, in the order they were attached. */
  readonly draft: readonly string[];
  readonly items: ReadonlyMap<string, LibraryItem>;
  readonly readOnly: boolean;
  readonly onChange: (draft: readonly string[]) => void;
};

/** The section's `From the library` and `On every profile` groups for one kind. */
export const LibraryGroups = ({ kind, saved, draft, items, readOnly, onChange }: LibraryGroupsProps) => {
  const savedIds: readonly string[] = saved.attached.filter((entry) => entry.kind === kind).map((entry) => entry.itemId);
  const added = draft.filter((id) => !savedIds.includes(id) && items.get(id)?.kind === kind);
  const attachedRows: { readonly id: string; readonly state: RowState }[] = [
    ...savedIds.map((id) => ({ id, state: draft.includes(id) ? ("saved" as const) : ("removed" as const) })),
    ...added.map((id) => ({ id, state: "added" as const })),
  ];
  const inherited = saved.inherited.filter((entry) => entry.kind === kind);
  const entryOf = (id: string): Entry | undefined => saved.attached.find((entry) => entry.itemId === id) ?? saved.inherited.find((entry) => entry.itemId === id);
  return (
    <>
      {attachedRows.length === 0 ? null : (
        <div data-group="attached">
          <GroupLabel label={t("agentProfiles.library.fromLibrary")} count={attachedRows.filter((row) => row.state !== "removed").length} note={t("agentProfiles.library.fromLibraryNote")} />
          <ul className="border-b border-line">
            {attachedRows.map((row) => {
              const item = items.get(row.id);
              const entry = entryOf(row.id);
              return (
                <LibraryRow
                  key={row.id}
                  origin="attached"
                  kind={kind}
                  name={item?.name ?? entry?.name ?? ""}
                  item={item}
                  entry={entry}
                  state={row.state}
                  readOnly={readOnly}
                  onDetach={() => { onChange(draft.filter((id) => id !== row.id)); }}
                  onUndo={() => { onChange([...draft, row.id]); }}
                />
              );
            })}
          </ul>
        </div>
      )}
      {inherited.length === 0 ? null : (
        <div data-group="every-profile">
          <GroupLabel label={t("agentProfiles.library.onEveryProfile")} count={inherited.length} note={t("agentProfiles.library.onEveryProfileNote")} />
          <ul className="border-b border-line">
            {inherited.map((entry) => (
              <LibraryRow key={entry.itemId} origin="every-profile" kind={kind} name={entry.name} item={items.get(entry.itemId)} entry={entry} state="saved" readOnly onDetach={() => undefined} onUndo={() => undefined} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
};

/** The refusal at a limit, `role="alert"`, under the section's buttons. */
export const LimitRefusal = ({ text }: { readonly text: string }) => (
  <div role="alert" className="mt-3 flex gap-2.5 border-l-2 border-red py-1 pl-3 text-sm text-text-2" data-testid="limit-refusal">
    <CircleXIcon aria-hidden className="mt-[2px] size-[15px] shrink-0 text-red" />
    <span>{text}</span>
  </div>
);

const stateWords = (pickability: Pickability): ReactNode => {
  switch (pickability.kind) {
    case "attached":
      return <span className="inline-flex items-center gap-1"><CheckIcon aria-hidden className="size-[13px] text-green" />{t("agentProfiles.library.attached")}</span>;
    case "every-profile":
      return <span className="inline-flex items-center gap-1"><LayersIcon aria-hidden className="size-[13px]" />{t("agentProfiles.library.onEveryProfileState")}</span>;
    case "needs-sign-in":
      return <span className="inline-flex items-center gap-1"><KeyRoundIcon aria-hidden className="size-[13px]" />{t("library.row.needsSignIn")}</span>;
    case "source-not-allowed":
      return <span className="inline-flex items-center gap-1"><LockIcon aria-hidden className="size-[13px]" />{t("agentProfiles.library.notAllowedChip")}</span>;
    case "attachable":
    case "name-taken":
    case "at-limit":
      return null;
    default:
      return pickability satisfies never;
  }
};

export type AttachPickerProps = {
  /** The section it opens from: its kind's group comes first. */
  readonly first: ItemKind;
  readonly items: readonly LibraryItem[];
  readonly profileName: string;
  readonly profile: ProfileForPicker;
  readonly admin: boolean;
  /** Attaches an attachable item, detaches an attached one; a pick past a limit is refused instead. */
  readonly onPick: (item: LibraryItem, pickability: Pickability) => void;
};

/** `From the library`: a popover with a search over the library's skills and servers (agent-profile-library.md, "The attach picker"). */
export const AttachPicker = ({ first, items, profileName, profile, admin, onPick }: AttachPickerProps) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const kinds: readonly ItemKind[] = first === "skill" ? ["skill", "mcp_server"] : ["mcp_server", "skill"];
    return kinds.map((kind) => ({
      kind,
      items: items
        .filter((item) => item.kind === kind && (needle === "" || item.name.toLowerCase().includes(needle) || sourceText(item).toLowerCase().includes(needle)))
        .map((item) => ({ item, pickability: pickabilityOf(item, profile) })),
    }));
  }, [first, items, needle, profile]);
  const flat = groups.flatMap((group) => group.items).filter((entry) => selectable(entry.pickability));
  const activeId = active ?? flat[0]?.item.itemId ?? null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = flat.findIndex((entry) => entry.item.itemId === activeId);
      const next = flat[event.key === "ArrowDown" ? Math.min(flat.length - 1, at + 1) : Math.max(0, at - 1)];
      if (next !== undefined) {
        setActive(next.item.itemId);
        list.current?.querySelector(`[data-pick="${next.item.itemId}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = flat.find((entry) => entry.item.itemId === activeId);
      if (chosen !== undefined) pick(chosen.item, chosen.pickability);
    }
  };
  const pick = (item: LibraryItem, pickability: Pickability): void => {
    onPick(item, pickability);
    if (pickability.kind === "at-limit") setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setQuery(""); setActive(null); }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("-ml-1.5 [&_svg]:size-[13px]", open && "bg-sel text-text")} aria-expanded={open} data-action={`attach-${first}`}>
          <BlocksIcon aria-hidden /> {t("agentProfiles.library.fromLibraryButton")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(460px,var(--radix-popover-content-available-height))] w-[min(470px,calc(100vw-24px))] overflow-hidden p-0" onKeyDown={onKeyDown} data-testid="attach-picker">
        <div className="flex h-10 items-center gap-2 border-b border-control-line px-3">
          <SearchIcon aria-hidden className="size-[15px] text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(null); }}
            placeholder={t("agentProfiles.library.find")}
            aria-label={t("agentProfiles.library.find")}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeId === null ? undefined : `${id}-${activeId}`}
            role="combobox"
            aria-expanded
            className="h-full min-w-0 flex-1 bg-transparent text-ui text-text placeholder:text-faint"
          />
        </div>
        <div ref={list} id={`${id}-list`} role="listbox" aria-label={t("agentProfiles.library.fromLibraryButton")} className="max-h-[320px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <p className="px-3 py-3 text-ui text-muted">
              {t("agentProfiles.library.emptyLibrary")}{" "}
              {admin ? <Link href="/organization/skills?add=skill" className="text-teal hover:underline">{t("agentProfiles.library.addOne")}</Link> : null}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} role="group" aria-label={group.kind === "skill" ? t("agentProfiles.library.skillsGroup") : t("agentProfiles.library.serversGroup")}>
                <div className="flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-faint">
                  {group.kind === "skill" ? t("agentProfiles.library.skillsGroup") : t("agentProfiles.library.serversGroup")}
                  <span className="font-mono font-normal">{group.items.length}</span>
                </div>
                {group.items.map(({ item, pickability }) => {
                  const enabled = selectable(pickability);
                  const reason = pickReason(pickability, profileName, item.name, item.kind);
                  return (
                    <div
                      key={item.itemId}
                      id={`${id}-${item.itemId}`}
                      role="option"
                      aria-selected={item.itemId === activeId}
                      aria-disabled={!enabled}
                      data-pick={item.itemId}
                      data-pick-name={item.name}
                      data-pickability={pickability.kind}
                      onMouseEnter={() => { if (enabled) setActive(item.itemId); }}
                      onClick={() => { if (enabled) pick(item, pickability); }}
                      className={cn("grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-[6px] px-2 py-1.5", item.itemId === activeId && enabled && "bg-sel", !enabled && "cursor-default")}
                    >
                      <KindIcon kind={item.kind} className="mt-[3px]" />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                          <span className={cn("shrink-0 whitespace-nowrap font-mono text-[13.5px] font-medium", enabled ? "text-text" : "text-faint")}>{item.name}</span>
                          <span className="truncate font-mono text-[12px] text-faint">{`${pinText(item.pin)} · ${sourceText(item)}`}</span>
                        </span>
                        {reason === null ? null : <span className="block text-[12.5px] text-faint">{reason}</span>}
                      </span>
                      <span className="pt-0.5 text-[12.5px] text-faint">{stateWords(pickability)}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-[9px] text-[12.5px] text-faint">
          <span>
            <span className="font-mono text-text">{profile.counts.skills.total}</span>{` ${t("agentProfiles.library.of")} `}<span className="font-mono">{PROFILE_LIMITS.skills}</span>{` ${t("agentProfiles.library.skillsWord")} · `}
            <span className="font-mono text-text">{profile.counts.servers.total}</span>{` ${t("agentProfiles.library.of")} `}<span className="font-mono">{PROFILE_LIMITS.servers}</span>{` ${t("agentProfiles.library.serversWord")}`}
          </span>
          <Link href="/organization/skills" className="ml-auto text-teal hover:underline">{t("agentProfiles.library.openLibrary")}</Link>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** The properties panel's `Skills and MCP` group: each kind against its limit, by origin. */
export const LibraryCountsGroup = ({ counts }: { readonly counts: ProfileCounts }) => (
  <div className="mb-3.5 border-b border-line pb-3.5" data-testid="profile-library-counts">
    <h3 className="mb-2 text-xs font-medium text-faint">{t("agentProfiles.library.panelTitle")}</h3>
    {(["skills", "servers"] as const).map((kind) => {
      const of = counts[kind];
      const limit = kind === "skills" ? PROFILE_LIMITS.skills : PROFILE_LIMITS.servers;
      return (
        <div key={kind} className="grid min-h-[30px] grid-cols-[96px_minmax(0,1fr)] gap-2 py-1 text-ui">
          <span className="text-muted">{kind === "skills" ? t("agentProfiles.editor.skills") : t("agentProfiles.editor.mcp")}</span>
          <span className="min-w-0">
            <span className="text-text"><CountOfLimit n={of.total} limit={limit} />{of.total >= limit ? <span className="text-sm text-muted">{` · ${t("agentProfiles.library.theMost")}`}</span> : null}</span>
            <span className="block text-xs text-faint">{t("agentProfiles.library.byOrigin", { own: of.own, library: of.library, every: of.every })}</span>
          </span>
        </div>
      );
    })}
    <p className="mt-1 text-[12.5px] text-faint">{t("agentProfiles.library.everyCounts")}</p>
  </div>
);
