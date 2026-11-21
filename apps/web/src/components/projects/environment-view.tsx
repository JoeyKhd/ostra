"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, CheckIcon, FileIcon, FlaskConicalIcon, KeyRoundIcon, LockIcon, PlusIcon, ShieldCheckIcon, TriangleAlertIcon, VariableIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

import { ServicesAndChecks, SnapshotProperties } from "./environment-services";
import { entriesText, lineCount, withoutFinalNewline } from "./environment-words";
import { EnvironmentProposalTab, ProposalProperties, TestEnvironmentButton } from "./environment-proposal";
import { AppProperties, AppWarnings, EnvironmentAppTab } from "./environment-app";

/**
 * The page's tabs (environment-services.md): `?tab=services`, milestone 8's `?tab=app` (ticket 17),
 * milestone 6's `?tab=proposal` (ticket 36), or none for Setup.
 */
type EnvironmentTab = "setup" | "services" | "app" | "proposal";

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

/** "2h ago", or "just now". */
const agoText = (since: number): string => {
  const age = formatAge(since);
  return age === "now" ? t("environment.justNow") : t("environment.ago", { age });
};

const savedAgoText = (since: number): string => {
  const age = formatAge(since);
  return age === "now" ? t("environment.savedJustNow") : t("environment.savedAgo", { age });
};

const kindIcon = { variable: VariableIcon, secret: KeyRoundIcon, file: FileIcon } as const;

/** An input that reads as text at rest: no border and no fill until hovered or focused. */
const quietInput =
  "h-[30px] w-full rounded-md border border-transparent bg-transparent px-2 font-mono text-body text-text placeholder:text-faint hover:border-control-line hover:bg-surface focus-visible:border-faint focus-visible:bg-surface read-only:hover:border-transparent read-only:hover:bg-transparent";

/** A section of the page: a 28px title line with an inline note or a right-hand end, then its body. */
const EnvSection = ({ title, count, note, end, children }: { readonly title: ReactNode; readonly count?: number; readonly note?: ReactNode; readonly end?: ReactNode; readonly children: ReactNode }) => (
  <section className="mt-[26px]">
    <div className="mb-2 flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="flex items-baseline gap-2 text-body font-semibold">
        {title}
        {count === undefined ? null : <span className="font-mono text-[12.5px] font-normal text-faint">{count}</span>}
      </h2>
      {note === undefined ? null : <span className="text-ui text-muted">{note}</span>}
      {end === undefined ? null : <div className="ml-auto flex items-center gap-2">{end}</div>}
    </div>
    {children}
  </section>
);

/** The setup script: the shared code editor, with its gutter of line numbers. 3 lines at least. */
const ScriptEditor = ({ value, readOnly, onChange }: { readonly value: string; readonly readOnly: boolean; readonly onChange: (value: string) => void }) => (
  <CodeEditor label={t("environment.setupScript")} value={value} readOnly={readOnly} onChange={onChange} placeholder="pnpm install --frozen-lockfile" />
);

/** The outline badge (`Badge variant="outline"`): 22px, `--line-2`, mono. */
const Badge = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-line-2 bg-surface px-2 font-mono text-sm text-muted [&_svg]:size-3", className)}>
    {children}
  </span>
);

/** The panel: the environment's status, repos and entries; on a draft, what detection found (F-112). */
const Properties = ({ view, rows, detected, detecting }: { readonly view: View | undefined; readonly rows: readonly Row[]; readonly detected: Detected | undefined; readonly detecting: boolean }) => (
  <div data-testid="environment-properties">
    <PropGroup title={t("environment.group")}>
      {view === undefined ? (
        [0, 1, 2].map((i) => (
          <div key={i} className="grid h-8 grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
            <Skeleton className="w-14" />
            <Skeleton className="w-28" />
          </div>
        ))
      ) : (
        <>
          <PropRow label={t("environment.status")}>
            {view.status === "draft" ? (
              <Status tone="grey">{t("environment.statusDraft")}</Status>
            ) : (
              <Status tone="green">
                {t("environment.statusSaved")}
                {view.savedAt === null ? null : <span className="text-muted">{` · ${agoText(view.savedAt)}`}</span>}
              </Status>
            )}
          </PropRow>
          {view.repos.map((repo) => (
            <PropRow key={repo.repoId} label={t("environment.repo")}>
              <span className="truncate font-mono">{repo.fullName}</span>
            </PropRow>
          ))}
          <PropRow label={t("environment.entriesKey")}>
            <span className="truncate">{entriesText(rows.map((row) => row.kind)) || "–"}</span>
          </PropRow>
        </>
      )}
    </PropGroup>
    {view?.status !== "draft" ? null : detecting && detected === undefined ? (
      <p className="text-sm text-faint">{t("environment.reading")}</p>
    ) : (
      detected?.map(({ repoId, fullName, detection }) => (
        <div key={repoId} data-testid="detection-reasons">
          <PropGroup title={t("environment.foundIn", { repo: fullName })}>
            {detection.reasons.length === 0 ? (
              <p className="text-ui text-muted">{t("environment.nothingFound")}</p>
            ) : (
              <ul className="space-y-1.5 text-ui">
                {detection.reasons.map((reason, i) => (
                  <li key={`${reason.file}-${String(i)}`}>
                    <span className="block font-mono text-text">{reason.file}</span>
                    <span className="block text-muted">{reason.finding}</span>
                  </li>
                ))}
              </ul>
            )}
          </PropGroup>
          {detection.reasons.length === 0 || detection.tools.length === 0 ? null : (
            <PropGroup title={t("environment.tools")}>
              <ul className="flex flex-wrap gap-1.5">
                {detection.tools.map((tool) => (
                  <li key={`${tool.tool}-${tool.source}`}><Badge className="text-text">{tool.tool} {tool.version}</Badge></li>
                ))}
              </ul>
            </PropGroup>
          )}
          {detection.reasons.length === 0 || detection.services.length === 0 ? null : (
            <PropGroup title={t("environment.services")}>
              <ul>
                {detection.services.map((service) => (
                  <li key={service.name} className="flex h-[30px] items-center gap-3 text-ui">
                    <span className="font-mono text-text">{service.name}</span>
                    {service.image === null ? null : <span className="min-w-0 truncate font-mono text-faint">{service.image}</span>}
                    <Badge className="ml-auto text-xs">{t("environment.notOnHost")}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-sm text-faint">{t("environment.servicesShort")}</p>
            </PropGroup>
          )}
        </div>
      ))
    )}
  </div>
);

/** The value cell of a secret: a password input with its badge; read-only, `set` or `No value yet`. */
const SecretValue = ({ row, admin, onChange }: { readonly row: Extract<Row, { kind: "secret" }>; readonly admin: boolean; readonly onChange: (value: string) => void }) => (
  <div className="flex min-w-0 items-center gap-2">
    {admin ? (
      <input
        type="password"
        autoComplete="off"
        aria-label={t("environment.secretValue")}
        className="h-[28px] w-[240px] min-w-0 rounded-md border border-control-line bg-surface px-2.5 font-mono text-body text-text placeholder:text-faint focus-visible:border-faint"
        value={row.value}
        placeholder={row.hasValue ? t("environment.secretSet") : t("environment.secretEmpty")}
        onChange={(e) => { onChange(e.target.value); }}
      />
    ) : (
      <span className={cn("px-2 font-mono", row.hasValue ? "text-muted" : "text-faint")}>{row.hasValue ? t("environment.secretStored") : t("environment.secretEmpty")}</span>
    )}
    <Badge className="font-sans">
      <LockIcon aria-hidden className="stroke-[1.75]" />
      {t("environment.secretBadge")}
    </Badge>
  </div>
);

/**
 * A project's environment (F-050, ADR 0038, environment.md): the setup script, and each repo's
 * variables, secrets and files, edited and saved. A new project lands here on its draft, with what
 * detection found. No secret value is ever shown back: a stored secret reads "set".
 */
export const EnvironmentView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const environment = useQuery(trpc.environments.get.queryOptions({ projectId }));
  // Ticket 36: the onboarding task and its open proposal, for the Proposal tab, its banner and "Test this environment".
  const onboarding = useQuery({ ...trpc.environments.onboarding.queryOptions({ projectId }), refetchInterval: 10_000 });
  const proposal = useQuery(trpc.environments.proposal.queryOptions({ projectId }));
  // A proposal waiting for a decision: the tab's dot and the banner. One decided in the last 7 days is only read (ticket 41).
  const waiting = proposal.data?.decision === null;
  // Milestone 8: a port an agent announced and a member kept (`source: kept`), not onboarding's.
  const keptWaiting = waiting && proposal.data?.source === "kept";
  const [now] = useState(() => Date.now());
  const [startError, setStartError] = useState<string | null>(null);
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
  const [editing, setEditing] = useState<string | null>(null);
  const loaded = useRef(false);
  const baseImageHelpId = useId();
  const admin = project.data?.role === "admin";

  // Load the saved environment once; a draft also asks detection for its reasons.
  useEffect(() => {
    const view = environment.data;
    if (view === undefined || loaded.current) return;
    loaded.current = true;
    setSetupScript(withoutFinalNewline(view.setupScript ?? ""));
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
            if ((view.setupScript ?? "") === "" && script !== undefined) setSetupScript(withoutFinalNewline(script));
          },
        },
      );
    }
  }, [environment.data, admin, detect, projectId]);

  const update = (key: string, change: (row: Row) => Row) => {
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
  };
  const add = (kind: Row["kind"], repoId: RepoId) => {
    const key = nextKey();
    const row: Row =
      kind === "variable"
        ? { key, kind, repoId, name: "", value: "", availableDuringSetup: false }
        : kind === "secret"
          ? { key, kind, repoId, name: "", value: "", hasValue: false, availableDuringSetup: false }
          : { key, kind, repoId, path: "", content: "", availableDuringSetup: false };
    setRows((current) => [...current, row]);
    if (kind === "file") setEditing(key);
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

  const router = useRouter();
  const pathname = usePathname();
  const tabParam = params.get("tab");
  const tab: EnvironmentTab = tabParam === "services" || tabParam === "app" || tabParam === "proposal" ? tabParam : "setup";
  // Ticket 17: the App tab's warnings under the tabs, from its list (shared with the tab's own query).
  const appList = useQuery(trpc.environments.appProcesses.list.queryOptions({ projectId }, { enabled: tab === "app" }));
  const selectTab = (next: EnvironmentTab) => {
    const query = new URLSearchParams(params.toString());
    query.delete("process");
    if (next === "services" || next === "app" || next === "proposal") query.set("tab", next);
    else query.delete("tab");
    const search = query.toString();
    router.replace(search === "" ? pathname : `${pathname}?${search}`, { scroll: false });
  };
  const view = environment.data;
  const name = project.data?.name ?? "";
  const created = params.get("created") !== null;
  const editedFile = rows.find((row): row is Extract<Row, { kind: "file" }> => row.key === editing && row.kind === "file");

  return (
    <PageFrame
      crumbs={[{ label: name, href: `/projects/${projectId}` }, { label: t("shell.environment") }]}
      actions={
        <>
          <TestEnvironmentButton projectId={projectId} onboarding={onboarding.data} onStarted={() => { selectTab("proposal"); }} onError={setStartError} />
          {admin && tab === "setup" ? (
            <Button variant="primary" onClick={submit} disabled={save.isPending || view === undefined}>
              {save.isPending ? t("common.saving") : t("environment.save")}
            </Button>
          ) : null}
        </>
      }
      properties={
        tab === "proposal" ? <ProposalProperties proposal={proposal.data ?? null} onboarding={onboarding.data} now={now} /> : tab === "app" ? <AppProperties projectId={projectId} view={view} /> : <>
          <SnapshotProperties projectId={projectId} view={view} admin={admin} servicesTab={tab === "services"} />
          {tab === "setup" ? <Properties view={view} rows={rows} detected={detect.data} detecting={detect.isPending} /> : null}
        </>
      }
      wideProperties
    >
      <div className="max-w-[760px]">
        <PageHeading
          eyebrow={
            view === undefined
              ? environment.isPending ? <Skeleton className="my-1 w-32" /> : undefined
              : view.status === "draft" ? t("environment.draftEyebrow") : savedAgoText(view.savedAt ?? Date.now())
          }
          title={t("environment.title")}
          lede={created && view?.status === "draft" ? t("environment.createdLede") : t("environment.lede")}
        />
        <UnderlineTabs
          className="mt-3.5"
          label={t("environment.tabs.label")}
          idPrefix="environment"
          tabs={[
            { id: "setup", label: t("environment.tabs.setup") },
            { id: "services", label: t("environment.tabs.servicesAndChecks") },
            { id: "app", label: t("environment.tabs.app") },
            // Ticket 36: the onboarding task's proposal, once there's an onboarding task; a dot while a proposal waits (amber for its admins).
            ...(onboarding.data?.task === null || onboarding.data === undefined
              ? []
              : [{ id: "proposal" as const, label: t("environment.tabs.proposal"), extra: !waiting ? null : <span aria-hidden className={cn("inline-block size-1.5 rounded-full", admin ? "bg-amber" : "bg-faint")} /> }]),
          ]}
          selected={tab}
          onSelect={selectTab}
        />
        {save.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(save.error)}</p>}
        {save.data === undefined ? null : (
          <div className="mt-2 space-y-1 text-ui" role="status">
            <p className="flex items-center gap-1.5 text-green"><CheckIcon aria-hidden className="size-[13px] stroke-[2]" />{t("environment.saved")}</p>
            {save.data.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-1.5 text-muted"><TriangleAlertIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />{warning}</p>
            ))}
          </div>
        )}
        {environment.error === null ? null : <p role="alert" className="mt-4 text-ui text-red">{errorText(environment.error)}</p>}
        {startError === null ? null : <p role="alert" className="mt-2 text-xs text-red" data-testid="onboarding-error">{startError}</p>}
        {tab === "app" ? <AppWarnings list={appList.data} baseImage={view?.baseImage ?? null} /> : null}
        {/* Ticket 17: a process kept from a task is reviewed on the App tab, which shows it in its band. */}
        {tab !== "proposal" && waiting && !(keptWaiting && tab === "app") ? (
          <p className="mt-2 flex min-h-9 items-center gap-2 text-ui text-text" data-testid="proposal-banner">
            {admin ? <span aria-hidden className="size-1.5 rounded-full bg-amber" /> : null}
            {keptWaiting ? <AppWindowIcon aria-hidden className="size-[15px] text-muted" /> : <FlaskConicalIcon aria-hidden className="size-[15px] text-muted" />}
            {keptWaiting ? t("environment.keptBanner") : t("environment.proposalBanner")}
            <button type="button" className="text-teal hover:underline" onClick={() => { selectTab(keptWaiting ? "app" : "proposal"); }}>{keptWaiting ? t("environment.reviewKept") : t("environment.reviewProposal")}</button>
          </p>
        ) : null}

        {tab === "proposal" ? (
          <div role="tabpanel" id="environment-panel-proposal" aria-labelledby="environment-tab-proposal">
            <EnvironmentProposalTab projectId={projectId} projectName={name} onboarding={onboarding.data} now={now} />
          </div>
        ) : view === undefined ? (
          environment.isPending ? (
            <div aria-busy className="mt-[26px] space-y-3">
              <Skeleton className="w-24" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="mt-6 w-40" />
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[30px] w-full" />)}
            </div>
          ) : null
        ) : tab === "services" ? (
          <div role="tabpanel" id="environment-panel-services" aria-labelledby="environment-tab-services">
            <ServicesAndChecks projectId={projectId} view={view} admin={admin} />
          </div>
        ) : tab === "app" ? (
          <div role="tabpanel" id="environment-panel-app" aria-labelledby="environment-tab-app">
            <EnvironmentAppTab projectId={projectId} view={view} />
          </div>
        ) : (
          <div role="tabpanel" id="environment-panel-setup" aria-labelledby="environment-tab-setup">
            <EnvSection title={t("environment.setupScript")} note={t("environment.setupScriptNote")}>
              <ScriptEditor value={setupScript} readOnly={!admin} onChange={setSetupScript} />
            </EnvSection>

            {view.repos.map((repo) => {
              const repoRows = rows.filter((row) => row.repoId === repo.repoId);
              const envFileId = `env-file-${repo.repoId}`;
              return (
                <EnvSection
                  key={repo.repoId}
                  title={<span className="font-mono font-semibold">{repo.fullName}</span>}
                  count={repoRows.length}
                  end={
                    <>
                      <label htmlFor={envFileId} className="text-ui text-muted">{t("environment.writtenTo")}</label>
                      <input
                        id={envFileId}
                        className="h-[26px] w-[82px] rounded-md border border-control-line bg-surface px-2 font-mono text-sm text-text focus-visible:border-faint"
                        value={envFiles[repo.repoId] ?? repo.envFile}
                        readOnly={!admin}
                        onChange={(e) => { setEnvFiles((current) => ({ ...current, [repo.repoId]: e.target.value })); }}
                      />
                    </>
                  }
                >
                  <Table aria-label={t("environment.entries", { repo: repo.fullName })}>
                    <colgroup>
                      <col className="w-7" />
                      <col className="w-[38%] md:w-[210px]" />
                      <col />
                      <col className="hidden w-24 md:table-column" />
                      <col className="w-7" />
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        <TableHead><span className="sr-only">{t("environment.kind.variable")}</span></TableHead>
                        <TableHead className="pl-2">{t("environment.name")}</TableHead>
                        <TableHead className="pl-2">{t("environment.value")}</TableHead>
                        <TableHead className="hidden text-center md:table-cell">{t("environment.duringSetupHead")}</TableHead>
                        <TableHead><span className="sr-only">{t("common.remove")}</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {repoRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="h-10 text-faint">{t("environment.noEntries")}</TableCell>
                        </TableRow>
                      ) : null}
                      {repoRows.map((row) => {
                        const Icon = kindIcon[row.kind];
                        const duringSetup = (
                          <Checkbox
                            tone="teal"
                            aria-label={t("environment.duringSetupHelp")}
                            checked={row.availableDuringSetup}
                            disabled={!admin}
                            onCheckedChange={(checked) => { update(row.key, (r) => ({ ...r, availableDuringSetup: checked === true })); }}
                          />
                        );
                        return (
                          <TableRow key={row.key} data-kind={row.kind}>
                            <TableCell className="h-[37px]">
                              <Icon role="img" aria-label={t(`environment.kind.${row.kind}`)} className="size-[15px] stroke-[1.75] text-faint" />
                            </TableCell>
                            <TableCell className="h-[37px] pr-2">
                              {row.kind === "file" ? (
                                <span className="block truncate px-2 font-mono text-body text-text">{row.path}</span>
                              ) : (
                                <input
                                  aria-label={t("environment.name")}
                                  className={quietInput}
                                  value={row.name}
                                  readOnly={!admin}
                                  placeholder="API_URL"
                                  onChange={(e) => { update(row.key, (r) => (r.kind === "file" ? r : { ...r, name: e.target.value.toUpperCase() })); }}
                                />
                              )}
                            </TableCell>
                            <TableCell className="h-[37px] py-1 pr-2">
                              {row.kind === "variable" ? (
                                <input
                                  aria-label={t("environment.value")}
                                  className={quietInput}
                                  value={row.value}
                                  readOnly={!admin}
                                  placeholder={t("environment.valuePlaceholder")}
                                  onChange={(e) => { update(row.key, (r) => (r.kind === "variable" ? { ...r, value: e.target.value } : r)); }}
                                />
                              ) : row.kind === "secret" ? (
                                <SecretValue row={row} admin={admin} onChange={(value) => { update(row.key, (r) => (r.kind === "secret" ? { ...r, value } : r)); }} />
                              ) : (
                                <span className="flex items-center gap-3 px-2">
                                  <span className="font-mono text-faint">{plural(lineCount(row.content), "environment.linesOne", "environment.lines")}</span>
                                  <button type="button" className="text-teal hover:underline" onClick={() => { setEditing(row.key); }}>
                                    {admin ? t("environment.edit") : t("environment.content")}
                                  </button>
                                </span>
                              )}
                              <label className="mt-1 flex items-center gap-1.5 px-2 text-sm text-muted md:hidden">
                                {duringSetup}
                                {t("environment.duringSetup")}
                              </label>
                            </TableCell>
                            <TableCell className="hidden h-[37px] text-center md:table-cell">
                              <div className="flex items-center justify-center">
                                <Tooltip content={t("environment.duringSetupHelp")}>
                                  <span className="inline-flex">{duringSetup}</span>
                                </Tooltip>
                              </div>
                            </TableCell>
                            <TableCell className="h-[37px] text-right">
                              {admin ? (
                                <button
                                  type="button"
                                  className="inline-grid size-6 place-items-center rounded-sm text-faint hover:bg-hover hover:text-red"
                                  aria-label={t("common.remove")}
                                  onClick={() => { setRows((current) => current.filter((r) => r.key !== row.key)); }}
                                >
                                  <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                                </button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {admin ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(["variable", "secret", "file"] as const).map((kind) => (
                        <Button key={kind} size="sm" variant="ghost" className="[&_svg]:size-[13px]" onClick={() => { add(kind, repo.repoId); }}>
                          <PlusIcon aria-hidden /> {t(`environment.add.${kind}`)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </EnvSection>
              );
            })}

            <EnvSection title={t("environment.baseImage")} note={t("environment.baseImageNote")}>
              <Tooltip content={t("environment.baseImageHelp")}>
                <Input
                  aria-label={t("environment.baseImage")}
                  aria-describedby={baseImageHelpId}
                  className="w-full max-w-[320px] font-mono"
                  value={baseImage}
                  readOnly={!admin}
                  placeholder={t("environment.baseImageDefault")}
                  onChange={(e) => { setBaseImage(e.target.value); }}
                />
              </Tooltip>
              <span id={baseImageHelpId} className="sr-only">{t("environment.baseImageHelp")}</span>
            </EnvSection>

            <p className="mt-[22px] flex items-start gap-2 text-ui text-muted">
              <ShieldCheckIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-faint" />
              {t("environment.footnote")}
            </p>
          </div>
        )}
      </div>

      <Sheet open={editedFile !== undefined} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        {editedFile === undefined ? null : (
          <SheetContent title={t("environment.editFile")} className="w-[min(420px,92vw)] gap-4 p-5">
            <h2 className="text-body font-semibold">{t("environment.editFile")}</h2>
            <div>
              <Label htmlFor="file-path">{t("environment.path")}</Label>
              <Input
                id="file-path"
                className="font-mono"
                value={editedFile.path}
                readOnly={!admin}
                placeholder="config/local.json"
                onChange={(e) => { update(editedFile.key, (r) => (r.kind === "file" ? { ...r, path: e.target.value } : r)); }}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <Label htmlFor="file-content">{t("environment.content")}</Label>
              <Textarea
                id="file-content"
                className="min-h-[calc(12*1.6em)] flex-1 font-mono text-ui"
                spellCheck={false}
                value={editedFile.content}
                readOnly={!admin}
                onChange={(e) => { update(editedFile.key, (r) => (r.kind === "file" ? { ...r, content: e.target.value } : r)); }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              <Checkbox
                tone="teal"
                checked={editedFile.availableDuringSetup}
                disabled={!admin}
                onCheckedChange={(checked) => { update(editedFile.key, (r) => ({ ...r, availableDuringSetup: checked === true })); }}
              />
              {t("environment.duringSetup")}
            </label>
            <div>
              <Button variant="primary" onClick={() => { setEditing(null); }}>{t("environment.done")}</Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </PageFrame>
  );
};
