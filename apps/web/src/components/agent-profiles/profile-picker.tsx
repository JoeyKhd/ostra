"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import type { AgentProfileId, ProjectId } from "@ostra/protocol";

import { Trigger } from "@/components/tasks/run-on";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// The profile picker at a task's start (F-021, ticket 42), shared by New task and the Inbox's Start
// task: the member's profiles (`agentProfiles.forStart`), the project's default first, each with its
// model, plan first and its rules as small facts under the name.

export type StartProfile = RouterOutputs["agentProfiles"]["forStart"][number];

/** `Claude Opus 5.5 · plan first · 3 rules`: what a profile does, in a few words. */
export const startFacts = (profile: StartProfile): string =>
  [
    profile.modelName ?? t("agentProfiles.picker.noModel"),
    ...(profile.planFirst ? [t("agentProfiles.picker.planFirst")] : []),
    profile.ruleCount === 0 ? t("agentProfiles.picker.noRules") : plural(profile.ruleCount, "agentProfiles.picker.rulesOne", "agentProfiles.picker.rulesMany"),
  ].join(" · ");

/**
 * The start's profile choice: what the member picked while it's still offered, else the project's
 * default (the first option). Switching project resets it to that project's default.
 */
export const useStartProfile = (projectId: ProjectId | undefined) => {
  const trpc = useTRPC();
  const options = useQuery(trpc.agentProfiles.forStart.queryOptions(projectId === undefined ? skipToken : { projectId, kind: "code" }));
  const [picked, setPicked] = useState<{ readonly projectId: ProjectId; readonly profileId: AgentProfileId } | null>(null);
  const offered = options.data ?? [];
  const chosen =
    (picked !== null && picked.projectId === projectId ? offered.find((profile) => profile.profileId === picked.profileId) : undefined) ?? offered[0] ?? null;
  const pick = (profileId: AgentProfileId): void => {
    if (projectId !== undefined) setPicked({ projectId, profileId });
  };
  return { options: options.data, chosen, pick };
};

/** One option's two lines: the name (and `default`), then its facts in `--faint`. */
const OptionText = ({ profile }: { readonly profile: StartProfile }) => (
  <span className="flex min-w-0 flex-1 flex-col">
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-text">{profile.name}</span>
      {profile.isDefault ? <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("agentProfiles.picker.default")}</Chip> : null}
    </span>
    <span className={profile.modelName === null ? "truncate text-sm text-red" : "truncate text-sm text-faint"}>{startFacts(profile)}</span>
  </span>
);

/** The picker: a ghost trigger with the chosen profile's name, opening the member's profiles. */
export const ProfilePicker = ({ options, chosen, onPick, disabled, className }: {
  readonly options: readonly StartProfile[] | undefined;
  readonly chosen: StartProfile | null;
  readonly onPick: (profileId: AgentProfileId) => void;
  readonly disabled: boolean;
  readonly className?: string;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Trigger aria-label={t("agentProfiles.picker.label")} disabled={disabled || options === undefined || options.length === 0} data-testid="agent-profile" {...(className === undefined ? {} : { className })}>
        <SlidersHorizontalIcon aria-hidden />
        {options === undefined ? (
          <Skeleton className="w-[120px]" />
        ) : (
          <span className="truncate" data-testid="agent-profile-name">{chosen?.name ?? t("newTask.noModel")}</span>
        )}
      </Trigger>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-[300px]" aria-label={t("agentProfiles.picker.label")}>
      {(options ?? []).map((profile) => (
        <DropdownMenuItem
          key={profile.profileId}
          onSelect={() => { onPick(profile.profileId); }}
          data-profile={profile.name}
          aria-current={profile.profileId === chosen?.profileId ? true : undefined}
          className="h-auto items-start py-1.5 data-[current]:bg-sel"
          {...(profile.profileId === chosen?.profileId ? { "data-current": "" } : {})}
        >
          <SlidersHorizontalIcon aria-hidden className="mt-[3px]" />
          <OptionText profile={profile} />
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
