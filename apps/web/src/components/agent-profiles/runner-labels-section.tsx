"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isReservedLabel, reservedLabelPrefixes, runnerLabelSchema } from "@ostra/protocol";
import type { AgentProfileId } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { EditorSection } from "./editor-section";

/** Why a label can't be added, said under the field, or `null` when it can (F-069, ticket 32). */
export const labelRefusal = (label: string, listed: readonly string[]): string | null => {
  const prefix = reservedLabelPrefixes.find((reserved) => label.startsWith(reserved));
  if (prefix !== undefined && isReservedLabel(label)) return t("runnerLabels.reserved", { prefix });
  if (!runnerLabelSchema.safeParse(label).success) return t("runnerLabels.invalid");
  if (listed.includes(label)) return t("runnerLabels.duplicate", { label });
  return null;
};

/**
 * The profile's "Runner labels" (F-069, app-targets/m3/agent-profile grown in milestone 5): only a
 * runner with every label takes the profile's tasks. Each add and remove applies at once through
 * `agentProfiles.setRunnerLabels`, apart from the editor's Save. Reserved prefixes (`executor:`,
 * `os:`, `arch:`) are refused inline, as the API refuses them.
 */
export const RunnerLabelsSection = ({ profileId, labels, readOnly }: { readonly profileId: AgentProfileId | null; readonly labels: readonly string[]; readonly readOnly: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation(
    trpc.agentProfiles.setRunnerLabels.mutationOptions({
      onSuccess: async (result) => {
        setSaved(result.runnerLabels.length === 0 ? t("runnerLabels.savedNone") : t("runnerLabels.saved", { labels: result.runnerLabels.join(", ") }));
        if (profileId !== null) await queryClient.invalidateQueries({ queryKey: trpc.agentProfiles.get.queryKey({ profileId }) });
      },
    }),
  );
  const shown = save.isPending ? save.variables.labels : labels;

  const add = () => {
    const label = text.trim();
    if (label === "" || profileId === null) return;
    const why = labelRefusal(label, shown);
    setRefusal(why);
    setSaved(null);
    if (why !== null) return;
    save.mutate({ profileId, labels: [...shown, label] }, { onSuccess: () => { setText(""); } });
  };

  return (
    <EditorSection title={t("runnerLabels.title")} count={shown.length} note={t("runnerLabels.note")}>
      {profileId === null ? (
        <p className="text-ui text-faint">{t("runnerLabels.saveFirst")}</p>
      ) : (
        <>
          {shown.length === 0 ? (
            <p className="text-ui text-faint">{t("runnerLabels.none")}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" aria-label={t("runnerLabels.title")}>
              {shown.map((label) => (
                <li key={label} className="inline-flex h-7 items-center gap-1 rounded-md border border-line-2 pl-2 pr-1 font-mono text-[12.5px] text-text" data-testid="runner-label">
                  {label}
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={t("runnerLabels.remove", { label })}
                      disabled={save.isPending}
                      onClick={() => { setSaved(null); save.mutate({ profileId, labels: shown.filter((item) => item !== label) }); }}
                      className="grid size-5 place-items-center rounded-sm text-faint hover:bg-raise hover:text-text"
                    >
                      <XIcon aria-hidden className="size-3 stroke-[1.75]" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {readOnly ? null : (
            <form
              className="mt-2.5 flex flex-wrap items-center gap-2"
              onSubmit={(event) => { event.preventDefault(); add(); }}
            >
              <input
                aria-label={t("runnerLabels.addLabel")}
                value={text}
                placeholder={t("runnerLabels.placeholder")}
                aria-invalid={refusal !== null}
                aria-describedby={refusal === null ? undefined : "runner-label-refusal"}
                onChange={(event) => { setText(event.target.value); setRefusal(null); }}
                className={cn("h-[30px] w-[220px] rounded-md border border-line-2 bg-surface px-2.5 font-mono text-ui text-text placeholder:text-faint focus-visible:border-faint focus-visible:outline-none", refusal !== null && "border-red")}
              />
              <Button type="submit" variant="outline" size="sm" className="h-[30px]" disabled={text.trim() === "" || save.isPending}>{t("runnerLabels.add")}</Button>
            </form>
          )}
          {refusal === null ? null : <p id="runner-label-refusal" role="alert" className="mt-1.5 text-xs text-red">{refusal}</p>}
          {save.error === null ? null : <p role="alert" className="mt-1.5 text-xs text-red">{errorText(save.error)}</p>}
          {saved === null ? null : (
            <p role="status" className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><CheckIcon aria-hidden className="size-3 stroke-[1.75]" />{saved}</p>
          )}
        </>
      )}
    </EditorSection>
  );
};
