"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, fieldClass } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

/** A project's slug from its name: lowercase letters, digits and inner hyphens. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

/**
 * Create a project (F-086): a name and one repo from the App's installation. ostra drafts its
 * environment from the repo's files (F-112), and the admin lands on that draft.
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
  const chosenInstallation = installationId ?? installations.data?.[0]?.installationId ?? null;
  const repos = useQuery({
    ...trpc.github.repos.queryOptions({ installationId: chosenInstallation ?? "" }),
    enabled: chosenInstallation !== null,
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

  if (connection.isPending) return <PageFrame crumbs={[{ label: t("projects.newTitle") }]}>{null}</PageFrame>;

  const slug = slugOf(name);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (connected === null || chosenInstallation === null || fullName === null) return;
    create.mutate({
      name: name.trim(),
      slug,
      repo: { connectionId: connected.connectionId, installationId: chosenInstallation, fullName },
    });
  };

  return (
    <PageFrame crumbs={[{ label: t("shell.projects") }, { label: t("projects.newTitle") }]}>
      <PageHeading title={t("projects.newTitle")} lede={t("projects.newLede")} />
      {connected === null ? (
        <Section title={t("projects.needsGitHub")}>
          <p className="mb-3 text-muted">{t("projects.needsGitHubBody")}</p>
          <Link href="/organization/github" className={buttonVariants({ variant: "primary" })}>
            {t("checklist.github.action")}
          </Link>
        </Section>
      ) : (
        <form onSubmit={submit} noValidate className="mt-6 max-w-[520px]">
          <Field id="project-name" label={t("projects.name")} help={slug === "" ? t("projects.nameHelp") : t("projects.slug", { slug })}>
            <Input id="project-name" value={name} onChange={(e) => { setName(e.target.value); }} placeholder="test1" />
          </Field>
          <Field id="installation" label={t("projects.installation")}>
            <select
              id="installation"
              className={cn(fieldClass, "h-8")}
              value={chosenInstallation ?? ""}
              onChange={(e) => { setInstallationId(e.target.value); setFullName(null); }}
            >
              {installations.data?.map((installation) => (
                <option key={installation.installationId} value={installation.installationId}>
                  {installation.accountLogin}
                </option>
              ))}
            </select>
          </Field>
          {installations.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(installations.error)}</p>}
          <fieldset className="mb-4">
            <legend className="mb-1.5 text-sm font-medium text-muted">{t("projects.repo")}</legend>
            {repos.error === null ? null : <p role="alert" className="mb-2 text-sm text-red">{errorText(repos.error)}</p>}
            {repos.data?.length === 0 ? <p className="text-sm text-muted">{t("projects.noRepos")}</p> : null}
            <ul className="rows max-h-72 overflow-y-auto" aria-label={t("projects.repo")}>
              {repos.data?.map((repo) => (
                <li key={repo.hostRepoId}>
                  <label className={cn("flex min-h-10 cursor-pointer items-center gap-3 px-1 hover:bg-raise", fullName === repo.fullName && "bg-sel")}>
                    <input
                      type="radio"
                      name="repo"
                      value={repo.fullName}
                      checked={fullName === repo.fullName}
                      onChange={() => {
                        setFullName(repo.fullName);
                        if (name.trim() === "") setName(repo.fullName.split("/")[1] ?? "");
                      }}
                      className="accent-[var(--teal)]"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{repo.fullName}</span>
                    {repo.private ? <LockIcon aria-label={t("projects.private")} className="size-3 text-faint" /> : null}
                    <span className="font-mono text-sm text-faint">{repo.defaultBranch}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {create.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(create.error)}</p>}
          <Button type="submit" variant="primary" disabled={create.isPending || slug === "" || fullName === null}>
            {create.isPending ? t("projects.creating") : t("projects.create")}
          </Button>
          <p className="mt-2 text-sm text-faint">{t("projects.createHelp")}</p>
        </form>
      )}
    </PageFrame>
  );
};
