"use client";

import { ArchiveIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import type { MemberId } from "@ostra/protocol";

import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Status } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { plural, t } from "@/lib/messages";

import { MemberDot, ProjectSquare } from "./agent-profiles-view";
import type { ProfileDraft } from "./editor-draft";
import type { ProfileDetail } from "./profile-types";
import { dayText, kindTasksWord } from "./profile-words";
import { RemoveButton } from "./rules-section";

// The editor's properties panel (agent-profile.md, "Properties panel"): Profile, Plan first, Who
// may use it, Default for, Archive.

export type PanelMember = { readonly memberId: MemberId; readonly name: string; readonly email: string | null };

const Group = ({ title, end, children, labelId }: { readonly title: string; readonly end?: ReactNode; readonly children: ReactNode; readonly labelId?: string }) => (
  <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0">
    <div className="mb-2 flex items-center gap-2">
      <h3 id={labelId} className="text-xs font-medium text-faint">{title}</h3>
      {end === undefined ? null : <div className="ml-auto">{end}</div>}
    </div>
    {children}
  </div>
);

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid min-h-[30px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2 text-ui">
    <span className="truncate text-muted">{label}</span>
    <span className="flex min-w-0 items-center gap-2 text-text">{children}</span>
  </div>
);

const Help = ({ children, tone = "faint" }: { readonly children: ReactNode; readonly tone?: "faint" | "red" }) => (
  <p className={tone === "red" ? "mt-1.5 text-sm text-red" : "mt-1.5 text-sm text-faint"} {...(tone === "red" ? { role: "alert" } : {})}>{children}</p>
);

/** The member picker: a popover with a search box and the organization's members not yet listed. */
const AddMember = ({ members, listed, onAdd }: { readonly members: readonly PanelMember[]; readonly listed: readonly MemberId[]; readonly onAdd: (memberId: MemberId) => void }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const offered = members.filter(
    (member) => !listed.includes(member.memberId) && (needle === "" || member.name.toLowerCase().includes(needle) || (member.email?.toLowerCase().includes(needle) ?? false)),
  );
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setQuery(""); }}>
      <PopoverTrigger className="mt-1.5 inline-flex items-center gap-1.5 text-ui text-teal hover:underline [&_svg]:size-[13px]">
        <PlusIcon aria-hidden /> {t("agentProfiles.props.addMember")}
      </PopoverTrigger>
      <PopoverContent className="w-[260px]">
        <input
          autoFocus
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder={t("agentProfiles.props.findMember")}
          aria-label={t("agentProfiles.props.findMember")}
          className="mb-1 h-8 w-full rounded-md border border-line-2 bg-surface px-2.5 text-ui text-text placeholder:text-faint outline-none focus-visible:border-faint"
        />
        {offered.length === 0 ? (
          <p className="px-2 py-2 text-ui text-faint">{t("agentProfiles.props.noMatch")}</p>
        ) : (
          <ul role="listbox" aria-label={t("agentProfiles.props.addMember")}>
            {offered.map((member) => (
              <li key={member.memberId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => { onAdd(member.memberId); setOpen(false); }}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui hover:bg-sel focus-visible:bg-sel focus-visible:outline-none"
                >
                  <MemberDot name={member.name} size={20} />
                  <span className="truncate">{member.name}</span>
                  {member.email === null ? null : <span className="ml-auto truncate text-sm text-faint">{member.email}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
};

export type EditorPanelProps = {
  readonly detail: ProfileDetail | null;
  readonly loading: boolean;
  readonly draft: ProfileDraft;
  readonly readOnly: boolean;
  readonly builtIn: boolean;
  readonly members: readonly PanelMember[];
  readonly onChange: (draft: ProfileDraft) => void;
  readonly onArchive: (() => void) | null;
};

export const EditorPanel = ({ detail, loading, draft, readOnly, builtIn, members, onChange, onArchive }: EditorPanelProps) => {
  const id = useId();
  const nameOf = (memberId: MemberId): string =>
    members.find((member) => member.memberId === memberId)?.name ??
    (detail?.access.kind === "listed" ? detail.access.members.find((member) => member.memberId === memberId)?.name : undefined) ??
    t("taskPage.someone");
  const archived = detail?.archivedAt !== null && detail?.archivedAt !== undefined;
  const value = (node: ReactNode) => (loading ? <Skeleton className="w-[120px]" /> : node);

  return (
    <div data-testid="profile-editor-panel">
      <Group title={t("agentProfiles.props.profile")}>
        <Row label={t("agentProfiles.props.status")}>
          {value(
            detail === null ? (
              <Status tone="grey">{t("agentProfiles.props.notSaved")}</Status>
            ) : archived ? (
              <Status tone="grey">{t("agentProfiles.props.archived")}</Status>
            ) : (
              <Status tone="green">{t("agentProfiles.props.active")}</Status>
            ),
          )}
        </Row>
        {detail === null && !loading ? null : (
          <>
            <Row label={t("agentProfiles.props.created")}>
              {value(detail === null ? null : (
                <span className="truncate">
                  {detail.createdBy.name === null ? dayText(detail.createdBy.at) : t("agentProfiles.props.createdBy", { date: dayText(detail.createdBy.at), name: detail.createdBy.name })}
                </span>
              ))}
            </Row>
            <Row label={t("agentProfiles.props.usedBy")}>
              {value(detail === null ? null : detail.usedBy === 0 ? (
                <span className="text-faint">{t("agentProfiles.props.noTasks")}</span>
              ) : (
                <span data-testid="used-by">{plural(detail.usedBy, "agentProfiles.props.tasksOne", "agentProfiles.props.tasksMany")}</span>
              ))}
            </Row>
          </>
        )}
      </Group>

      <Group
        title={t("agentProfiles.props.planFirst")}
        labelId={`${id}-plan`}
        end={<Switch aria-labelledby={`${id}-plan`} checked={draft.planFirst} disabled={readOnly} onCheckedChange={(planFirst) => { onChange({ ...draft, planFirst }); }} data-testid="plan-first" />}
      >
        <p className="text-sm text-faint">{t("agentProfiles.props.planFirstHelp")}</p>
      </Group>

      <Group title={t("agentProfiles.props.who")} labelId={`${id}-who`}>
        {builtIn ? (
          <>
            <p className="text-ui text-muted">{t("agentProfiles.props.everyone")}</p>
            <Help>{t("agentProfiles.props.builtInHelp")}</Help>
          </>
        ) : (
          <>
            <RadioGroup
              aria-labelledby={`${id}-who`}
              value={draft.access}
              disabled={readOnly}
              onValueChange={(access) => { onChange({ ...draft, access: access === "listed" ? "listed" : "everyone" }); }}
            >
              {(["everyone", "listed"] as const).map((option) => (
                <label key={option} className="flex h-7 cursor-pointer items-center gap-2.5 text-ui">
                  <RadioGroupItem value={option} />
                  {option === "everyone" ? t("agentProfiles.props.everyone") : t("agentProfiles.props.onlyThese")}
                </label>
              ))}
            </RadioGroup>
            {draft.access === "listed" ? (
              <div className="mt-1.5" data-testid="listed-members">
                {draft.members.map((memberId) => (
                  <div key={memberId} className="flex h-[30px] items-center gap-2.5 text-body" data-member={nameOf(memberId)}>
                    <MemberDot name={nameOf(memberId)} size={20} />
                    <span className="min-w-0 flex-1 truncate">{nameOf(memberId)}</span>
                    {readOnly ? null : (
                      <RemoveButton label={t("agentProfiles.props.removeMember", { name: nameOf(memberId) })}
                        onClick={() => { onChange({ ...draft, members: draft.members.filter((entry) => entry !== memberId) }); }} />
                    )}
                  </div>
                ))}
                {readOnly ? null : <AddMember members={members} listed={draft.members} onAdd={(memberId) => { onChange({ ...draft, members: [...draft.members, memberId] }); }} />}
                {draft.members.length === 0 && !readOnly ? <Help tone="red">{t("agentProfiles.props.nobodyListed")}</Help> : null}
              </div>
            ) : null}
            <Help>{t("agentProfiles.props.whoHelp")}</Help>
          </>
        )}
      </Group>

      {detail === null ? null : (
        <Group title={t("agentProfiles.props.defaultFor")}>
          {detail.defaults.length === 0 ? (
            <p className="text-ui text-faint">{t("agentProfiles.panel.noDefaults")}</p>
          ) : (
            detail.defaults.map((entry) => (
              <div key={`${entry.projectId}-${entry.kind}`} className="flex h-[30px] items-center gap-2.5 text-body">
                <ProjectSquare projectId={entry.projectId} />
                <span className="truncate">{entry.projectName}</span>
                <span className="ml-auto shrink-0 text-ui text-muted">{kindTasksWord(entry.kind)}</span>
              </div>
            ))
          )}
        </Group>
      )}

      {detail === null || builtIn ? null : archived ? (
        <Group title={t("agentProfiles.props.archive")}>
          <p className="text-ui text-muted">
            {t("agentProfiles.props.archivedLine", { date: dayText(detail.archivedBy?.at ?? detail.archivedAt ?? 0), name: detail.archivedBy?.name ?? t("taskPage.someone") })}
          </p>
        </Group>
      ) : onArchive === null ? null : (
        <Group title={t("agentProfiles.props.archive")}>
          <button
            type="button"
            onClick={onArchive}
            className="inline-flex h-7 items-center gap-2 rounded-md px-2 -ml-2 text-ui text-muted hover:bg-sel hover:text-red [&_svg]:size-[14px]"
            data-action="archive-profile"
          >
            <ArchiveIcon aria-hidden /> {t("agentProfiles.props.archiveProfile")}
          </button>
          <Help>
            {detail.defaults.length === 0
              ? t("agentProfiles.props.archiveHelpNone")
              : plural(new Set(detail.defaults.map((entry) => entry.projectId)).size, "agentProfiles.props.archiveHelpOne", "agentProfiles.props.archiveHelpMany")}
          </Help>
        </Group>
      )}
    </div>
  );
};
