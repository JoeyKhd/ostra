"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LaptopIcon, SendIcon, ServerIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { runnerIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { ComposerRepoNotes, repoBlockId } from "@/components/projects/repo-check-line";
import { unsupportedRepos } from "@/components/projects/repo-checks-words";
import type { RepoDetail } from "@/components/projects/repo-checks-words";
import { runnerStateText } from "@/components/runners/runner-words";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

const POOLS = "pools";

/**
 * The project page's composer (project.md, F-097): a prompt, and on one line under it "Run on"
 * (the member's own personal runners, then the project's pools), `⌘↵` and "Start the task".
 */
export const ProjectComposer = ({ projectId, repos }: { readonly projectId: ProjectId; readonly repos: readonly RepoDetail[] }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const runners = useQuery(trpc.runners.mine.queryOptions());
  const [prompt, setPrompt] = useState("");
  const [runOn, setRunOn] = useState<string | null>(null);
  const firstOnline = runners.data?.find((runner) => runner.state === "online")?.id;
  const chosen = runOn ?? firstOnline ?? POOLS;
  // A repo that requires signed commits stops every task in the project (F-055).
  const blocked = unsupportedRepos(repos).length > 0;

  const create = useMutation(
    trpc.tasks.create.mutationOptions({
      onSuccess: async ({ taskId }) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() }),
        ]);
        router.push(`/tasks/${taskId}`);
      },
    }),
  );

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (prompt.trim() === "" || create.isPending || blocked) return;
    create.mutate({
      projectId,
      prompt: prompt.trim(),
      ...(chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) }),
    });
  };

  const promptId = `prompt-${projectId}`;
  const runOnId = `run-on-${projectId}`;
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t("newTask.title")}
      className="rounded-lg border border-line-2 bg-surface px-3.5 pb-3 pt-3"
      data-testid="new-task"
    >
      <label htmlFor={promptId} className="sr-only">{t("newTask.prompt")}</label>
      <textarea
        id={promptId}
        rows={2}
        className="block max-h-80 min-h-[42px] w-full resize-none bg-transparent text-body leading-normal text-text outline-none [field-sizing:content] placeholder:text-faint focus-visible:outline-none"
        placeholder={t("newTask.placeholder")}
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <span id={runOnId} className="text-sm text-muted">{t("newTask.runOn")}</span>
        <Select value={chosen} onValueChange={setRunOn}>
          <SelectTrigger aria-labelledby={runOnId} className="max-w-full sm:min-w-[356px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {runners.data?.map((runner) => (
              <SelectItem key={runner.id} value={runner.id} disabled={runner.state !== "online"}>
                <LaptopIcon aria-hidden />
                <span className="font-mono text-ui text-text">{runner.name}</span>
                <span className="truncate text-muted">
                  {t("newTask.yours", { state: runnerStateText(runner.state) })}
                  {runner.isolated ? "" : ` · ${t("runners.notIsolated")}`}
                </span>
              </SelectItem>
            ))}
            <SelectItem value={POOLS}>
              <ServerIcon aria-hidden />
              <span>{t("newTask.pools")}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto flex items-center gap-3">
          <Kbd aria-hidden className="text-sm">{t("newTask.kbd")}</Kbd>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || prompt.trim() === "" || blocked}
            {...(blocked ? { "aria-describedby": repoBlockId(projectId) } : {})}
          >
            <SendIcon aria-hidden /> {create.isPending ? t("newTask.starting") : t("newTask.start")}
          </Button>
        </span>
      </div>
      <ComposerRepoNotes projectId={projectId} repos={repos} />
      {create.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(create.error)}</p>}
    </form>
  );
};
