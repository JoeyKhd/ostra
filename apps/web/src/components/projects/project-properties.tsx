"use client";

import { BanIcon, BotIcon, BoxIcon, GitBranchIcon, ServerIcon, SquareKanbanIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { repoVerdict } from "./repo-checks-words";

type Project = RouterOutputs["projects"]["get"];

/** "3 Nov 2026". */
const dayOf = (epochMs: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(epochMs);

/** A project's properties panel (project.md): its access, its repo, and where and how its tasks run (F-086). */
export const ProjectProperties = ({ project, boardKeys }: { readonly project: Project; readonly boardKeys?: readonly string[] | undefined }) => (
  <div data-testid="project-properties">
    <PropGroup title={t("projects.title")}>
      <PropRow label={t("projects.access")}>{project.access === "open" ? t("projects.open") : t("projects.restricted")}</PropRow>
      <PropRow label={t("projects.yourRole")}>{project.role === "admin" ? t("projects.admin") : t("projects.member")}</PropRow>
      <PropRow label={t("projects.created")}>
        <span className="font-mono">{dayOf(project.createdAt)}</span>
      </PropRow>
    </PropGroup>
    {project.repos.map((repo) => (
      <PropGroup key={repo.repoId} title={t("projects.repository")}>
        <PropRow label={t("projects.repoKey")}>
          <GitBranchIcon aria-hidden />
          <span className="truncate font-mono">{repo.fullName}</span>
          {repoVerdict(repo) === "unsupported" || repoVerdict(repo) === "warning" ? (
            <Link href={`/projects/${project.id}/repos?repo=${repo.repoId}`} aria-label={t(`repos.verdict.${repoVerdict(repo)}`)} className="shrink-0">
              {repoVerdict(repo) === "unsupported" ? <BanIcon aria-hidden className="size-[13px]! text-red!" /> : <TriangleAlertIcon aria-hidden className="size-[13px]!" />}
            </Link>
          ) : null}
        </PropRow>
        <PropRow label={t("projects.branch")}>
          <span className="truncate font-mono">{repo.defaultBranch}</span>
        </PropRow>
      </PropGroup>
    ))}
    <PropGroup title={t("projects.runs")}>
      <PropRow label={t("shell.environment")}>
        <BoxIcon aria-hidden />
        <Link href={`/projects/${project.id}/environment`} className="text-teal hover:underline">
          {project.environmentStatus === "saved" ? t("projects.envSaved") : t("projects.envDraft")}
        </Link>
      </PropRow>
      <PropRow label={t("projects.boards")}>
        <SquareKanbanIcon aria-hidden />
        {boardKeys === undefined || boardKeys.length === 0 ? (
          "–"
        ) : (
          <Link href={`/projects/${project.id}/boards`} className="truncate font-mono text-teal hover:underline">
            {boardKeys.join(", ")}
          </Link>
        )}
      </PropRow>
      <PropRow label={t("projects.pools")}>
        <ServerIcon aria-hidden />
        <span className="truncate font-mono">{project.pools.map((pool) => pool.name).join(", ") || "–"}</span>
      </PropRow>
      <PropRow label={t("projects.agent")}>
        <BotIcon aria-hidden />
        <span className="truncate">{project.defaultCodeProfile?.name ?? "–"}</span>
      </PropRow>
    </PropGroup>
  </div>
);
