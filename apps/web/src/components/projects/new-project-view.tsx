"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CircleAlertIcon, LoaderCircleIcon, LockIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { providerIdSchema } from "@ostra/protocol";

import { installationSettingsUrl } from "@/components/github/github-view";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

import { EnvironmentDraft } from "./environment-draft";
import type { DraftRepo } from "./environment-draft";
import { ProjectKeysField, defaultKeysChoice } from "./project-keys-field";
import type { KeysChoice } from "./project-keys-field";

/** A project's slug from its name: lowercase letters, digits and inner hyphens. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

/** The repos whose full name holds the filter, ignoring case. */
export const filterRepos = <T extends { readonly fullName: string }>(repos: readonly T[], query: string): readonly T[] => {
  const needle = query.trim().toLowerCase();
  return needle === "" ? repos : repos.filter((repo) => repo.fullName.toLowerCase().includes(needle));
};

const GitHubMark = () => (
  <svg aria-hidden viewBox="0 0 16 16" className="size-[15px] fill-current text-text">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/** A section of the form: a 28px title line, then its body (graphite.css `.section`). */
const FormSection = ({ title, note, end, children }: { readonly title: string; readonly note?: ReactNode; readonly end?: ReactNode; readonly children: ReactNode }) => (
  <section className="mt-[26px]">
    <div className="mb-2 flex h-[30px] items-center gap-2">
      <h2 className="text-body font-semibold">{title}</h2>
      {note === undefined ? null : <span className="font-mono text-[12.5px] text-faint">{note}</span>}
      {end === undefined ? null : <div className="ml-auto flex items-center">{end}</div>}
    </div>
    {children}
  </section>
);

const ErrorLine = ({ children }: { readonly children: ReactNode }) => (
  <p role="alert" className="mb-2 flex items-center gap-1.5 text-ui text-red">
    <CircleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
    {children}
  </p>
);

const SkeletonRepoRows = ({ rows }: { readonly rows: number }) => (
  <ul aria-busy className="rows">
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className="flex h-[38px] items-center gap-3 px-3">
        <Skeleton className="size-3.5" />
        <Skeleton className="w-48" />
        <Skeleton className="ml-auto w-10" />
      </li>
    ))}
  </ul>
);

/**
 * Create a project (F-086, project-new.md): a name, its repo from the App's installation, an
 * optional tracker, and, before anything is created, the environment ostra will draft from the
 * repo's files (F-112). Creating lands on that draft.
 */
export const NewProjectView = () => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connection = useQuery(trpc.github.connection.queryOptions());
  const connected = connection.data ?? null;
  // F-136: the repos of every linked installation, across the Apps, grouped by GitHub account; a
  // waiting or removed installation's repos are offered nowhere.
  const groups = useQuery({ ...trpc.github.reposByAccount.queryOptions(), enabled: connected !== null });
  const [name, setName] = useState("");
  // F-098: one repo or several, in the order picked; the first drafts the environment.
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");

  const client = useTRPCClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const organizationAdmin = me.data?.organization?.role === "admin";
  const [keys, setKeys] = useState<KeysChoice>(defaultKeysChoice);
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async ({ projectId }) => {
        // F-135: its own list, when an organization admin picked one; a save sends the version its preview read.
        if (organizationAdmin && keys.own) {
          const mode = { kind: "own" as const, providerIds: [...keys.providerIds].map((id) => providerIdSchema.parse(id)) };
          const preview = await client.projects.previewProviders.query({ projectId, mode });
          await client.projects.setProviders.mutate({ projectId, mode, version: preview.version });
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() }),
        ]);
        router.push(`/projects/${projectId}/environment?created=1`);
      },
    }),
  );

  const crumbs = [{ label: t("shell.projects") }, { label: t("projects.newTitle") }];
  const cancel = (
    <Link href="/" className={buttonVariants({ variant: "outline" })}>
      {t("projects.cancel")}
    </Link>
  );
  const heading = <PageHeading title={t("projects.newTitle")} lede={t("projects.newLede")} />;

  if (connection.isPending) {
    return (
      <PageFrame crumbs={crumbs} actions={cancel}>
        {heading}
        <div className="mt-5 max-w-[680px]">
          <SkeletonRepoRows rows={3} />
        </div>
      </PageFrame>
    );
  }
  if (connected === null) {
    return (
      <PageFrame crumbs={crumbs} actions={cancel}>
        {heading}
        <Section title={t("projects.needsGitHub")}>
          <p className="mb-3 text-muted">{t("projects.needsGitHubBody")}</p>
          <Link href="/organization/github" className={buttonVariants({ variant: "primary" })}>
            {t("checklist.github.action")}
          </Link>
        </Section>
      </PageFrame>
    );
  }

  const slug = slugOf(name);
  const listed = (groups.data ?? []).flatMap((group) => group.repos.map((repo) => ({ ...repo, group, key: `${group.installationId}:${repo.fullName}` })));
  const shownGroups = (groups.data ?? [])
    .map((group) => ({ group, repos: filterRepos(listed.filter((repo) => repo.group === group), query) }))
    .filter((entry) => entry.repos.length > 0);
  const chosenAll = picked.flatMap((key) => listed.filter((repo) => repo.key === key));
  const chosen = chosenAll[0] ?? null;
  const draftRepo: DraftRepo | null = chosen === null ? null : { installationId: chosen.group.installationId, fullName: chosen.fullName, defaultBranch: chosen.defaultBranch };
  const [onlyGroup] = groups.data ?? [];
  const single = groups.data?.length === 1 ? onlyGroup : undefined;
  const busy = create.isPending;

  const pick = (key: string, repoName: string, checked: boolean) => {
    // Milestone 4 (F-098): a project holds several repos; the first picked is first in its order.
    setPicked((current) => (checked ? [...current.filter((one) => one !== key), key] : current.filter((one) => one !== key)));
    if (checked && name.trim() === "") setName(repoName.split("/")[1] ?? "");
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (chosen === null || slug === "") return;
    create.mutate({
      name: name.trim(),
      slug,
      repo: { connectionId: chosen.group.connectionId, installationId: chosen.group.installationId, fullName: chosen.fullName },
      ...(chosenAll.length > 1
        ? { moreRepos: chosenAll.slice(1).map((repo) => ({ connectionId: repo.group.connectionId, installationId: repo.group.installationId, fullName: repo.fullName })) }
        : {}),
    });
  };

  return (
    <PageFrame crumbs={crumbs} actions={cancel} properties={<EnvironmentDraft repo={draftRepo} />} wideProperties>
      {heading}
      <form onSubmit={submit} noValidate className="max-w-[680px]">
        <fieldset disabled={busy} className="contents">
          <div className="mt-5">
            <Label htmlFor="project-name" className="text-sm">{t("projects.name")}</Label>
            <Input id="project-name" className="w-full max-w-[360px]" value={name} onChange={(e) => { setName(e.target.value); }} />
            <p className="mt-1.5 text-sm text-faint">
              {slug === "" ? t("projects.nameHelp") : (
                <>
                  {t("projects.slug", { slug: "" })}
                  <span className="font-mono">{slug}</span>
                </>
              )}
            </p>
          </div>

          <FormSection
            title={t("projects.repos")}
            note={t("projects.reposSelected", { n: chosenAll.length })}
          >
            {groups.error === null ? null : <ErrorLine>{errorText(groups.error)}</ErrorLine>}
            <div className="relative mb-2.5">
              <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
              <Input
                type="search"
                aria-label={t("projects.filterRepos")}
                placeholder={t("projects.filterRepos")}
                className="pl-8 [&::-webkit-search-cancel-button]:appearance-none"
                value={query}
                disabled={groups.isPending || busy}
                onChange={(e) => { setQuery(e.target.value); }}
              />
            </div>
            {groups.isPending ? (
              <SkeletonRepoRows rows={5} />
            ) : listed.length === 0 ? (
              groups.error === null ? <p className="text-sm text-faint">{t("projects.noRepos")}</p> : null
            ) : (
              <>
                <div className="max-h-[360px] overflow-y-auto" data-testid="repo-options" aria-label={t("projects.repo")}>
                  {shownGroups.length === 0 ? (
                    <p className="flex h-[38px] items-center px-3 text-faint">{t("projects.noMatch", { query: query.trim() })}</p>
                  ) : (
                    shownGroups.map(({ group, repos }) => (
                      <div key={`${group.connectionId}:${group.installationId}`}>
                        <div className="flex h-[30px] items-center gap-2 px-3 text-xs font-medium text-faint" data-testid="repo-group">
                          <GitHubMark />
                          <span className="font-mono">{group.accountLogin}</span>
                          {group.accountKind === null ? null : <span>{group.accountKind === "organization" ? t("githubOrgs.repoGroup.organization") : t("githubOrgs.repoGroup.user")}</span>}
                          <a
                            href={installationSettingsUrl({ accountKind: group.accountKind ?? "organization", accountLogin: group.accountLogin, installationId: group.installationId })}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-auto inline-flex items-center gap-1 font-sans text-teal hover:underline"
                          >
                            {t("projects.manageOnGitHub")}
                            <ArrowUpRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                          </a>
                        </div>
                        <ul className="rows">
                          {repos.map((repo) => {
                            const checked = picked.includes(repo.key);
                            const order = picked.indexOf(repo.key);
                            return (
                              <li key={repo.key} data-repo={repo.fullName}>
                                <label className={cn("flex h-[38px] cursor-pointer items-center gap-3 px-3 hover:bg-raise", checked && "bg-sel hover:bg-sel")}>
                                  <Checkbox checked={checked} onCheckedChange={(value) => { pick(repo.key, repo.fullName, value === true); }} />
                                  <span className="min-w-0 truncate font-mono text-ui text-text">{repo.fullName}</span>
                                  {repo.private ? <LockIcon aria-label={t("projects.private")} className="size-3 shrink-0 stroke-[1.75] text-faint" /> : null}
                                  {checked && picked.length > 1 ? <span className="shrink-0 font-mono text-xs text-faint" data-testid="repo-order">{order + 1}</span> : null}
                                  <span className="ml-auto shrink-0 font-mono text-sm text-faint">{repo.defaultBranch}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))
                  )}
                </div>
                {single === undefined ? null : (
                  <p className="mt-2 text-sm text-faint">
                    {plural(single.repos.length, "projects.reposSeenOne", "projects.reposSeen", { account: single.accountLogin })}
                  </p>
                )}
              </>
            )}
          </FormSection>

          {organizationAdmin ? (
            <FormSection title={t("projects.keys")} note={<span className="font-sans">{t("projects.keysNote")}</span>}>
              <ProjectKeysField value={keys} onChange={setKeys} />
            </FormSection>
          ) : null}

          <FormSection title={t("projects.tracker")} note={<span className="font-sans">{t("projects.optional")}</span>}>
            <RadioGroup value="none" aria-label={t("projects.tracker")} className="rows">
              <label className="flex h-[38px] cursor-pointer items-center gap-3 px-3">
                <RadioGroupItem value="none" />
                <span className="text-text">{t("projects.trackerNone")}</span>
                <span className="truncate text-faint">{t("projects.trackerNoneHelp")}</span>
              </label>
              <label className="flex h-[38px] items-center gap-3 px-3">
                <RadioGroupItem value="linear" disabled />
                <span className="text-text">{t("projects.trackerLinear")}</span>
                <span className="truncate text-faint">{t("projects.trackerLinearHelp")}</span>
                <span className="ml-auto shrink-0 text-faint">{t("projects.trackerLater")}</span>
              </label>
            </RadioGroup>
          </FormSection>

          <div className="mt-[26px] pt-1">
            {create.error === null ? null : <ErrorLine>{errorText(create.error)}</ErrorLine>}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <Button type="submit" variant="primary" size="lg" disabled={busy || slug === "" || chosen === null}>
                {busy ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin" /> : null}
                {busy ? t("projects.creating") : t("projects.create")}
              </Button>
              <span className="text-ui text-muted">{t("projects.createHelp")}</span>
            </div>
          </div>
        </fieldset>
      </form>
    </PageFrame>
  );
};
