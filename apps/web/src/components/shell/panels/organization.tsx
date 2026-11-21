"use client";

import { t } from "@/lib/messages";

import type { PanelMode } from "../context-panel";
import { PanelFrame, PanelTitle } from "../context-panel";
import { NavLink, SectionLabel } from "../nav-link";
import { organizationGroups, visibleGroups } from "../places";
import { ShellIconView } from "../shell-icons";
import { useShellState } from "../shell-state";

/**
 * The organization's panel (app-shell.md, "Organization"): its pages in groups, each row for the
 * roles that saw it in the single sidebar; a group with no row left for the member is hidden.
 */
export const OrganizationPanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const shell = useShellState();
  const groups = visibleGroups(organizationGroups, { admin: shell.me.organization?.role === "admin", instanceAdmin: shell.me.instanceAdmin });
  const row = shell.place.space === "organization" ? shell.place.row : null;
  const title = t("shell.organization");
  return (
    <PanelFrame mode={mode} label={title} title={<PanelTitle>{title}</PanelTitle>}>
      {groups.map((group) => (
        <div key={group.label ?? "first"}>
          {group.label === null ? null : <SectionLabel>{t(group.label)}</SectionLabel>}
          {group.rows.map((entry) => (
            <NavLink key={entry.id} href={entry.href} icon={<ShellIconView name={entry.icon} />} current={row === entry.id} onNavigate={onNavigate}>
              {t(entry.label)}
            </NavLink>
          ))}
        </div>
      ))}
    </PanelFrame>
  );
};
