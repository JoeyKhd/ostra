"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { agentProfileIdSchema } from "@ostra/protocol";
import type { ProjectId, TaskKind } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// The project's default profile per task kind (F-021, ticket 42; `m1/project` grows): a project
// admin picks each from the profiles open to every member, so nobody is handed a default they can't
// use (ticket 34 checks it again); a member reads them.

type DefaultProfiles = RouterOutputs["projects"]["get"]["defaultProfiles"];
type ListedProfile = RouterOutputs["agentProfiles"]["list"][number];

export const KINDS: readonly TaskKind[] = ["refine", "code", "review"];

const kindLabel = {
  refine: "agentProfiles.projectDefaults.refine",
  code: "agentProfiles.projectDefaults.code",
  review: "agentProfiles.projectDefaults.review",
} as const;

type DefaultCandidate = Pick<ListedProfile, "id" | "archivedAt"> & {
  readonly access: { readonly kind: "everyone" | "listed" };
  readonly provider?: { readonly providerId: string } | null;
};

/**
 * The profiles a default may be: active ones open to everyone, plus the one already set. With the
 * project's allowed providers (`allowed`), a profile on a provider the project's list doesn't allow
 * isn't offered (F-135, ADR 0065 amended 2026-11-20); the API refuses it too.
 */
export const defaultChoices = <T extends DefaultCandidate,>(profiles: readonly T[], current: string | null, allowed: ReadonlySet<string> | null = null): readonly T[] =>
  profiles.filter(
    (profile) =>
      profile.archivedAt === null &&
      (profile.id === current ||
        (profile.access.kind === "everyone" &&
          (allowed === null || profile.provider === null || profile.provider === undefined || allowed.has(profile.provider.providerId)))),
  );

export const ProjectDefaults = ({ projectId, defaults, admin }: { readonly projectId: ProjectId; readonly defaults: DefaultProfiles; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions({ includeArchived: false }, { enabled: admin }));
  // F-135: the providers this project's list allows, which decide the profiles it can run.
  const keys = useQuery(trpc.projects.providers.queryOptions({ projectId }, { enabled: admin }));
  const allowed = keys.data === undefined ? null : new Set<string>(keys.data.providers.map((provider) => provider.providerId));
  const [saved, setSaved] = useState<TaskKind | null>(null);
  const set = useMutation(
    trpc.projects.setDefaultProfile.mutationOptions({
      onSuccess: async (_result, input) => {
        setSaved(input.kind);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.agentProfiles.pathKey() }),
        ]);
      },
    }),
  );

  return (
    <PropGroup title={t("agentProfiles.projectDefaults.title")}>
      <div data-testid="project-defaults">
        {KINDS.map((kind) => {
          const current = defaults[kind];
          const choices = defaultChoices(profiles.data ?? [], current?.id ?? null, allowed);
          return (
            <PropRow key={kind} label={t(kindLabel[kind])}>
              {admin && profiles.data !== undefined ? (
                <Select
                  value={current?.id ?? ""}
                  disabled={set.isPending}
                  onValueChange={(value) => {
                    const profileId = agentProfileIdSchema.safeParse(value);
                    if (profileId.success) {
                      setSaved(null);
                      set.mutate({ projectId, kind, profileId: profileId.data });
                    }
                  }}
                >
                  <SelectTrigger className="h-7 w-full border-transparent px-1.5 text-ui hover:border-line-2" aria-label={t(kindLabel[kind])} data-kind={kind}>
                    <SelectValue placeholder="–" />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id} data-profile={profile.name}>{profile.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="truncate" data-kind={kind}>{current?.name ?? "–"}</span>
              )}
            </PropRow>
          );
        })}
        {set.error === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{errorText(set.error)}</p>}
        {saved === null || set.error !== null ? null : <p role="status" className="mt-1.5 text-sm text-green">{t("agentProfiles.projectDefaults.saved")}</p>}
        {admin ? <p className="mt-1.5 text-sm text-faint">{t("agentProfiles.projectDefaults.help")}</p> : null}
      </div>
    </PropGroup>
  );
};
