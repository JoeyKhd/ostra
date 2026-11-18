"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { projectIdSchema, runnerIdSchema } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea, fieldClass } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

const POOLS = "pools";

/**
 * "New task" (F-097): a prompt and "Run on": the member's own personal runner ("personal, not
 * isolated") or the project's pools (F-014). No ticket is created.
 */
export const NewTaskForm = ({ projectId, compact = false }: { readonly projectId: string; readonly compact?: boolean }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const runners = useQuery(trpc.runners.mine.queryOptions());
  const [prompt, setPrompt] = useState("");
  const [runOn, setRunOn] = useState<string | null>(null);
  const firstOnline = runners.data?.find((runner) => runner.state === "online")?.id;
  const chosen = runOn ?? firstOnline ?? POOLS;

  const create = useMutation(
    trpc.tasks.create.mutationOptions({
      onSuccess: async ({ taskId }) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() }),
        ]);
        router.push(`/tasks/${taskId}`);
      },
    }),
  );

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    create.mutate({
      projectId: projectIdSchema.parse(projectId),
      prompt: prompt.trim(),
      ...(chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) }),
    });
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t("newTask.title")} className="rounded-lg border border-line-2 bg-surface px-3.5 py-3" data-testid="new-task">
      <label htmlFor={`prompt-${projectId}`} className="sr-only">{t("newTask.prompt")}</label>
      <Textarea
        id={`prompt-${projectId}`}
        className={cn("border-0 bg-transparent px-0 focus-visible:border-0", compact ? "min-h-14" : "min-h-28")}
        placeholder={t("newTask.placeholder")}
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Field id={`run-on-${projectId}`} label={t("newTask.runOn")}>
          <select
            id={`run-on-${projectId}`}
            className={cn(fieldClass, "h-8 w-auto max-w-[320px]")}
            value={chosen}
            onChange={(e) => { setRunOn(e.target.value); }}
          >
            {runners.data?.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {t("newTask.personalRunner", { name: runner.name, state: runner.state })}
                {runner.isolated ? "" : ` · ${t("runners.notIsolated")}`}
              </option>
            ))}
            <option value={POOLS}>{t("newTask.pools")}</option>
          </select>
        </Field>
        <Button type="submit" variant="primary" className="mb-3.5 ml-auto" disabled={create.isPending || prompt.trim() === ""}>
          <SendIcon /> {create.isPending ? t("newTask.starting") : t("newTask.start")}
        </Button>
      </div>
      {create.error === null ? null : <p role="alert" className="text-sm text-red">{errorText(create.error)}</p>}
    </form>
  );
};
