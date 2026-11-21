"use client";

import { useQuery } from "@tanstack/react-query";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { PanelMode } from "../context-panel";
import { PanelFrame, PanelTitle } from "../context-panel";
import { NavLink, RowCount, SectionLabel } from "../nav-link";
import { organizationGroups, visibleGroups } from "../places";
import type { OrganizationRow } from "../places";
import type { MessageKey } from "@/lib/messages";
import { ShellIconView } from "../shell-icons";
import { useShellState } from "../shell-state";

/** How long the panel's counts are trusted before a page change reads them again. */
const COUNTS_STALE_MS = 60_000;

/**
 * The rows' counts (app-shell.md, "Organization"; `shell-peek.webp`): Memory's open proposals, the
 * runners, the agent profiles, the library's items and the members, each from the query its own page
 * reads, fetched only while this panel shows. A count that fails or isn't the member's to read is
 * left out, never shown as 0.
 */
const useRowCounts = (admin: boolean): Partial<Readonly<Record<OrganizationRow, number>>> => {
  const trpc = useTRPC();
  const options = { staleTime: COUNTS_STALE_MS, retry: false } as const;
  const proposals = useQuery({ ...trpc.memory.proposals.queryOptions({ scope: "organization", state: "proposed" }), ...options });
  const runners = useQuery({ ...trpc.runners.list.queryOptions(undefined, { enabled: admin }), ...options });
  const profiles = useQuery({ ...trpc.agentProfiles.list.queryOptions(), ...options });
  const library = useQuery({ ...trpc.library.list.queryOptions(), ...options });
  const members = useQuery({ ...trpc.members.list.queryOptions({ includeRemoved: false }), ...options });
  return {
    ...(proposals.data === undefined || proposals.data.length === 0 ? {} : { memory: proposals.data.length }),
    ...(runners.data === undefined || !admin ? {} : { runners: runners.data.length }),
    ...(profiles.data === undefined ? {} : { "agent-profiles": profiles.data.length }),
    ...(library.data === undefined ? {} : { skills: library.data.length }),
    ...(members.data === undefined ? {} : { members: members.data.filter((member) => member.state === "active").length }),
  };
};

/** How each count is read out: the number alone means nothing to a screen reader. */
const countLabel: Partial<Readonly<Record<OrganizationRow, MessageKey>>> = {
  memory: "shell.proposalsCount",
  runners: "shell.runnersCount",
  "agent-profiles": "shell.profilesCount",
  skills: "shell.libraryCount",
  members: "shell.membersCount",
};

/**
 * The organization's panel (app-shell.md, "Organization"): its pages in groups, each row for the
 * roles that saw it in the single sidebar; a group with no row left for the member is hidden.
 */
export const OrganizationPanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const shell = useShellState();
  const admin = shell.me.organization?.role === "admin";
  const groups = visibleGroups(organizationGroups, { admin, instanceAdmin: shell.me.instanceAdmin });
  const counts = useRowCounts(admin);
  const row = shell.place.space === "organization" ? shell.place.row : null;
  const title = t("shell.organization");
  return (
    <PanelFrame mode={mode} label={title} title={<PanelTitle>{title}</PanelTitle>}>
      {groups.map((group) => (
        <div key={group.label ?? "first"}>
          {group.label === null ? null : <SectionLabel>{t(group.label)}</SectionLabel>}
          {group.rows.map((entry) => {
            const count = counts[entry.id];
            const label = countLabel[entry.id];
            return (
              <NavLink
                key={entry.id}
                href={entry.href}
                icon={<ShellIconView name={entry.icon} />}
                current={row === entry.id}
                onNavigate={onNavigate}
                {...(count === undefined || label === undefined ? {} : { end: <RowCount n={count} label={t(label, { n: count })} /> })}
              >
                {t(entry.label)}
              </NavLink>
            );
          })}
        </div>
      ))}
    </PanelFrame>
  );
};
