"use client";

import { useQuery } from "@tanstack/react-query";
import { InfoIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

export type DraftRepo = { readonly installationId: string; readonly fullName: string; readonly defaultBranch: string };

/** A group label of the panel (graphite.css `.props h5`), with its count or note at the right. */
const Label = ({ children, end }: { readonly children: ReactNode; readonly end?: ReactNode }) => (
  <h3 className="mb-2 flex items-baseline gap-2 text-xs font-medium text-faint">
    <span>{children}</span>
    {end === undefined ? null : <span className="ml-auto min-w-0 truncate font-mono">{end}</span>}
  </h3>
);

const Sep = () => <hr className="my-3.5 border-line" />;

/** A key/value row (`.row2`): an 84px key column, 30px tall, 12.5px. */
const KeyValue = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid min-h-[30px] grid-cols-[84px_minmax(0,1fr)] items-center gap-2 text-[12.5px]">
    <span className="text-muted">{label}</span>
    <span className="min-w-0 truncate font-mono text-text">{children}</span>
  </div>
);

/**
 * What ostra will draft for a repo's environment, before the project exists ("Create a project",
 * project-new.md): read from the repo's files by `github.detect`. No agent, no model.
 */
export const EnvironmentDraft = ({ repo }: { readonly repo: DraftRepo | null }) => {
  const trpc = useTRPC();
  const detection = useQuery({
    ...trpc.github.detect.queryOptions({ installationId: repo?.installationId ?? "", fullName: repo?.fullName ?? "", ref: repo?.defaultBranch ?? "" }),
    enabled: repo !== null,
    staleTime: 5 * 60_000,
  });
  if (repo === null) {
    return (
      <div data-testid="environment-draft">
        <Label>{t("projects.draftTitle")}</Label>
        <p className="text-[12.5px] text-faint">{t("projects.draftEmpty")}</p>
      </div>
    );
  }
  const header = <Label end={repo.fullName}>{t("projects.draftTitle")}</Label>;
  if (detection.isPending) {
    return (
      <div data-testid="environment-draft" aria-busy>
        {header}
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid h-[30px] grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
            <Skeleton className="w-16" />
            <Skeleton className="w-32" />
          </div>
        ))}
        <p className="mt-2 text-[12.5px] text-faint">{t("projects.draftReading", { repo: repo.fullName })}</p>
      </div>
    );
  }
  if (detection.error !== null) {
    return (
      <div data-testid="environment-draft">
        {header}
        <p role="alert" className="text-[12.5px] text-red">{errorText(detection.error)}</p>
        <p className="mt-1.5 text-[12.5px] text-faint">{t("projects.draftFailed")}</p>
      </div>
    );
  }
  const draft = detection.data;
  const baseImage = <KeyValue label={t("projects.baseImage")}>{draft.baseImage ?? t("environment.baseImageDefault")}</KeyValue>;
  if (draft.reasons.length === 0) {
    return (
      <div data-testid="environment-draft">
        {header}
        {baseImage}
        <p className="mt-2 text-[12.5px] text-faint">{t("environment.nothingFound")}</p>
      </div>
    );
  }
  const files = [...new Set(draft.reasons.map((reason) => reason.file))];
  return (
    <div data-testid="environment-draft">
      {header}
      {baseImage}
      {draft.tools.length === 0 ? null : (
        <KeyValue label={t("projects.tools")}>{[...new Set(draft.tools.map((tool) => `${tool.tool} ${tool.version}`))].join(" · ")}</KeyValue>
      )}
      <KeyValue label={t("projects.foundIn")}>{plural(files.length, "projects.filesOne", "projects.files")}</KeyValue>
      <ul className="mt-1.5 space-y-0.5 font-mono text-sm text-faint">
        {files.map((file) => (
          <li key={file} title={draft.reasons.filter((reason) => reason.file === file).map((reason) => reason.finding).join("\n")} className="truncate">
            {file}
          </li>
        ))}
      </ul>
      {draft.setupLines.length === 0 ? null : (
        <>
          <Sep />
          <Label>{t("projects.setupScript")}</Label>
          <ol className="overflow-x-auto rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-sm leading-[1.75]">
            {draft.setupLines.map((line, i) => (
              <li key={`${String(i)}-${line}`} className="flex gap-3.5 whitespace-pre">
                <span aria-hidden className="w-3 shrink-0 text-right text-faint">{i + 1}</span>
                <span className="text-text">{line}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {draft.variables.length === 0 ? null : (
        <>
          <Sep />
          <Label end={draft.variables.length}>{t("projects.variables")}</Label>
          <ul>
            {draft.variables.map((variable) => (
              <li key={variable.name} className="flex h-7 items-center gap-2 border-t border-line first:border-t-0">
                <span className="min-w-0 truncate font-mono text-[12.5px] text-text">{variable.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-sm text-faint">
                  {variable.secret ? <LockIcon aria-label={t("projects.secret")} className="size-3 stroke-[1.75]" /> : null}
                  {variable.source}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {draft.services.length === 0 ? null : (
        <>
          <Sep />
          <Label end={draft.services.length}>{t("projects.services")}</Label>
          <ul>
            {draft.services.map((service) => (
              <li key={service.name} title={t("environment.servicesHelp")} className="flex h-7 items-center gap-2.5 border-t border-line first:border-t-0">
                <Dot tone="grey" />
                <span className="min-w-0 truncate font-mono text-[12.5px] text-text">{service.image ?? service.name}</span>
                <span className="ml-auto shrink-0 font-mono text-sm text-faint">{t("environment.notOnHost")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Sep />
      <p className={cn("flex items-center gap-2 text-sm text-faint")}>
        <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
        {t("projects.draftNote")}
      </p>
    </div>
  );
};
