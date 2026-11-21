"use client";

import { useQuery } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { PanelMode } from "../context-panel";
import { PanelFrame, PanelTitle } from "../context-panel";
import { AmberCount, NavLink, SectionLabel } from "../nav-link";
import { projectColour } from "../project-colour";
import { useShellState } from "../shell-state";

/**
 * Needs you's panel (app-shell.md, "Needs you"): the whole list with its count, then each project
 * where something waits on the member, with its square and its count, which opens that project.
 */
export const NeedsYouPanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const trpc = useTRPC();
  const shell = useShellState();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const waiting = (projects.data ?? []).filter((project) => project.needsYouCount > 0).sort((a, b) => b.needsYouCount - a.needsYouCount);
  const count = shell.needsYou;
  const title = t("needsYouPage.pageTitle");
  return (
    <PanelFrame mode={mode} label={title} title={<PanelTitle>{title}</PanelTitle>}>
      <NavLink
        href="/needs-you"
        icon={<BellIcon />}
        onNavigate={onNavigate}
        {...(count === null || count === 0 ? {} : { end: <AmberCount n={count} label={t("shell.needsYouHere", { n: count })} /> })}
      >
        {t("shell.panel.all")}
      </NavLink>
      {waiting.length === 0 ? null : (
        <>
          <SectionLabel>{t("shell.panel.byProject")}</SectionLabel>
          {waiting.map((project) => (
            <NavLink
              key={project.id}
              href={`/projects/${project.id}`}
              current={false}
              icon={<span aria-hidden className="size-[9px] shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />}
              end={<AmberCount n={project.needsYouCount} label={t("shell.needsYouHere", { n: project.needsYouCount })} />}
              onNavigate={onNavigate}
            >
              {project.name}
            </NavLink>
          ))}
        </>
      )}
    </PanelFrame>
  );
};
