"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CircleAlertIcon, LoaderCircleIcon, LockIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { installationSettingsUrl } from "@/components/github/github-view";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { EnvironmentDraft } from "./environment-draft";
import type { DraftRepo } from "./environment-draft";

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
    <div className="mb-2 flex h-7 items-center gap-2">
      <h2 className="text-body font-semibold">{title}</h2>
      {note === undefined ? null : <span className="font-mono text-[11.5px] text-faint">{note}</span>}
      {end === undefined ? null : <div className="ml-auto flex items-center">{end}</div>}
    </div>
    {children}
  </section>
);

const ErrorLine = ({ children }: { readonly children: ReactNode }) => (
  <p role="alert" className="mb-2 flex items-center gap-1.5 text-[12.5px] text-red">
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
  const installations = useQuery({ ...trpc.github.installations.queryOptions(), enabled: connected !== null });
  const [name, setName] = useState("");
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const installation = installations.data?.find((item) => item.installationId === installationId) ?? installations.data?.[0] ?? null;
  const repos = useQuery({
    ...trpc.github.repos.queryOptions({ installationId: installation?.installationId ?? "" }),
    enabled: installation !== null,
  });

  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async ({ projectId }) => {
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
  const listed = repos.data ?? [];
  const shown = filterRepos(listed, query);
  const chosen = listed.find((repo) => repo.fullName === fullName) ?? null;
  const draftRepo: DraftRepo | null =
    chosen === null || installation === null ? null : { installationId: installation.installationId, fullName: chosen.fullName, defaultBranch: chosen.defaultBranch };
  const busy = create.isPending;

  const pick = (repoName: string, checked: boolean) => {
    // One repo in milestone 1 (F-086): checking one unchecks the other.
    setFullName(checked ? repoName : null);
    if (checked && name.trim() === "") setName(repoName.split("/")[1] ?? "");
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (installation === null || chosen === null || slug === "") return;
    create.mutate({
      name: name.trim(),
      slug,
      repo: { connectionId: connected.connectionId, installationId: installation.installationId, fullName: chosen.fullName },
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
            note={t("projects.reposSelected", { n: chosen === null ? 0 : 1 })}
            end={
              installation === null ? null : (
                <a href={installationSettingsUrl(installation)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
                  {t("projects.manageOnGitHub")}
                  <ArrowUpRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                </a>
              )
            }
          >
            {installations.error === null ? null : <ErrorLine>{errorText(installations.error)}</ErrorLine>}
            {repos.error === null ? null : <ErrorLine>{errorText(repos.error)}</ErrorLine>}
            <div className="mb-2.5 flex gap-2">
              {(installations.data?.length ?? 0) > 1 ? (
                <Select
                  value={installation?.installationId ?? ""}
                  onValueChange={(value) => { setInstallationId(value); setFullName(null); }}
                >
                  <SelectTrigger aria-label={t("projects.installation")} className="h-8 w-[200px] shrink-0 bg-surface">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {installations.data?.map((item) => (
                      <SelectItem key={item.installationId} value={item.installationId}>
                        <GitHubMark />
                        {item.accountLogin}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : installation === null ? null : (
                <span className="flex h-8 shrink-0 items-center gap-2 px-1 text-muted" aria-label={t("projects.installation")}>
                  <GitHubMark />
                  {installation.accountLogin}
                </span>
              )}
              <div className="relative min-w-0 flex-1">
                <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
                <Input
                  type="search"
                  aria-label={t("projects.filterRepos")}
                  placeholder={t("projects.filterRepos")}
                  className="pl-8 [&::-webkit-search-cancel-button]:appearance-none"
                  value={query}
                  disabled={repos.isPending || busy}
                  onChange={(e) => { setQuery(e.target.value); }}
                />
              </div>
            </div>
            {repos.isPending ? (
              <SkeletonRepoRows rows={5} />
            ) : listed.length === 0 ? (
              repos.error === null ? <p className="text-sm text-faint">{t("projects.noRepos")}</p> : null
            ) : (
              <>
                <ul className="rows max-h-[360px] overflow-y-auto" aria-label={t("projects.repo")}>
                  {shown.length === 0 ? (
                    <li className="flex h-[38px] items-center px-3 text-faint">{t("projects.noMatch", { query: query.trim() })}</li>
                  ) : (
                    shown.map((repo) => {
                      const checked = repo.fullName === fullName;
                      return (
                        <li key={repo.hostRepoId} data-repo={repo.fullName}>
                          <label className={cn("flex h-[38px] cursor-pointer items-center gap-3 px-3 hover:bg-raise", checked && "bg-sel hover:bg-sel")}>
                            <Checkbox checked={checked} onCheckedChange={(value) => { pick(repo.fullName, value === true); }} />
                            <span className="min-w-0 truncate font-mono text-[12.5px] text-text">{repo.fullName}</span>
                            {repo.private ? <LockIcon aria-label={t("projects.private")} className="size-3 shrink-0 stroke-[1.75] text-faint" /> : null}
                            <span className="ml-auto shrink-0 font-mono text-sm text-faint">{repo.defaultBranch}</span>
                          </label>
                        </li>
                      );
                    })
                  )}
                </ul>
                {installation === null ? null : (
                  <p className="mt-2 text-sm text-faint">
                    {plural(listed.length, "projects.reposSeenOne", "projects.reposSeen", { account: installation.accountLogin })}
                  </p>
                )}
              </>
            )}
          </FormSection>

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
              <span className="text-[12.5px] text-muted">{t("projects.createHelp")}</span>
            </div>
          </div>
        </fieldset>
      </form>
    </PageFrame>
  );
};
