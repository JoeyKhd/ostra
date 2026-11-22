"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LaptopIcon, ServerIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { runnerIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { ComposerRepoNotes, repoBlockId } from "@/components/projects/repo-check-line";
import { unsupportedRepos } from "@/components/projects/repo-checks-words";
import type { RepoDetail } from "@/components/projects/repo-checks-words";
import { runnerStateText } from "@/components/runners/runner-words";
import { AttachButton } from "@/components/tasks/composer/attach-button";
import { limitsText, trayNoteOf } from "@/components/tasks/composer/attach-words";
import { SendFace } from "@/components/tasks/composer/composer-box";
import { ComposerTray, TrayNoteLine } from "@/components/tasks/composer/composer-tray";
import { DropZone } from "@/components/tasks/composer/drop-zone";
import { useBoxFiles } from "@/components/tasks/composer/use-box-files";
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
 * Milestone 9 (ticket 15): files by the paperclip, paste and a drop on the box, in a tray under the
 * words; Start waits for uploads in flight, and a task still needs words.
 */
export const ProjectComposer = ({ projectId, repos }: { readonly projectId: ProjectId; readonly repos: readonly RepoDetail[] }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const runners = useQuery(trpc.runners.mine.queryOptions());
  // What the project's default profile's model and agent take (the model's note).
  const choices = useQuery(trpc.tasks.runnerChoices.queryOptions({ projectId }));
  const files = useBoxFiles(projectId);
  const { attachments } = files;
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

  const sendState = attachments.sendState(prompt);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (create.isPending || blocked || sendState.kind === "empty" || sendState.kind === "blocked") return;
    const text = prompt.trim();
    const runnerId = chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) };
    attachments.press((fileIds) => {
      create.mutate({ projectId, prompt: text, ...runnerId, ...(fileIds.length === 0 ? {} : { fileIds: [...fileIds] }) });
    });
  };
  const note = trayNoteOf({
    refusal: attachments.refusal,
    entries: attachments.items,
    model: choices.data?.model ?? null,
    agentWithoutImages: choices.data === undefined || choices.data.agentTakesImages ? null : t("task.agent"),
    oldRunner: null,
  });

  const promptId = `prompt-${projectId}`;
  const runOnId = `run-on-${projectId}`;
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t("newTask.title")}
      className="focus-box relative rounded-lg border border-control-line bg-surface px-3.5 pb-3 pt-3"
      data-testid="new-task"
    >
      {files.dropping && files.limits !== null ? <DropZone variant="box" limits={limitsText(files.limits)} className="rounded-lg" /> : null}
      <label htmlFor={promptId} className="sr-only">{t("newTask.prompt")}</label>
      <textarea
        id={promptId}
        rows={2}
        className="block max-h-80 min-h-[42px] w-full resize-none bg-transparent text-body leading-normal text-text outline-none [field-sizing:content] placeholder:text-faint focus-visible:outline-none"
        placeholder={t("newTask.placeholder")}
        value={prompt}
        readOnly={attachments.waiting}
        onPaste={files.onPaste}
        onChange={(e) => { setPrompt(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <ComposerTray
        items={attachments.items}
        announcement={attachments.announcement}
        onRemove={attachments.remove}
        onRetry={attachments.retry}
        onOpen={null}
        returnFocus={() => { document.getElementById(promptId)?.focus(); }}
        className="mt-3 max-md:mr-0"
      />
      <TrayNoteLine note={note} onDismiss={attachments.dismiss} className="mt-2.5" />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <AttachButton onFiles={attachments.add} full={attachments.full} max={files.limits?.maxFiles ?? 0} disabled={!files.canAttach || attachments.waiting} layout="new-task" className="-mr-1" />
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
            disabled={create.isPending || blocked || sendState.kind === "empty" || sendState.kind === "blocked"}
            {...(blocked ? { "aria-describedby": repoBlockId(projectId) } : {})}
          >
            <SendFace state={sendState} label={create.isPending ? t("newTask.starting") : t("newTask.start")} />
          </Button>
        </span>
      </div>
      <ComposerRepoNotes projectId={projectId} repos={repos} />
      {create.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(create.error)}</p>}
    </form>
  );
};
