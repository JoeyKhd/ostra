"use client";

import { BoxIcon, GitBranchIcon, ServerIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

type Project = RouterOutputs["projects"]["get"];

/** A project's properties panel: its repo, environment, pools and default agent profile (F-086). */
export const ProjectProperties = ({ project }: { readonly project: Project }) => (
  <div data-testid="project-properties">
    <PropGroup title={t("projects.title")}>
      <PropRow label={t("projects.access")}>{project.access === "open" ? t("projects.open") : t("projects.restricted")}</PropRow>
      <PropRow label={t("projects.yourRole")}>{project.role === "admin" ? t("projects.admin") : t("projects.member")}</PropRow>
    </PropGroup>
    <PropGroup title={t("projects.repos")}>
      {project.repos.map((repo) => (
        <PropRow key={repo.repoId} label={repo.defaultBranch}>
          <GitBranchIcon />
          <span className="truncate font-mono text-sm">{repo.fullName}</span>
        </PropRow>
      ))}
    </PropGroup>
    <PropGroup title={t("projects.runs")}>
      <PropRow label={t("shell.environment")}>
        <BoxIcon />
        <Link href={`/projects/${project.id}/environment`} className="text-teal hover:underline">
          {project.environmentStatus === "saved" ? t("projects.envSaved") : t("projects.envDraft")}
        </Link>
      </PropRow>
      <PropRow label={t("projects.pools")}>
        <ServerIcon />
        <span className="truncate">{project.pools.map((pool) => pool.name).join(", ") || "–"}</span>
      </PropRow>
      <PropRow label={t("projects.agent")}>
        <SlidersHorizontalIcon />
        <span className="truncate">{project.defaultCodeProfile?.name ?? "–"}</span>
      </PropRow>
    </PropGroup>
  </div>
);
