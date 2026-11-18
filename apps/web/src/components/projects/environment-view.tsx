"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileIcon, KeyRoundIcon, PlusIcon, TriangleAlertIcon, VariableIcon, XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PageFrame, PageHeading, PropGroup, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Chip } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

type View = RouterOutputs["environments"]["get"];
type Detected = RouterOutputs["environments"]["detect"];
type SaveEntry = RouterInputs["environments"]["save"]["environment"]["entries"][number];
type RepoId = View["repos"][number]["repoId"];

/** One row of the editor. A secret's value is write-only: `hasValue` says one is stored. */
type Row =
  | { readonly key: string; readonly kind: "variable"; readonly repoId: RepoId; readonly name: string; readonly value: string; readonly availableDuringSetup: boolean }
  | { readonly key: string; readonly kind: "secret"; readonly repoId: RepoId; readonly name: string; readonly value: string; readonly hasValue: boolean; readonly availableDuringSetup: boolean }
  | { readonly key: string; readonly kind: "file"; readonly repoId: RepoId; readonly path: string; readonly content: string; readonly availableDuringSetup: boolean };

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `row-${String(counter)}`;
};

const rowsOf = (view: View): Row[] =>
  view.entries.map((entry): Row => {
    switch (entry.kind) {
      case "variable":
        return { key: nextKey(), kind: "variable", repoId: entry.repoId, name: entry.name, value: entry.value, availableDuringSetup: entry.availableDuringSetup };
      case "secret":
        return { key: nextKey(), kind: "secret", repoId: entry.repoId, name: entry.name, value: "", hasValue: entry.hasValue, availableDuringSetup: entry.availableDuringSetup };
      case "file":
        return { key: nextKey(), kind: "file", repoId: entry.repoId, path: entry.path, content: entry.content, availableDuringSetup: entry.availableDuringSetup };
      default:
        return entry satisfies never;
    }
  });

/** The rows a fresh draft starts with: the variables detection found, values empty. */
const rowsFromDetection = (detected: Detected): Row[] =>
  detected.flatMap(({ repoId, detection }) =>
    detection.variables.map((variable): Row =>
      variable.secret
        ? { key: nextKey(), kind: "secret", repoId, name: variable.name, value: "", hasValue: false, availableDuringSetup: false }
        : { key: nextKey(), kind: "variable", repoId, name: variable.name, value: "", availableDuringSetup: false },
    ),
  );

const toEntry = (row: Row): SaveEntry => {
  switch (row.kind) {
    case "variable":
      return { kind: "variable", repoId: row.repoId, name: row.name.trim(), value: row.value, availableDuringSetup: row.availableDuringSetup };
    case "secret":
      // An empty value keeps the stored one; a new value replaces it.
      return {
        kind: "secret",
        repoId: row.repoId,
        name: row.name.trim(),
        availableDuringSetup: row.availableDuringSetup,
        ...(row.value === "" ? {} : { value: row.value }),
      };
    case "file":
      return { kind: "file", repoId: row.repoId, path: row.path.trim(), content: row.content, availableDuringSetup: row.availableDuringSetup };
    default:
      return row satisfies never;
  }
};

const kindIcon = { variable: VariableIcon, secret: KeyRoundIcon, file: FileIcon } as const;

/** The detection's reasons, tools and services: why the draft says what it says (F-112). */
const Reasons = ({ detected }: { readonly detected: Detected }) => (
  <div data-testid="detection-reasons">
    {detected.map(({ repoId, fullName, detection }) => (
      <div key={repoId}>
        <PropGroup title={t("environment.foundIn", { repo: fullName })}>
          {detection.reasons.length === 0 ? <p className="text-sm text-muted">{t("environment.nothingFound")}</p> : null}
          <ul className="space-y-1.5 text-sm">
            {detection.reasons.map((reason, i) => (
              <li key={`${reason.file}-${String(i)}`}>
                <span className="font-mono text-faint">{reason.file}</span>
                <span className="block text-muted">{reason.finding}</span>
              </li>
            ))}
          </ul>
        </PropGroup>
        {detection.tools.length === 0 ? null : (
          <PropGroup title={t("environment.tools")}>
            <ul className="flex flex-wrap gap-1.5">
              {detection.tools.map((tool) => (
                <li key={tool.tool}><Chip className="font-mono">{tool.tool} {tool.version}</Chip></li>
              ))}
            </ul>
          </PropGroup>
        )}
        {detection.services.length === 0 ? null : (
          <PropGroup title={t("environment.services")}>
            <ul className="space-y-1.5 text-sm">
              {detection.services.map((service) => (
                <li key={service.name} className="flex items-center gap-2">
                  <span className="font-mono">{service.name}</span>
                  {service.image === null ? null : <span className="truncate font-mono text-faint">{service.image}</span>}
                  <Chip className="ml-auto text-amber">{t("environment.notOnHost")}</Chip>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-faint">{t("environment.servicesHelp")}</p>
          </PropGroup>
        )}
      </div>
    ))}
  </div>
);

/**
 * A project's environment (F-050, ADR 0038): the setup script, and each repo's variables, secrets
 * and files, edited and saved. A new project lands here on its draft, with detection's reasons.
 * No secret value is ever shown back: a stored secret reads "set".
 */
export const EnvironmentView = ({ projectId }: { readonly projectId: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const environment = useQuery(trpc.environments.get.queryOptions({ projectId }));
  const detect = useMutation(trpc.environments.detect.mutationOptions());
  const save = useMutation(
    trpc.environments.save.mutationOptions({
      onSuccess: async () => {
        setRows((current) => current.map((row) => (row.kind === "secret" && row.value !== "" ? { ...row, value: "", hasValue: true } : row)));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.environments.get.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
        ]);
      },
    }),
  );

  const [setupScript, setSetupScript] = useState("");
  const [baseImage, setBaseImage] = useState("");
  const [envFiles, setEnvFiles] = useState<Readonly<Record<string, string>>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const loaded = useRef(false);
  const admin = project.data?.role === "admin";

  // Load the saved environment once; a draft also asks detection for its reasons.
  useEffect(() => {
    const view = environment.data;
    if (view === undefined || loaded.current) return;
    loaded.current = true;
    setSetupScript(view.setupScript ?? "");
    setBaseImage(view.baseImage ?? "");
    setEnvFiles(Object.fromEntries(view.repos.map((repo) => [repo.repoId, repo.envFile])));
    setRows(rowsOf(view));
    if (view.status === "draft" && admin) {
      detect.mutate(
        { projectId },
        {
          onSuccess: (detected) => {
            if (view.entries.length === 0) setRows(rowsFromDetection(detected));
            const script = detected.map((repo) => repo.detection.setupScript).find((value) => value !== null);
            if ((view.setupScript ?? "") === "" && script !== undefined) setSetupScript(script);
          },
        },
      );
    }
  }, [environment.data, admin, detect, projectId]);

  const update = (key: string, change: (row: Row) => Row) => {
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
  };
  const firstRepo = environment.data?.repos[0]?.repoId;
  const add = (kind: Row["kind"], repoId: RepoId) => {
    const key = nextKey();
    const row: Row =
      kind === "variable"
        ? { key, kind, repoId, name: "", value: "", availableDuringSetup: false }
        : kind === "secret"
          ? { key, kind, repoId, name: "", value: "", hasValue: false, availableDuringSetup: false }
          : { key, kind, repoId, path: "", content: "", availableDuringSetup: false };
    setRows((current) => [...current, row]);
  };

  const submit = () => {
    const view = environment.data;
    if (view === undefined) return;
    save.mutate({
      projectId,
      environment: {
        baseImage: baseImage.trim() === "" ? null : baseImage.trim(),
        setupScript: setupScript.trim() === "" ? null : setupScript,
        envFiles: view.repos.map((repo) => ({ repoId: repo.repoId, path: (envFiles[repo.repoId] ?? repo.envFile).trim() || ".env" })),
        entries: rows.map(toEntry),
      },
    });
  };

  const view = environment.data;
  const name = project.data?.name ?? "";
  const created = params.get("created") !== null;

  return (
    <PageFrame
      crumbs={[{ label: name, href: `/projects/${projectId}` }, { label: t("shell.environment") }]}
      actions={admin ? (
        <Button variant="primary" onClick={submit} disabled={save.isPending || view === undefined}>
          {save.isPending ? t("common.saving") : t("environment.save")}
        </Button>
      ) : undefined}
      properties={detect.data === undefined ? undefined : <Reasons detected={detect.data} />}
      wideProperties
    >
      <PageHeading
        eyebrow={view === undefined ? undefined : view.status === "draft" ? t("environment.draft") : t("environment.savedAgo", { age: formatAge(view.savedAt ?? Date.now()) })}
        title={t("environment.title")}
        lede={created ? t("environment.createdLede") : t("environment.lede")}
      />
      {environment.error === null ? null : <p role="alert" className="text-red">{errorText(environment.error)}</p>}
      {save.error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{errorText(save.error)}</p>}
      {save.data === undefined ? null : (
        <div className="mt-3 text-sm" role="status">
          <span className="text-green">{t("environment.saved")}</span>
          {save.data.warnings.map((warning) => (
            <p key={warning} className="mt-1 flex items-start gap-1.5 text-amber"><TriangleAlertIcon className="mt-0.5 size-[13px] shrink-0" />{warning}</p>
          ))}
        </div>
      )}

      <Section title={t("environment.setupScript")}>
        <p className="mb-2 text-sm text-muted">{t("environment.setupScriptHelp")}</p>
        <Textarea
          aria-label={t("environment.setupScript")}
          className="min-h-28 font-mono text-[12.5px]"
          spellCheck={false}
          value={setupScript}
          readOnly={!admin}
          onChange={(e) => { setSetupScript(e.target.value); }}
          placeholder="pnpm install --frozen-lockfile"
        />
      </Section>

      {view?.repos.map((repo) => {
        const repoRows = rows.filter((row) => row.repoId === repo.repoId);
        return (
          <Section key={repo.repoId} title={repo.fullName} count={repoRows.length}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              <label htmlFor={`env-file-${repo.repoId}`}>{t("environment.envFile")}</label>
              <Input
                id={`env-file-${repo.repoId}`}
                className="h-7 w-48 font-mono text-sm"
                value={envFiles[repo.repoId] ?? repo.envFile}
                readOnly={!admin}
                onChange={(e) => { setEnvFiles((current) => ({ ...current, [repo.repoId]: e.target.value })); }}
              />
            </div>
            <ul className="rows" aria-label={t("environment.entries", { repo: repo.fullName })}>
              {repoRows.map((row) => {
                const Icon = kindIcon[row.kind];
                return (
                  <li key={row.key} data-kind={row.kind} className="flex flex-wrap items-start gap-2 py-2">
                    <Icon aria-label={t(`environment.kind.${row.kind}`)} className="mt-2 size-[14px] shrink-0 text-muted" />
                    {row.kind === "file" ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Input aria-label={t("environment.path")} className="h-7 font-mono text-sm" value={row.path} readOnly={!admin} placeholder="config/local.json"
                          onChange={(e) => { update(row.key, (r) => (r.kind === "file" ? { ...r, path: e.target.value } : r)); }} />
                        <Textarea aria-label={t("environment.content")} className="min-h-16 font-mono text-sm" value={row.content} readOnly={!admin}
                          onChange={(e) => { update(row.key, (r) => (r.kind === "file" ? { ...r, content: e.target.value } : r)); }} />
                      </div>
                    ) : (
                      <>
                        <Input aria-label={t("environment.name")} className="h-7 w-full font-mono text-sm sm:w-56" value={row.name} readOnly={!admin} placeholder="API_URL"
                          onChange={(e) => { update(row.key, (r) => (r.kind === "file" ? r : { ...r, name: e.target.value.toUpperCase() })); }} />
                        <Input
                          aria-label={row.kind === "secret" ? t("environment.secretValue") : t("environment.value")}
                          type={row.kind === "secret" ? "password" : "text"}
                          autoComplete="off"
                          className="h-7 min-w-0 flex-1 font-mono text-sm"
                          value={row.value}
                          readOnly={!admin}
                          placeholder={row.kind === "secret" ? (row.hasValue ? t("environment.secretSet") : t("environment.secretEmpty")) : ""}
                          onChange={(e) => { update(row.key, (r) => (r.kind === "file" ? r : { ...r, value: e.target.value })); }}
                        />
                      </>
                    )}
                    <label className="mt-1.5 flex shrink-0 items-center gap-1.5 text-sm text-muted" title={t("environment.duringSetupHelp")}>
                      <input type="checkbox" checked={row.availableDuringSetup} disabled={!admin} className="accent-[var(--teal)]"
                        onChange={(e) => { update(row.key, (r) => ({ ...r, availableDuringSetup: e.target.checked })); }} />
                      {t("environment.duringSetup")}
                    </label>
                    {admin ? (
                      <button type="button" className="mt-1.5 rounded-sm p-0.5 text-faint hover:text-red" aria-label={t("common.remove")}
                        onClick={() => { setRows((current) => current.filter((r) => r.key !== row.key)); }}>
                        <XIcon className="size-[14px]" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {admin ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(["variable", "secret", "file"] as const).map((kind) => (
                  <Button key={kind} size="sm" variant="ghost" onClick={() => { add(kind, repo.repoId); }}>
                    <PlusIcon /> {t(`environment.add.${kind}`)}
                  </Button>
                ))}
              </div>
            ) : null}
          </Section>
        );
      })}

      {firstRepo === undefined ? null : (
        <Section title={t("environment.baseImage")}>
          <p className="mb-2 text-sm text-muted">{t("environment.baseImageHelp")}</p>
          <Input aria-label={t("environment.baseImage")} className="max-w-[420px] font-mono" value={baseImage} readOnly={!admin} placeholder={t("environment.baseImageDefault")}
            onChange={(e) => { setBaseImage(e.target.value); }} />
        </Section>
      )}
    </PageFrame>
  );
};
