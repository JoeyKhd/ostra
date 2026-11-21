"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, CopyIcon, LinkIcon, LockIcon, ScrollTextIcon, UsersIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { memberIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { activeLinks, expiryChoices, linkLine, shareLevelOf, shareShortName, shortExpiry } from "./preview-pane-state";
import type { PreviewItem, ShareLevel } from "./preview-pane-state";

// Who can open a preview (milestone 8, F-142; task-preview.md, "The share menu"; `preview-share`):
// the project's members (the default), named people, anyone with a link, or a public link where an
// admin allows them. A change takes effect at once: narrowing the level ends every link and every
// viewer who no longer qualifies (`previews.setLevel`). A link's URL is shown once, when it's made;
// after that the menu lists it with who made it, its first use and `Revoke`.

type Member = { readonly memberId: string; readonly name: string };

const hoursKey = { 1: "task.preview.share.expiry.hour", 24: "task.preview.share.expiry.day", 168: "task.preview.share.expiry.week" } as const;

const hoursWords = (hours: number): string => (hours === 1 ? t(hoursKey[1]) : hours === 24 ? t(hoursKey[24]) : t(hoursKey[168]));

/** One level's row: a 16px radio, its label and what it means; greyed with why when it can't be chosen. */
const LevelRow = ({ value, label, note, chosen, disabled = false, lock = false, children }: {
  readonly value: ShareLevel;
  readonly label: string;
  readonly note: string;
  readonly chosen: boolean;
  readonly disabled?: boolean;
  readonly lock?: boolean;
  readonly children?: ReactNode;
}) => {
  const id = useId();
  return (
    <div className={cn("grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 rounded-md px-2.5 py-[9px]", chosen && "bg-sel")} data-level={value} data-chosen={chosen ? "true" : "false"}>
      <RadioGroupPrimitive.Item
        id={id}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-describedby={`${id}-note`}
        className={cn(
          "mt-0.5 inline-grid size-4 place-items-center rounded-full border-[1.5px] border-control-line data-[state=checked]:border-teal",
          disabled && "border-line-2",
        )}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-teal" />
      </RadioGroupPrimitive.Item>
      <label htmlFor={id} className={cn("flex items-center gap-1.5 text-[14px] font-medium", disabled ? "text-faint" : "text-text")}>
        {label}
        {lock ? <LockIcon aria-hidden className="size-[14px] text-faint" /> : null}
      </label>
      <p id={`${id}-note`} className={cn("col-start-2 text-[13px]", disabled ? "text-faint" : "text-muted")}>{note}</p>
      {children === undefined ? null : <div className="col-start-2 mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
};

export type ShareMenuProps = {
  readonly taskId: TaskId;
  readonly taskKey: string;
  readonly projectName: string;
  readonly organizationName: string;
  readonly item: PreviewItem;
  readonly publicLinks: boolean;
  readonly linkMaxDays: number;
  readonly members: readonly Member[];
  readonly now: number;
  readonly disabled?: boolean;
};

export const PreviewShareMenu = ({ taskId, taskKey, projectName, organizationName, item, publicLinks, linkMaxDays, members, now, disabled = false }: ShareMenuProps) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.previews.list.queryKey({ taskId }) });
  const setLevel = useMutation(trpc.previews.setLevel.mutationOptions({ onSettled: refresh }));
  const createLink = useMutation(trpc.previews.createLink.mutationOptions({ onSettled: refresh }));
  const revokeLink = useMutation(trpc.previews.revokeLink.mutationOptions({ onSettled: refresh }));
  const [hours, setHours] = useState(24);
  const [allowInput, setAllowInput] = useState(false);
  const [made, setMade] = useState<{ readonly linkId: string; readonly url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const sharing = item.sharing;
  const level = shareLevelOf(sharing);
  // The member picked a level whose first link isn't made yet: show it chosen meanwhile.
  const [picked, setPicked] = useState<ShareLevel | null>(null);
  const shown = picked ?? level;
  const links = activeLinks(sharing);
  const nameOf = (memberId: string): string => members.find((member) => member.memberId === memberId)?.name ?? t("taskPage.someone");
  const choices = expiryChoices(linkMaxDays);

  const make = async (kind: "expiring" | "public") => {
    setRefusal(null);
    const answer = await createLink.mutateAsync({ taskId, key: item.key, kind, allowInput, expiresInHours: kind === "public" ? null : hours });
    if (answer.ok) setMade({ linkId: answer.linkId, url: answer.url });
    else setRefusal(answer.reason === "public-links-off" ? t("task.preview.share.publicOff", { organization: organizationName }) : t("task.preview.share.tooLong", { days: linkMaxDays }));
    setPicked(null);
  };

  const choose = (next: string) => {
    setRefusal(null);
    switch (next) {
      case "members":
      case "named":
        setPicked(null);
        setMade(null);
        setLevel.mutate({ taskId, key: item.key, level: next, memberIds: next === "named" ? [...sharing.memberIds] : [] });
        return;
      case "link":
        setPicked("link");
        if (!links.some((link) => link.kind === "expiring")) void make("expiring");
        return;
      case "public":
        if (!publicLinks) return;
        setPicked("public");
        if (!links.some((link) => link.kind === "public")) void make("public");
        return;
      default:
        return;
    }
  };

  const toggleNamed = (memberId: string, on: boolean) => {
    const parsed = memberIdSchema.safeParse(memberId);
    if (!parsed.success) return;
    const next = on ? [...new Set([...sharing.memberIds, parsed.data])] : sharing.memberIds.filter((id) => id !== parsed.data);
    setLevel.mutate({ taskId, key: item.key, level: "named", memberIds: next });
  };

  const failure = refusal ?? errorText(setLevel.error) ?? errorText(createLink.error) ?? errorText(revokeLink.error);
  const shortName = shareShortName(sharing, now);
  const matching = members.filter((member) => filter.trim() === "" || member.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <Popover onOpenChange={(open) => { if (!open) { setMade(null); setPicked(null); setCopied(false); } }}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          size="sm"
          data-testid="preview-share"
          data-level={level}
          aria-label={t("task.preview.share.button", { level: shortName })}
          className="h-[26px] shrink-0 gap-1.5 px-2 data-[state=open]:border-control-line data-[state=open]:bg-sel max-lg:h-11 max-lg:px-3"
        >
          {level === "link" || level === "public" ? <LinkIcon aria-hidden /> : <UsersIcon aria-hidden />}
          <span className="max-sm:hidden">{shortName}</span>
          <ChevronDownIcon aria-hidden className="size-3! text-faint" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(640px,var(--radix-popover-content-available-height))] w-[392px] max-w-[calc(100vw-24px)] p-1.5" data-testid="preview-share-menu">
        <div className="px-2.5 pb-2 pt-2.5">
          <h2 className="text-[14.5px] font-semibold text-text">
            {t("task.preview.share.title", { label: item.label })} <span className="font-mono text-[13.5px] font-normal">:{item.port}</span>
          </h2>
          <p className="mt-0.5 text-[12.5px] text-faint">{t("task.preview.share.note", { key: taskKey })}</p>
        </div>
        <RadioGroupPrimitive.Root value={shown} onValueChange={choose} aria-label={t("task.preview.share.levels")} className="flex flex-col">
          <LevelRow value="members" label={t("task.preview.share.members")} note={t("task.preview.share.membersNote", { project: projectName })} chosen={shown === "members"} />
          <LevelRow value="named" label={t("task.preview.share.named")} note={t("task.preview.share.namedNote", { organization: organizationName })} chosen={shown === "named"}>
            {shown === "named" ? (
              <>
                {sharing.memberIds.length === 0 ? null : (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t("task.preview.share.chosen")}>
                    {sharing.memberIds.map((memberId) => (
                      <li key={memberId} className="inline-flex h-[24px] items-center gap-1 rounded-[5px] border border-line-2 pl-2 pr-0.5 text-[12.5px] text-text">
                        {nameOf(memberId)}
                        <button type="button" aria-label={t("task.preview.share.remove", { name: nameOf(memberId) })} className="grid size-5 place-items-center rounded-sm text-faint hover:bg-hover hover:text-text" onClick={() => { toggleNamed(memberId, false); }}>
                          <XIcon aria-hidden className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  value={filter}
                  onChange={(event) => { setFilter(event.target.value); }}
                  placeholder={t("task.preview.share.find")}
                  aria-label={t("task.preview.share.find")}
                  className="h-[30px] rounded-md border border-control-line bg-surface px-2.5 text-[13px] text-text placeholder:text-faint"
                />
                <ul className="max-h-[150px] overflow-y-auto" aria-label={t("task.preview.share.people", { organization: organizationName })}>
                  {matching.map((member) => {
                    const on = sharing.memberIds.some((id) => id === member.memberId);
                    return (
                      <li key={member.memberId}>
                        <label className="flex h-8 items-center gap-2 rounded-sm px-1 text-[13px] text-text hover:bg-hover">
                          <Checkbox checked={on} onCheckedChange={(checked) => { toggleNamed(member.memberId, checked === true); }} />
                          <span className="truncate">{member.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </LevelRow>
          <LevelRow value="link" label={t("task.preview.share.link")} note={t("task.preview.share.linkNote")} chosen={shown === "link"}>
            {shown === "link" ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="w-[62px] shrink-0 text-[13px] text-faint">{t("task.preview.share.expires")}</span>
                  <Select value={String(hours)} onValueChange={(value) => { setHours(Number(value)); }}>
                    <SelectTrigger className="h-[30px] flex-1" aria-label={t("task.preview.share.expires")} data-testid="preview-link-expiry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {choices.map((choice) => <SelectItem key={choice} value={String(choice)}>{hoursWords(choice)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2.5">
                  <Switch checked={allowInput} onCheckedChange={setAllowInput} data-testid="preview-link-input" />
                  <span className="whitespace-nowrap text-[13.5px] text-text">{t("task.preview.share.allowInput")}</span>
                  <span className="truncate text-[12.5px] text-faint">{allowInput ? t("task.preview.share.inputOn") : t("task.preview.share.inputOff")}</span>
                </label>
                {made === null ? null : (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <input
                        readOnly
                        value={made.url}
                        aria-label={t("task.preview.share.url")}
                        data-testid="preview-link-url"
                        onFocus={(event) => { event.currentTarget.select(); }}
                        className="h-[30px] min-w-0 flex-1 rounded-md border border-control-line bg-surface px-2 font-mono text-[12.5px] text-text"
                      />
                      <Button
                        size="sm"
                        className="h-[30px]"
                        onClick={() => {
                          void navigator.clipboard.writeText(made.url).then(() => { setCopied(true); });
                        }}
                      >
                        <CopyIcon aria-hidden /> {copied ? t("task.preview.share.copied") : t("task.preview.share.copy")}
                      </Button>
                    </div>
                    <p className="text-[12.5px] text-faint">{t("task.preview.share.urlOnce")}</p>
                  </div>
                )}
                <Button size="sm" className="self-start" disabled={createLink.isPending} onClick={() => { void make("expiring"); }} data-action="make-link">
                  <LinkIcon aria-hidden /> {links.some((link) => link.kind === "expiring") ? t("task.preview.share.another") : t("task.preview.share.make")}
                </Button>
              </>
            ) : null}
          </LevelRow>
          <LevelRow
            value="public"
            label={t("task.preview.share.public")}
            note={publicLinks ? t("task.preview.share.publicNote") : t("task.preview.share.publicOff", { organization: organizationName })}
            chosen={shown === "public"}
            disabled={!publicLinks}
            lock={!publicLinks}
          />
        </RadioGroupPrimitive.Root>
        {links.length === 0 ? null : (
          <ul className="mx-2.5 mt-1 flex flex-col gap-1.5 border-t border-line pt-2" aria-label={t("task.preview.share.links")} data-testid="preview-links">
            {links.map((link) => (
              <li key={link.linkId} className="text-[12.5px] text-faint" data-link-id={link.linkId}>
                <span className="text-muted">
                  {link.kind === "public" ? t("task.preview.share.public") : t("task.preview.share.until", { time: link.expiresAt === null ? "" : shortExpiry(link.expiresAt, now) })}
                  {" · "}
                  {link.allowInput ? t("task.preview.share.withInput") : t("task.preview.share.watchOnly")}
                </span>
                <br />
                {linkLine(link, nameOf(link.createdByMemberId))}
                {" · "}
                <Button variant="link" className="text-[12.5px]" disabled={revokeLink.isPending} onClick={() => { revokeLink.mutate({ linkId: link.linkId }); if (made?.linkId === link.linkId) setMade(null); }} data-action="revoke-link">
                  {t("task.preview.share.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {failure === null ? null : <p role="alert" className="mx-2.5 mt-2 text-[12.5px] text-red">{failure}</p>}
        <p className="mt-1.5 flex items-start gap-2 border-t border-line px-2.5 pb-1.5 pt-2.5 text-[12.5px] text-faint">
          <ScrollTextIcon aria-hidden className="mt-0.5 size-[14px] shrink-0" />
          {t("task.preview.share.audit")}
        </p>
      </PopoverContent>
    </Popover>
  );
};

