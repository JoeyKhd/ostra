"use client";

import { t } from "@/lib/messages";

import type { PanelMode } from "../context-panel";
import { PanelFrame, PanelTitle } from "../context-panel";
import { NavLink } from "../nav-link";
import { settingsRows } from "../places";
import { ShellIconView } from "../shell-icons";
import { useShellState } from "../shell-state";

/** The Settings space's panel (app-shell.md, "Settings"): the member's own pages, one row each. */
export const SettingsPanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const shell = useShellState();
  const row = shell.place.space === "settings" ? shell.place.row : null;
  const title = t("shell.settings");
  return (
    <PanelFrame mode={mode} label={title} title={<PanelTitle>{title}</PanelTitle>}>
      {settingsRows.map((entry) => (
        <NavLink key={entry.id} href={entry.href} icon={<ShellIconView name={entry.icon} />} current={row === entry.id} onNavigate={onNavigate}>
          {t(entry.label)}
        </NavLink>
      ))}
    </PanelFrame>
  );
};
