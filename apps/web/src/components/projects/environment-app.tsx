"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, InfoIcon, PlusIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { APP_COLUMNS, AppProcessRow, BandRow } from "./app-process-row";
import type { AppRow as AppTableRow, FoundProcess } from "./app-process-row";
import { AppProcessSheet } from "./app-process-sheet";
import type { SheetMode } from "./app-process-sheet";
import { ignoreKey } from "./environment-app-words";
import type { SavedProcess } from "./environment-app-words";
import { moved } from "./environment-services-words";
import { InBoxAddresses } from "./in-box-addresses";
import { AppGroup, AppRow, ScreenshotSettings } from "./screenshot-settings";

// The environment page's App tab (app-targets/m8/environment-app-processes.md; F-140, F-121,
// milestone 8's ticket 17): the app's processes in their start order, with how each did on the
// last box; the processes kept from a task and the ones detection found, waiting to be added; the
// services with a web UI; and, in the panel, the screenshots after each turn, the in-box addresses
// and the box's browser. Each process saves from its sheet (`?tab=app&process={name}`), each panel
// control at once. A member reads it all.

type View = RouterOutputs["environments"]["get"];
type ListView = RouterOutputs["environments"]["appProcesses"]["list"];
type ServiceView = RouterOutputs["environments"]["services"]["list"][number];

/** How to add a browser to an image, and how to upgrade a runner: the docs. */
const BROWSER_DOCS = "https://github.com/JoeyKhd/ostra/blob/main/docs/configuration.md#the-runner";
const UPGRADE_DOCS = "https://github.com/JoeyKhd/ostra/blob/main/docs/configuration.md#the-runner";

/** "Ignore" hides a detected process in this browser until its file says something else. */
const readIgnored = (key: string): boolean => {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const writeIgnored = (key: string): void => {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage off: it shows again on the next visit.
  }
};

const savedOf = (process: ListView["processes"][number]): SavedProcess => ({
  name: process.name,
  repoId: process.repoId,
  folder: process.folder,
  command: process.command,
  port: process.port,
  ready: process.ready,
  label: process.label,
  primary: process.primary,
  hostRewrite: process.hostRewrite,
});

/** A warning line under the tabs: an icon, the line, its detail and a teal link. Never red: the processes still work. */
const Warning = ({ title, detail, link, href, testid }: { readonly title: ReactNode; readonly detail?: string; readonly link: string; readonly href: string; readonly testid: string }) => (
  <div className="mt-4 flex gap-2.5" role="status" data-testid={testid}>
    <TriangleAlertIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-muted" />
    <div>
      <p className="text-body text-text">{title}</p>
      <p className="mt-0.5 text-ui text-muted">
        {detail === undefined ? null : <>{detail} </>}
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline">{link}</a>
      </p>
    </div>
  </div>
);

/** The warnings under the tabs: the last box had no browser, or its runner is too old to run the app. */
export const AppWarnings = ({ list, baseImage }: { readonly list: ListView | undefined; readonly baseImage: string | null }) => {
  if (list === undefined) return null;
  const noBrowser = list.browser?.browser.available === false;
  return (
    <>
      {list.olderRunner === null ? null : (
        <Warning testid="app-older-runner" title={t("environment.app.olderRunner", { runner: list.olderRunner.name })} link={t("environment.app.howToUpgrade")} href={UPGRADE_DOCS} />
      )}
      {noBrowser ? (
        <Warning
          testid="app-no-browser"
          title={baseImage === null ? t("environment.app.noBrowserTitle") : <>{t("environment.app.noBrowserImageBefore")} <span className="font-mono">{baseImage}</span> {t("environment.app.noBrowserImageAfter")}</>}
          detail={t("environment.app.noBrowserDetail")}
          link={t("environment.app.howToAddBrowser")}
          href={BROWSER_DOCS}
        />
      ) : null}
    </>
  );
};

const LoadingRows = () =>
  [0, 1, 2].map((index) => (
    <TableRow key={index}>
      <TableCell colSpan={APP_COLUMNS} className="h-[52px]">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="mt-1.5 h-3 w-1/3" />
      </TableCell>
    </TableRow>
  ));

/** "Services with a web UI": each service with a port, its switch, and its label in place. */
const WebUiServices = ({ projectId, services, canEdit }: { readonly projectId: ProjectId; readonly services: readonly ServiceView[]; readonly canEdit: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  const setPreview = useMutation(
    trpc.environments.services.setPreview.mutationOptions({
      onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.environments.services.list.queryKey({ projectId }) }); },
    }),
  );
  // The ones with a web UI first: they're what the table is about.
  const withPort = services.filter((service) => service.port !== null).sort((a, b) => Number(b.previewLabel !== null) - Number(a.previewLabel !== null));
  if (withPort.length === 0) return null;
  const titleCase = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <section className="mt-7" aria-label={t("environment.app.webUi.title")}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold">{t("environment.app.webUi.title")}</h2>
        <span className="text-ui text-muted">{t("environment.app.webUi.note")}</span>
      </div>
      {/* At phone width the table lays itself out (`table-auto`), the port under the service's name. */}
      <Table aria-label={t("environment.app.webUi.title")} className="text-ui max-sm:table-auto">
        <colgroup className="max-sm:hidden">
          <col />
          <col className="w-[62px]" />
          <col className="w-[150px]" />
          <col className="w-[150px]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{t("environment.svc.service")}</TableHead>
            <TableHead className="max-sm:hidden">{t("environment.svc.port")}</TableHead>
            <TableHead className="whitespace-nowrap max-sm:pr-3">{t("environment.app.webUi.hasWebUi")}</TableHead>
            <TableHead>{t("environment.app.webUi.label")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {withPort.map((service) => {
            const on = service.previewLabel !== null;
            const label = labels[service.serviceId] ?? service.previewLabel ?? "";
            const commit = () => {
              const next = label.trim();
              if (!on || next === "" || next === service.previewLabel) return;
              setPreview.mutate({ projectId, serviceId: service.serviceId, label: next });
            };
            return (
              <TableRow key={service.serviceId} data-web-ui={service.name}>
                <TableCell className="h-10 pr-3">
                  <span className="flex min-w-0 items-baseline gap-2.5 max-sm:flex-col max-sm:gap-0">
                    <span className="shrink-0 font-mono text-body text-text">{service.name}</span>
                    <span className="truncate font-mono text-[12.5px] text-faint max-sm:hidden">{service.image}</span>
                    <span className="font-mono text-xs text-faint sm:hidden">{`:${String(service.port)}`}</span>
                  </span>
                </TableCell>
                <TableCell className="h-10 font-mono text-[13.5px] text-text max-sm:hidden">{service.port}</TableCell>
                <TableCell className="h-10">
                  <label className="inline-flex items-center gap-2.5">
                    <Switch
                      checked={on}
                      disabled={!canEdit || setPreview.isPending}
                      aria-label={t("environment.app.webUi.switch", { name: service.name })}
                      onCheckedChange={(checked) => {
                        const fallback = titleCase(service.name);
                        if (checked) setLabels((now) => ({ ...now, [service.serviceId]: now[service.serviceId] ?? fallback }));
                        setPreview.mutate({ projectId, serviceId: service.serviceId, label: checked ? (labels[service.serviceId] ?? fallback).trim() || fallback : null });
                      }}
                    />
                    <span className="text-text">{on ? t("environment.app.webUi.yes") : t("environment.app.webUi.no")}</span>
                  </label>
                </TableCell>
                <TableCell className="h-10">
                  {!on ? (
                    <span className="text-faint">{t("environment.app.none")}</span>
                  ) : canEdit ? (
                    <input
                      aria-label={t("environment.app.webUi.labelOf", { name: service.name })}
                      className="h-7 w-full max-w-[96px] rounded-md border border-control-line bg-surface px-2 text-ui text-text focus-visible:border-faint"
                      value={label}
                      onChange={(event) => { setLabels((now) => ({ ...now, [service.serviceId]: event.target.value })); }}
                      onBlur={commit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commit();
                        }
                      }}
                    />
                  ) : (
                    <span className="text-text">{service.previewLabel}</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {setPreview.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(setPreview.error)}</p>}
    </section>
  );
};

/**
 * The App tab's page: the processes' table with its bands, the add button and its note, the
 * services with a web UI and the footnote. Its sheet opens from a row or `?process={name}`.
 */
export const EnvironmentAppTab = ({ projectId, view }: { readonly projectId: ProjectId; readonly view: View }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const list = useQuery(trpc.environments.appProcesses.list.queryOptions({ projectId }));
  const detected = useQuery({ ...trpc.environments.appProcesses.detected.queryOptions({ projectId }), staleTime: 60_000 });
  const services = useQuery(trpc.environments.services.list.queryOptions({ projectId }));
  const [now] = useState(() => Date.now());
  const [mode, setMode] = useState<SheetMode | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [order, setOrder] = useState<readonly SavedProcess[] | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const data = list.data;
  const canEdit = data?.canEdit === true;
  const processes = useMemo(() => (data?.processes ?? []).map(savedOf), [data?.processes]);
  const shown = order ?? processes;
  const repoName = (repoId: string): string => view.repos.find((repo) => repo.repoId === repoId)?.fullName ?? repoId;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.environments.appProcesses.list.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.screenshots.get.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.proposal.queryKey({ projectId }) }),
    ]);
  };
  const save = useMutation(trpc.environments.appProcesses.save.mutationOptions({ onSettled: async () => { setOrder(null); await invalidate(); } }));
  const decide = useMutation(trpc.environments.decideProposal.mutationOptions({ onSettled: invalidate }));

  // `?process={name}` opens that process's sheet (a link from a task's failed process).
  const processParam = params.get("process");
  const setProcessParam = (name: string | null) => {
    const query = new URLSearchParams(params.toString());
    if (name === null) query.delete("process");
    else query.set("process", name);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };
  const fromParam = processParam === null ? null : (data?.processes.find((process) => process.name === processParam) ?? null);
  const open: SheetMode | null = mode ?? (fromParam === null ? null : { kind: "edit", process: fromParam });
  const close = () => {
    setMode(null);
    if (processParam !== null) setProcessParam(null);
  };

  const found = (detected.data?.processes ?? []).filter((entry) => !ignored.has(ignoreKey(projectId, entry)));
  useEffect(() => {
    const keys = (detected.data?.processes ?? []).map((entry) => ignoreKey(projectId, entry)).filter(readIgnored);
    if (keys.length > 0) setIgnored(new Set(keys));
  }, [detected.data, projectId]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= shown.length || from === to) return;
    const next = moved(shown, from, to);
    const item = shown[from];
    setOrder(next);
    if (item !== undefined) setAnnounce(t("environment.app.moved", { name: item.name, position: to + 1, count: next.length }));
    save.mutate({ projectId, processes: [...next] });
  };
  const primary = processes.find((process) => process.primary) ?? null;
  const removingProcess = processes.find((process) => process.name === removing) ?? null;
  const removeNow = (name: string) => { save.mutate({ projectId, processes: processes.filter((process) => process.name !== name) }); };

  const declaredRows: AppTableRow[] = shown.flatMap((process, index): AppTableRow[] => {
    const full = data?.processes.find((one) => one.name === process.name);
    return full === undefined ? [] : [{ kind: "declared", process: full, index, count: shown.length }];
  });

  return (
    <div>
      <section className="mt-6" aria-label={t("environment.app.title")}>
        <div className="mb-1.5 flex min-h-[30px] flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex items-baseline gap-2 text-[15px] font-semibold">
            {t("environment.app.title")}
            {data === undefined ? null : <span className="font-mono text-ui font-normal text-faint">{data.processes.length}</span>}
          </h2>
          <span className="text-ui text-muted">{t("environment.app.note")}</span>
        </div>
        <Table aria-label={t("environment.app.title")} className="text-ui">
          <colgroup>
            <col className="w-6" />
            <col />
            <col className="w-[62px] max-sm:w-0" />
            <col className="w-[122px] max-sm:w-0" />
            <col className="w-[120px] max-lg:w-0" />
            <col className="w-7" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead><span className="sr-only">{t("environment.app.handleHead")}</span></TableHead>
              <TableHead>{t("environment.app.process")}</TableHead>
              <TableHead className="max-sm:hidden">{t("environment.app.port")}</TableHead>
              <TableHead className="max-sm:hidden">{t("environment.app.readyWhen")}</TableHead>
              <TableHead className="max-lg:hidden">{t("environment.app.lastBox")}</TableHead>
              <TableHead><span className="sr-only">{t("common.remove")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === undefined ? (list.error === null ? <LoadingRows /> : null) : null}
            {data?.processes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={APP_COLUMNS} className="h-[52px] text-faint" data-testid="app-empty">{t("environment.app.empty")}</TableCell>
              </TableRow>
            ) : null}
            {declaredRows.map((row) =>
              row.kind === "declared" ? (
                <AppProcessRow
                  key={row.process.name}
                  row={row}
                  actions={{
                    canEdit,
                    repoName,
                    now,
                    dragging: dragging === row.index,
                    onOpen: () => { setMode({ kind: "edit", process: row.process }); },
                    onRemove: () => { if (row.process.primary && processes.length > 1) setRemoving(row.process.name); else removeNow(row.process.name); },
                    onMove: (to) => { move(row.index, to); },
                    onDragStart: () => { setDragging(row.index); },
                    onDragEnd: () => { setDragging(null); },
                    onDropHere: () => {
                      if (dragging !== null) move(dragging, row.index);
                      setDragging(null);
                    },
                  }}
                />
              ) : null,
            )}
            {(data?.kept.length ?? 0) === 0 ? null : <BandRow icon="kept" title={t("environment.app.keptBand")} count={data?.kept.length ?? 0} />}
            {(data?.kept ?? []).map((kept) => (
              <AppProcessRow
                key={kept.proposalId}
                row={{ kind: "kept", kept }}
                actions={{
                  canEdit,
                  repoName,
                  now,
                  busy: decide.isPending,
                  onOpen: () => { setMode({ kind: "keep", kept }); },
                  onSecondary: () => { decide.mutate({ proposalId: kept.proposalId, decision: "reject", edited: null, reason: null }); },
                }}
              />
            ))}
            {found.length === 0 ? null : <BandRow icon="found" title={t("environment.app.foundBand")} count={found.length} />}
            {found.map((entry: FoundProcess) => (
              <AppProcessRow
                key={`${entry.repoId}:${entry.process.name}`}
                row={{ kind: "found", found: entry }}
                actions={{
                  canEdit,
                  repoName,
                  now,
                  onOpen: () => { setMode({ kind: "add", found: entry }); },
                  onSecondary: () => {
                    const key = ignoreKey(projectId, entry);
                    writeIgnored(key);
                    setIgnored((current) => new Set([...current, key]));
                  },
                }}
              />
            ))}
          </TableBody>
        </Table>
        <span className="sr-only" aria-live="polite">{announce}</span>
        {list.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(list.error)}</p>}
        {save.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(save.error)}</p>}
        {decide.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(decide.error)}</p>}
        {said === null ? null : (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-ui text-green" data-testid="app-said">
            <CheckIcon aria-hidden className="size-[13px] stroke-[2]" />
            {said}
          </p>
        )}
        {data !== undefined && data.processes.length > 0 && primary === null ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-ui text-text" data-testid="app-no-primary">
            <InfoIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />
            {t("environment.app.noPrimary", { name: processes[0]?.name ?? "" })}
            {canEdit && processes[0] !== undefined ? (
              <button
                type="button"
                className="text-teal hover:underline"
                onClick={() => { save.mutate({ projectId, processes: processes.map((process, index) => ({ ...process, primary: index === 0 })) }); }}
              >
                {t("environment.app.makePrimary", { name: processes[0].name })}
              </button>
            ) : null}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {canEdit ? (
            <Button size="sm" variant="ghost" className="h-6 px-1.5 [&_svg]:size-[13px]" onClick={() => { setMode({ kind: "new" }); }} data-action="add-process">
              <PlusIcon aria-hidden /> {t("environment.app.addProcess")}
            </Button>
          ) : null}
          <span className="text-ui text-faint">{t("environment.app.addNote")}</span>
        </div>
      </section>

      <WebUiServices projectId={projectId} services={services.data ?? []} canEdit={canEdit} />

      <p className="mt-[22px] flex items-start gap-2 text-ui text-muted">
        <ShieldCheckIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75] text-faint" />
        {t("environment.app.footnote")}
      </p>

      <Dialog.Root open={open !== null} onOpenChange={(value) => { if (!value) close(); }}>
        {open === null ? null : (
          <AppProcessSheet
            key={open.kind === "edit" ? `edit:${open.process.name}` : open.kind === "keep" ? `keep:${open.kept.proposalId}` : open.kind === "add" ? `add:${open.found.process.name}` : "new"}
            projectId={projectId}
            mode={open}
            processes={processes}
            repos={view.repos}
            serviceCount={(services.data ?? []).filter((service) => service.port !== null).length}
            canEdit={canEdit}
            onClose={close}
            onDone={(words) => {
              setSaid(words);
              close();
            }}
          />
        )}
      </Dialog.Root>

      <AlertDialog open={removingProcess !== null} onOpenChange={(value) => { if (!value) setRemoving(null); }}>
        {removingProcess === null ? null : (
          <AlertDialogContent
            title={t("environment.app.removeTitle", { name: removingProcess.name })}
            body={t("environment.app.removePrimary", { name: removingProcess.name, next: processes.find((process) => process.name !== removingProcess.name)?.name ?? "" })}
            cancel={t("environment.svc.cancel")}
            action={t("environment.svc.removeAction")}
            onAction={() => { removeNow(removingProcess.name); }}
          />
        )}
      </AlertDialog>
    </div>
  );
};

/** The App tab's panel: the screenshots after each turn, the in-box addresses and the box's browser. */
export const AppProperties = ({ projectId, view }: { readonly projectId: ProjectId; readonly view: View | undefined }) => {
  const trpc = useTRPC();
  const list = useQuery(trpc.environments.appProcesses.list.queryOptions({ projectId }));
  const services = useQuery(trpc.environments.services.list.queryOptions({ projectId }));
  const [now] = useState(() => Date.now());
  const data = list.data;
  const browser = data?.browser ?? null;
  const noBrowser = browser?.browser.available === false;
  const baseImage = view?.baseImage ?? null;
  return (
    <div data-testid="app-properties">
      <ScreenshotSettings projectId={projectId} canEdit={data?.canEdit === true} noBrowser={noBrowser} />
      {data === undefined ? null : <InBoxAddresses processes={data.processes} services={[...(services.data ?? [])].sort((a, b) => Number(b.previewLabel !== null) - Number(a.previewLabel !== null))} />}
      <AppGroup title={t("environment.app.browser.title")} testId="box-browser">
        {data === undefined ? (
          <Skeleton className="my-2 h-4 w-32" />
        ) : browser === null ? (
          <AppRow label={t("environment.app.browser.browser")}><span className="text-faint">{t("environment.app.browser.notSeen")}</span></AppRow>
        ) : browser.browser.available ? (
          <>
            <AppRow label={t("environment.app.browser.browser")}>
              <span className="font-mono">{`${browser.browser.name} ${browser.browser.version.split(".")[0] ?? ""}`}</span>
              <span className="text-[12.5px] text-faint">{baseImage === null ? t("environment.app.browser.baseImage") : t("environment.app.browser.theImage")}</span>
            </AppRow>
            <AppRow label={t("environment.app.browser.lastSeen")}>
              {browser.runnerName === null ? null : <span className="font-mono">{browser.runnerName}</span>}
              <span className="text-[12.5px] text-faint">{`· ${t("environment.ago", { age: formatAge(browser.at, now) })}`}</span>
            </AppRow>
            <AppRow label={t("environment.app.browser.logs")}><span className="truncate font-mono text-[12.5px]">{".ostra/app/<name>.log"}</span></AppRow>
          </>
        ) : (
          <>
            <AppRow label={t("environment.app.browser.browser")}><span>{t("environment.app.browser.none")}</span></AppRow>
            {baseImage === null ? null : <AppRow label={t("environment.app.browser.image")}><span className="truncate font-mono">{baseImage}</span></AppRow>}
            <AppRow label={t("environment.app.browser.lastSeen")}>
              {browser.runnerName === null ? null : <span className="font-mono">{browser.runnerName}</span>}
              <span className="text-[12.5px] text-faint">{`· ${t("environment.ago", { age: formatAge(browser.at, now) })}`}</span>
            </AppRow>
          </>
        )}
      </AppGroup>
    </div>
  );
};
