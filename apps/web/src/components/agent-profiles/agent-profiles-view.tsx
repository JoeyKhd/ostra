"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { initials } from "@/components/shell/user-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { ProfileRow } from "./profile-types";
import { dayText, defaultEntry, defaultsLine, kindTasksWord, lastChangeText, membersWord, modelName, narrowFacts, phoneFacts, profileRules, shortMatchText } from "./profile-words";

/** The 18px initials of a listed member, overlapping the one before by 4px with a `--bg` ring. */
export const MemberDot = ({ name, overlap = false, size = 18 }: { readonly name: string; readonly overlap?: boolean; readonly size?: 18 | 20 }) => (
  <span
    aria-hidden
    className={cn(
      "inline-grid shrink-0 place-items-center rounded-full bg-line-2 font-semibold text-text",
      size === 18 ? "size-[18px] text-[8.5px] tracking-[-0.02em]" : "size-5 text-[9.5px]",
      overlap && "-ml-[3px] ring-[1.5px] ring-bg",
    )}
  >
    {initials(name)}
  </span>
);

/** The 8px colour square of a project. */
export const ProjectSquare = ({ projectId }: { readonly projectId: string }) => (
  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
);

/** Who may use it: `Everyone`, or up to three avatars and `2 members`. */
const WhoCell = ({ access }: { readonly access: ProfileRow["access"] }) =>
  access.kind === "everyone" ? (
    <span className="text-muted">{t("agentProfiles.everyone")}</span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5" title={access.members.map((member) => member.name).join(", ")}>
      <span className="flex shrink-0 items-center">
        {access.members.slice(0, 3).map((member, i) => (
          <MemberDot key={member.memberId} name={member.name} overlap={i > 0} />
        ))}
      </span>
      <span className="truncate text-muted">{membersWord(access.members.length)}</span>
    </span>
  );

/** The Default for column: one line, `+2` for the rest, the whole list in a tooltip. */
const DefaultsCell = ({ profile }: { readonly profile: ProfileRow }) => {
  if (profile.archivedAt !== null) return <span className="text-faint">{t("agentProfiles.archivedOn", { date: dayText(profile.archivedAt) })}</span>;
  if (profile.defaults.length === 0) return <span className="text-faint">{t("agentProfiles.dash")}</span>;
  const { shown, more } = defaultsLine(profile.defaults);
  const line = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-muted">{shown}</span>
      {more > 0 ? <span className="shrink-0 text-faint">{t("agentProfiles.more", { n: more })}</span> : null}
    </span>
  );
  return more > 0 ? (
    <Tooltip content={profile.defaults.map(defaultEntry).join(", ")}>
      <span tabIndex={0} className="min-w-0">{line}</span>
    </Tooltip>
  ) : (
    line
  );
};

const AgentModel = ({ profile }: { readonly profile: ProfileRow }) => (
  <span className="flex min-w-0 items-center gap-1.5">
    <span className="shrink-0 text-muted">{profile.agentName}</span>
    <span aria-hidden className="text-faint">·</span>
    {profile.model === null ? (
      <span className="truncate text-red">{t("agentProfiles.noModel")}</span>
    ) : (
      <span className="truncate text-text">{modelName(profile.model)}</span>
    )}
  </span>
);

/** One profile's row: the whole row selects it; double-click or Enter opens its editor. */
const ProfileTableRow = ({ profile, selected, onSelect, onOpen }: {
  readonly profile: ProfileRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) => {
  const rules = profileRules(profile).length;
  const archived = profile.archivedAt !== null;
  return (
    <tr
      data-profile={profile.name}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn("h-[52px] cursor-pointer border-b border-line hover:bg-hover sm:h-10", selected && "bg-sel hover:bg-sel")}
    >
      <td className="pl-1 pr-3">
        <button
          type="button"
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpen();
            }
          }}
          className="flex w-full min-w-0 items-center gap-2.5 text-left focus-visible:underline"
        >
          <SlidersHorizontalIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
          <span className={cn("truncate", archived ? "text-muted" : "text-text")}>{profile.name}</span>
          {profile.builtIn ? <Chip className="shrink-0">{t("agentProfiles.builtIn")}</Chip> : null}
        </button>
        <span className="hidden truncate pl-[25px] text-sm text-faint sm:block min-[900px]:hidden">{narrowFacts(profile)}</span>
        <span className="block truncate pl-[25px] text-sm text-faint sm:hidden" data-testid="phone-facts">{phoneFacts(profile)}</span>
      </td>
      <td className="hidden pr-3 sm:table-cell"><AgentModel profile={profile} /></td>
      <td className="hidden pr-3 min-[900px]:table-cell">
        {profile.planFirst ? <span className="text-text">{t("agentProfiles.on")}</span> : <span className="text-faint">{t("agentProfiles.dash")}</span>}
      </td>
      <td className="hidden pr-3 min-[900px]:table-cell">
        {rules === 0 ? <span className="text-faint">{t("agentProfiles.none")}</span> : <span className="font-mono text-ui text-text">{rules}</span>}
      </td>
      <td className="hidden pr-3 sm:table-cell"><WhoCell access={profile.access} /></td>
      <td className="hidden pr-1 min-[900px]:table-cell"><DefaultsCell profile={profile} /></td>
    </tr>
  );
};

const ProfilesTable = ({ profiles, selectedId, onSelect, onOpen }: {
  readonly profiles: readonly ProfileRow[];
  readonly selectedId: string | null;
  readonly onSelect: (profile: ProfileRow) => void;
  readonly onOpen: (profile: ProfileRow) => void;
}) => (
  <table className="w-full table-fixed border-collapse text-body">
    <thead>
      <tr className="h-[30px] border-b border-line text-left text-[12.5px] text-faint">
        <th className="pl-1 pr-3 font-medium min-[900px]:w-[188px]">{t("agentProfiles.column.profile")}</th>
        <th className="hidden w-[46%] pr-3 font-medium sm:table-cell min-[900px]:w-[226px]">{t("agentProfiles.column.agentModel")}</th>
        <th className="hidden w-[72px] pr-3 font-medium min-[900px]:table-cell">{t("agentProfiles.column.planFirst")}</th>
        <th className="hidden w-[56px] pr-3 font-medium min-[900px]:table-cell">{t("agentProfiles.column.rules")}</th>
        <th className="hidden w-[150px] pr-3 font-medium sm:table-cell">{t("agentProfiles.column.who")}</th>
        <th className="hidden pr-1 font-medium min-[900px]:table-cell">{t("agentProfiles.column.defaultFor")}</th>
      </tr>
    </thead>
    <tbody>
      {profiles.map((profile) => (
        <ProfileTableRow
          key={profile.id}
          profile={profile}
          selected={profile.id === selectedId}
          onSelect={() => { onSelect(profile); }}
          onOpen={() => { onOpen(profile); }}
        />
      ))}
    </tbody>
  </table>
);

/** A row of the panel's list groups, 6px apart. */
const PanelValue = ({ children }: { readonly children: ReactNode }) => <span className="truncate">{children}</span>;

/** The properties panel for the selected profile (agent-profiles.md, "Properties panel"). */
export const ProfilePanel = ({ profile, admin, now }: { readonly profile: ProfileRow; readonly admin: boolean; readonly now?: number }) => {
  const rules = profileRules(profile);
  const archived = profile.archivedAt !== null;
  return (
    <div data-testid="profile-panel">
      <div className="mb-4">
        <div className="text-xs font-medium text-faint">{t("agentProfiles.panel.eyebrow")}</div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <SlidersHorizontalIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
          <h2 className="truncate text-[15px] font-semibold">{profile.name}</h2>
          {profile.builtIn ? <Chip className="shrink-0">{t("agentProfiles.builtIn")}</Chip> : null}
        </div>
      </div>
      <PropGroup title={t("agentProfiles.panel.setup")}>
        <PropRow label={t("agentProfiles.panel.agent")}><PanelValue>{profile.agentName}</PanelValue></PropRow>
        <PropRow label={t("agentProfiles.panel.model")}>
          {profile.model === null ? <span className="truncate text-red">{t("agentProfiles.noModel")}</span> : <PanelValue>{modelName(profile.model)}</PanelValue>}
        </PropRow>
        <PropRow label={t("agentProfiles.panel.planFirst")}><PanelValue>{profile.planFirst ? t("agentProfiles.on") : t("agentProfiles.off")}</PanelValue></PropRow>
        <PropRow label={t("agentProfiles.panel.skills")}>
          {profile.skills.length === 0 ? <span className="text-faint">{t("agentProfiles.none")}</span> : <span className="truncate font-mono text-ui">{profile.skills.join(", ")}</span>}
        </PropRow>
        <PropRow label={t("agentProfiles.panel.mcpServers")}>
          {profile.mcpServers.length === 0 ? <span className="text-faint">{t("agentProfiles.none")}</span> : <span className="truncate font-mono text-ui">{profile.mcpServers.map((server) => server.name).join(", ")}</span>}
        </PropRow>
        {profile.model === null ? (
          <p className="mt-1 text-sm text-red">
            {t("agentProfiles.panel.noModelLine")}
            {profile.builtIn && admin ? <> <Link href="/organization/models" className="text-teal hover:underline">{t("agentProfiles.panel.pickModel")}</Link></> : null}
          </p>
        ) : null}
      </PropGroup>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-faint">
          {t("agentProfiles.panel.rules")}
          {rules.length === 0 ? null : <span className="font-mono">{rules.length}</span>}
        </h3>
        {rules.length === 0 ? (
          <p className="text-ui text-faint">{t("agentProfiles.panel.noRules")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="panel-rules">
            {rules.map((rule) => (
              <li key={rule.key} className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ui text-text">{rule.name}</span>
                  {rule.preset === null ? null : <Chip className="ml-auto h-5 shrink-0 px-1.5 text-xs">{t("agentProfiles.preset")}</Chip>}
                </div>
                <div className="truncate font-mono text-xs text-faint" title={shortMatchText(rule)}>{shortMatchText(rule)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-2 text-xs font-medium text-faint">{t("agentProfiles.panel.who")}</h3>
        {profile.access.kind === "everyone" ? (
          <p className="text-ui text-muted">{t("agentProfiles.everyone")}</p>
        ) : (
          <>
            <p className="mb-1 text-ui text-muted">{t("agentProfiles.panel.onlyThese")}</p>
            {profile.access.members.map((member) => (
              <div key={member.memberId} className="flex h-[26px] items-center gap-2 text-ui">
                <MemberDot name={member.name} />
                <span className="truncate">{member.name}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-2 text-xs font-medium text-faint">{archived ? t("agentProfiles.archived") : t("agentProfiles.panel.defaultFor")}</h3>
        {archived ? (
          <p className="text-ui text-muted">
            {t("agentProfiles.panel.archivedBy", { date: dayText(profile.archivedAt ?? 0), name: profile.lastEdit?.actorName ?? t("taskPage.someone") })}
          </p>
        ) : profile.defaults.length === 0 ? (
          <p className="text-ui text-faint">{t("agentProfiles.panel.noDefaults")}</p>
        ) : (
          profile.defaults.map((entry) => (
            <div key={`${entry.projectId}-${entry.kind}`} className="flex h-[30px] items-center gap-2.5 text-ui">
              <ProjectSquare projectId={entry.projectId} />
              <span className="truncate text-text">{entry.projectName}</span>
              <span className="ml-auto shrink-0 text-muted">{kindTasksWord(entry.kind)}</span>
            </div>
          ))
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {archived ? null : (
          <Link href={`/organization/agent-profiles/${profile.id}`} className={buttonVariants()} data-action="open-profile">
            {admin ? t("agentProfiles.panel.edit") : t("agentProfiles.panel.view")}
          </Link>
        )}
        <span className="text-sm text-faint">{lastChangeText(profile, now)}</span>
      </div>
    </div>
  );
};

const PanelSkeleton = () => (
  <div aria-busy>
    {[t("agentProfiles.panel.setup"), t("agentProfiles.panel.rules"), t("agentProfiles.panel.who")].map((title) => (
      <PropGroup key={title} title={title}>
        <Skeleton className="mb-2 w-[160px]" />
        <Skeleton className="w-[120px]" />
      </PropGroup>
    ))}
  </div>
);

/** Organization › Agent profiles (F-021; agent-profiles.md): the list, its panel, and the archived toggle. */
export const AgentProfilesView = () => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const me = useQuery(trpc.me.get.queryOptions());
  const admin = me.data?.organization?.role === "admin";
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions({ includeArchived: admin }));
  const [showArchived, setShowArchived] = useState(false);

  const selectedId = params.get("profile");
  const all = profiles.data ?? [];
  const active = all.filter((profile) => profile.archivedAt === null);
  const archived = all.filter((profile) => profile.archivedAt !== null);
  const selected = all.find((profile) => profile.id === selectedId);

  const open = (profile: ProfileRow): void => {
    router.push(`/organization/agent-profiles/${profile.id}`);
  };
  const select = (profile: ProfileRow): void => {
    // At phone width a row opens its profile: there's no panel beside the list (F-075).
    if (window.matchMedia("(max-width: 639px)").matches && profile.archivedAt === null) {
      open(profile);
      return;
    }
    const next = new URLSearchParams(params.toString());
    next.set("profile", profile.id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const properties = profiles.isPending ? (
    <PanelSkeleton />
  ) : selected === undefined ? (
    <p className="text-ui text-faint">{t("agentProfiles.pickHint")}</p>
  ) : (
    <ProfilePanel profile={selected} admin={admin} />
  );

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("agentProfiles.title") }]}
      actions={
        admin ? (
          <Link href="/organization/agent-profiles/new" className={buttonVariants({ variant: "primary" })} aria-label={t("agentProfiles.newProfile")}>
            <PlusIcon aria-hidden /> <span className="hidden sm:inline">{t("agentProfiles.newProfile")}</span>
          </Link>
        ) : undefined
      }
      properties={properties}
    >
      <PageHeading title={t("agentProfiles.title")} lede={t("agentProfiles.lede")} />
      {profiles.error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{errorText(profiles.error)}</p>}
      {profiles.error !== null ? null : (
        <Section title={t("agentProfiles.profiles")} {...(profiles.data === undefined ? {} : { count: active.length })}>
          {profiles.isPending ? (
            <SkeletonRows rows={5} height="h-10" bars={["w-[15px]", "w-[140px]", "w-[200px]", "w-[60px]"]} />
          ) : (
            <ProfilesTable profiles={active} selectedId={selectedId} onSelect={select} onOpen={open} />
          )}
          {profiles.data !== undefined && active.length === 1 && active[0]?.builtIn === true ? (
            <p className="mt-3.5 text-ui text-muted">
              {t("agentProfiles.onlyBuiltIn")}
              {admin ? <> <Link href="/organization/agent-profiles/new" className="text-teal hover:underline">{t("agentProfiles.newProfile")}</Link></> : null}
            </p>
          ) : null}
          {archived.length === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2.5 -ml-1.5 [&_svg]:size-[13px]"
              aria-expanded={showArchived}
              onClick={() => { setShowArchived((value) => !value); }}
            >
              {showArchived ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
              {showArchived
                ? t("agentProfiles.hideArchived")
                : plural(archived.length, "agentProfiles.showArchivedOne", "agentProfiles.showArchivedMany")}
            </Button>
          )}
        </Section>
      )}
      {showArchived && archived.length > 0 ? (
        <Section title={t("agentProfiles.archived")} count={archived.length}>
          <ProfilesTable profiles={archived} selectedId={selectedId} onSelect={select} onOpen={select} />
        </Section>
      ) : null}
    </PageFrame>
  );
};
