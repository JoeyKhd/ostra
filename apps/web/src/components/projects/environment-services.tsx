"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BanIcon, GripVerticalIcon, PlusIcon, RefreshCwIcon, ServerIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot, Status } from "@/components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import {
  agoShort,
  healthOf,
  moved,
  poolsText,
  runnerNote,
  shortDigest,
  snapshotFailureText,
  snapshotReasonText,
  timeoutText,
  variablesText,
} from "./environment-services-words";

// The environment's Services and checks tab, and its snapshot in the properties panel
// (environment-services.md; milestone 3's ticket 48; F-094, F-054, F-051). Services and checks save
// one at a time from their sheet, never with the Setup tab's edits. A service's secret is never
// shown back: it reads `set`.

type View = RouterOutputs["environments"]["get"];
type ServiceView = RouterOutputs["environments"]["services"]["list"][number];
type CheckView = RouterOutputs["environments"]["checks"]["list"][number];
type SnapshotView = RouterOutputs["environments"]["snapshot"]["get"];

const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[0-9a-f]{64})?$/;

/** A section of the tab: the title line with its count and inline note, then the body. */
const Section = ({ title, count, note, first = false, children, label }: { readonly title: string; readonly count?: number | undefined; readonly note: string; readonly first?: boolean; readonly label: string; readonly children: ReactNode }) => (
  <section aria-label={label} className={first ? "mt-6" : "mt-7"}>
    <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="flex items-baseline gap-2.5 text-body font-semibold">
        {title}
        {count === undefined ? null : <span className="font-mono text-sm font-normal text-faint">{count}</span>}
      </h2>
      <span className="text-[12.5px] text-muted">{note}</span>
    </div>
    {children}
  </section>
);

const None = () => <span className="text-faint">{t("environment.svc.none")}</span>;

/** The ghost × at a row's end: `--faint`, `--red` on hover. */
const RemoveButton = ({ label, onClick }: { readonly label: string; readonly onClick: () => void }) => (
  <button
    type="button"
    aria-label={label}
    className="inline-grid size-6 place-items-center rounded-sm text-faint hover:bg-raise hover:text-red"
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    onKeyDown={(event) => { event.stopPropagation(); }}
  >
    <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
  </button>
);

const AddButton = ({ children, onClick }: { readonly children: ReactNode; readonly onClick: () => void }) => (
  <Button size="sm" variant="ghost" className="mt-2 h-6 px-1.5 [&_svg]:size-[13px]" onClick={onClick}>
    <PlusIcon aria-hidden /> {children}
  </Button>
);

/** A row that opens its item: click or Enter. */
const openProps = (open: () => void, label: string) => ({
  tabIndex: 0,
  "aria-label": label,
  className: "cursor-pointer hover:bg-raise focus-visible:bg-raise focus-visible:outline-none",
  onClick: open,
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      open();
    }
  },
});

const LastBox = ({ service }: { readonly service: ServiceView }) => {
  const health = healthOf(service.lastBox);
  if (health === null || service.lastBox === null) return <span className="text-faint">{t("environment.svc.notRunYet")}</span>;
  const { lastBox } = service;
  const where =
    lastBox.runnerName === null ? t("environment.svc.onBox", { age: agoShort(lastBox.at) }) : t("environment.svc.onRunner", { runner: lastBox.runnerName, age: agoShort(lastBox.at) });
  return (
    <Tooltip content={lastBox.reason === null ? where : `${where} · ${lastBox.reason}`}>
      <span className="inline-flex min-w-0 items-center gap-[7px] whitespace-nowrap" data-health={lastBox.state}>
        <Dot tone={health.tone} />
        <span className="font-mono text-[12.5px] text-text">{health.word}</span>
        {health.extra === null ? null : <span className="truncate font-mono text-sm text-faint">{health.extra}</span>}
      </span>
    </Tooltip>
  );
};

// ---------- the service sheet ----------

type VariableRow = { readonly key: string; readonly kind: "plain" | "secret"; readonly name: string; readonly value: string; readonly stored: boolean };

let rowCounter = 0;
const rowKey = (): string => {
  rowCounter += 1;
  return `svc-var-${String(rowCounter)}`;
};

const ServiceSheet = ({
  projectId,
  service,
  admin,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly service: ServiceView | null;
  readonly admin: boolean;
  readonly onClose: () => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState(service?.name ?? "");
  const [image, setImage] = useState(service?.image ?? "");
  const [port, setPort] = useState(service?.port === null || service === null ? "" : String(service.port));
  const [healthCheck, setHealthCheck] = useState(service?.healthCheck ?? "");
  const [variables, setVariables] = useState<VariableRow[]>(
    (service?.variables ?? []).map((variable) =>
      variable.kind === "plain"
        ? { key: rowKey(), kind: "plain", name: variable.name, value: variable.value, stored: false }
        : { key: rowKey(), kind: "secret", name: variable.name, value: "", stored: true },
    ),
  );
  const [touched, setTouched] = useState(false);
  const save = useMutation(
    trpc.environments.services.save.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.environments.services.list.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.environments.get.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.environments.snapshot.get.queryKey({ projectId }) }),
        ]);
        onClose();
      },
    }),
  );
  const nameError = touched && !SERVICE_NAME.test(name) ? t("environment.svc.nameError") : save.error?.data?.code === "CONFLICT" ? save.error.message : null;
  const imageError = touched && !IMAGE.test(image.trim()) ? t("environment.svc.imageError") : null;
  const failed = service?.lastBox?.state === "failed" ? service.lastBox : null;
  const update = (key: string, change: Partial<VariableRow>) => {
    setVariables((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };
  const submit = () => {
    setTouched(true);
    if (!SERVICE_NAME.test(name) || !IMAGE.test(image.trim())) return;
    save.mutate({
      projectId,
      ...(service === null ? {} : { serviceId: service.serviceId }),
      name,
      image: image.trim(),
      port: port.trim() === "" ? null : Number(port),
      healthCheck: healthCheck.trim() === "" ? null : healthCheck.trim(),
      variables: variables
        .filter((row) => row.name.trim() !== "")
        .map((row) =>
          row.kind === "plain"
            ? { kind: "plain" as const, name: row.name.trim(), value: row.value }
            : { kind: "secret" as const, name: row.name.trim(), ...(row.value === "" ? {} : { value: row.value }) },
        ),
    });
  };
  const host = `${name === "" ? "db" : name}${port.trim() === "" ? "" : `:${port.trim()}`}`;
  return (
    <SheetContent title={service?.name ?? t("environment.svc.newTitle")} className="w-[min(420px,92vw)] gap-0 overflow-y-auto p-5">
      <h2 className="mb-4 font-mono text-body font-semibold">{service?.name ?? <span className="font-sans">{t("environment.svc.newTitle")}</span>}</h2>
      {failed === null ? null : (
        <p role="status" className="mb-3.5 text-ui text-red">
          {t("environment.svc.failedOn", { runner: failed.runnerName ?? "–", age: agoShort(failed.at), reason: failed.reason ?? "" })}
        </p>
      )}
      <Field id={`${id}-name`} label={t("environment.svc.name")} help={t("environment.svc.nameHelp", { host })} error={nameError}>
        <Input id={`${id}-name`} className="font-mono" value={name} disabled={!admin} placeholder="db" onChange={(e) => { setName(e.target.value.toLowerCase()); }} />
      </Field>
      <Field id={`${id}-image`} label={t("environment.svc.image")} error={imageError}>
        <Input id={`${id}-image`} className="font-mono" value={image} disabled={!admin} placeholder="postgres:17" onChange={(e) => { setImage(e.target.value); }} />
      </Field>
      <Field id={`${id}-port`} label={t("environment.svc.portLabel")}>
        <Input id={`${id}-port`} type="number" min={1} max={65535} className="w-28 font-mono" value={port} disabled={!admin} onChange={(e) => { setPort(e.target.value); }} />
      </Field>
      <div className="mb-3.5">
        <div className="mb-1.5 text-sm font-medium text-muted">{t("environment.svc.variablesLabel")}</div>
        <ul className="space-y-1.5">
          {variables.map((row) => (
            <li key={row.key} className="flex items-center gap-1.5" data-kind={row.kind}>
              <input
                aria-label={t("environment.svc.variableName")}
                className="h-[30px] w-[140px] min-w-0 rounded-md border border-line-2 bg-surface px-2 font-mono text-ui text-text outline-none placeholder:text-faint focus-visible:border-faint disabled:opacity-70"
                value={row.name}
                placeholder="NAME"
                disabled={!admin}
                onChange={(e) => { update(row.key, { name: e.target.value.toUpperCase() }); }}
              />
              <input
                aria-label={t("environment.svc.variableValue")}
                type={row.kind === "secret" ? "password" : "text"}
                autoComplete="off"
                className="h-[30px] min-w-0 flex-1 rounded-md border border-line-2 bg-surface px-2 font-mono text-ui text-text outline-none placeholder:text-faint focus-visible:border-faint disabled:opacity-70"
                value={row.value}
                placeholder={row.kind === "secret" ? (row.stored ? t("environment.svc.secretSet") : t("environment.svc.secretNew")) : ""}
                disabled={!admin}
                onChange={(e) => { update(row.key, { value: e.target.value }); }}
              />
              {admin ? <RemoveButton label={t("environment.svc.removeVariable")} onClick={() => { setVariables((current) => current.filter((item) => item.key !== row.key)); }} /> : null}
            </li>
          ))}
        </ul>
        {admin ? (
          <div className="mt-1 flex gap-1">
            <AddButton onClick={() => { setVariables((current) => [...current, { key: rowKey(), kind: "plain", name: "", value: "", stored: false }]); }}>{t("environment.svc.addVariable")}</AddButton>
            <AddButton onClick={() => { setVariables((current) => [...current, { key: rowKey(), kind: "secret", name: "", value: "", stored: false }]); }}>{t("environment.svc.addSecret")}</AddButton>
          </div>
        ) : null}
      </div>
      <Field id={`${id}-health`} label={t("environment.svc.healthCheckLabel")} help={t("environment.svc.healthCheckHelp")}>
        <Input id={`${id}-health`} className="font-mono" value={healthCheck} disabled={!admin} placeholder="pg_isready -U app" onChange={(e) => { setHealthCheck(e.target.value); }} />
      </Field>
      {save.error === null || save.error.data?.code === "CONFLICT" ? null : <p role="alert" className="mb-2 text-ui text-red">{errorText(save.error)}</p>}
      {admin ? (
        <>
          <div className="mt-1 flex gap-2">
            <Button onClick={onClose}>{t("environment.svc.cancel")}</Button>
            <Button variant="primary" disabled={save.isPending} onClick={submit}>{save.isPending ? t("environment.svc.saving") : t("environment.svc.save")}</Button>
          </div>
          <p className="mt-2 text-sm text-faint">{t("environment.svc.rebuildNote")}</p>
        </>
      ) : null}
    </SheetContent>
  );
};

// ---------- the check sheet ----------

const ROOT = "workspace-root";

const CheckSheet = ({
  projectId,
  check,
  repos,
  admin,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly check: CheckView | null;
  readonly repos: View["repos"];
  readonly admin: boolean;
  readonly onClose: () => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const initialSeconds = check?.timeoutSeconds ?? 600;
  const [name, setName] = useState(check?.name ?? "");
  const [command, setCommand] = useState(check?.command ?? "");
  const [repo, setRepo] = useState<string>(check?.repoId ?? (check === null ? (repos[0]?.repoId ?? ROOT) : ROOT));
  const [unit, setUnit] = useState<"min" | "s">(initialSeconds % 60 === 0 ? "min" : "s");
  const [amount, setAmount] = useState(String(initialSeconds % 60 === 0 ? initialSeconds / 60 : initialSeconds));
  const save = useMutation(
    trpc.environments.checks.save.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.environments.checks.list.queryKey({ projectId }) });
        onClose();
      },
    }),
  );
  const seconds = Math.round(Number(amount) * (unit === "min" ? 60 : 1));
  const submit = () => {
    const repoId = repos.find((candidate) => candidate.repoId === repo)?.repoId ?? null;
    save.mutate({ projectId, ...(check === null ? {} : { checkId: check.checkId }), name: name.trim(), command: command.trim(), repoId, timeoutSeconds: seconds });
  };
  return (
    <SheetContent title={check?.name ?? t("environment.chk.newTitle")} className="w-[min(420px,92vw)] gap-0 overflow-y-auto p-5">
      <h2 className="mb-4 font-mono text-body font-semibold">{check?.name ?? <span className="font-sans">{t("environment.chk.newTitle")}</span>}</h2>
      <Field id={`${id}-name`} label={t("environment.chk.name")} error={save.error?.data?.code === "CONFLICT" ? save.error.message : null}>
        <Input id={`${id}-name`} className="font-mono" value={name} disabled={!admin} placeholder="typecheck" onChange={(e) => { setName(e.target.value); }} />
      </Field>
      <Field id={`${id}-command`} label={t("environment.chk.commandLabel")}>
        <Textarea id={`${id}-command`} rows={3} spellCheck={false} className="font-mono text-ui" value={command} disabled={!admin} placeholder="pnpm typecheck" onChange={(e) => { setCommand(e.target.value); }} />
      </Field>
      <Field id={`${id}-repo`} label={t("environment.chk.repoLabel")}>
        <Select value={repo} disabled={!admin} onValueChange={setRepo}>
          <SelectTrigger id={`${id}-repo`} className="w-full font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {repos.map((candidate) => (
              <SelectItem key={candidate.repoId} value={candidate.repoId} className="font-mono">{candidate.fullName}</SelectItem>
            ))}
            <SelectItem value={ROOT}>{t("environment.chk.workspaceRootOption")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field id={`${id}-timeout`} label={t("environment.chk.timeoutLabel")}>
        <div className="flex gap-2">
          <Input id={`${id}-timeout`} type="number" min={1} className="w-24 font-mono" value={amount} disabled={!admin} onChange={(e) => { setAmount(e.target.value); }} />
          <Select value={unit} disabled={!admin} onValueChange={(value) => { setUnit(value === "s" ? "s" : "min"); }}>
            <SelectTrigger aria-label={t("environment.chk.timeoutLabel")} className="w-20 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="min">{t("environment.chk.unitMinutes")}</SelectItem>
              <SelectItem value="s">{t("environment.chk.unitSeconds")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Field>
      {save.error === null || save.error.data?.code === "CONFLICT" ? null : <p role="alert" className="mb-2 text-ui text-red">{errorText(save.error)}</p>}
      {admin ? (
        <div className="mt-1 flex gap-2">
          <Button onClick={onClose}>{t("environment.svc.cancel")}</Button>
          <Button variant="primary" disabled={save.isPending || name.trim() === "" || command.trim() === "" || !(seconds > 0)} onClick={submit}>
            {save.isPending ? t("environment.svc.saving") : t("environment.chk.save")}
          </Button>
        </div>
      ) : null}
    </SheetContent>
  );
};

// ---------- the tab ----------

type Editing = { readonly kind: "service"; readonly service: ServiceView | null } | { readonly kind: "check"; readonly check: CheckView | null } | null;
type Removing = { readonly kind: "service"; readonly service: ServiceView } | { readonly kind: "check"; readonly check: CheckView } | null;

const rowSkeletons = (columns: number) =>
  [0, 1, 2].map((i) => (
    <TableRow key={i}>
      <TableCell colSpan={columns} className="h-10">
        <Skeleton className="w-2/3" />
      </TableCell>
    </TableRow>
  ));

/**
 * The Services and checks tab: the services (with their health on the last box and the runner
 * rule), the checks in their order, and the footnote. Rows open their sheet; admins add, remove
 * and reorder.
 */
export const ServicesAndChecks = ({ projectId, view, admin }: { readonly projectId: ProjectId; readonly view: View; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const services = useQuery(trpc.environments.services.list.queryOptions({ projectId }));
  const checks = useQuery(trpc.environments.checks.list.queryOptions({ projectId }));
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const [order, setOrder] = useState<readonly CheckView[] | null>(null);
  const [announce, setAnnounce] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.environments.services.list.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.checks.list.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.get.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.environments.snapshot.get.queryKey({ projectId }) }),
    ]);
  };
  const removeService = useMutation(trpc.environments.services.delete.mutationOptions({ onSuccess: invalidate }));
  const removeCheck = useMutation(trpc.environments.checks.delete.mutationOptions({ onSuccess: invalidate }));
  const reorder = useMutation(
    trpc.environments.checks.reorder.mutationOptions({
      onSuccess: async (saved) => {
        queryClient.setQueryData(trpc.environments.checks.list.queryKey({ projectId }), saved);
        setOrder(null);
        await invalidate();
      },
      // The old order comes back, with the error line under the table.
      onError: () => { setOrder(null); },
    }),
  );

  const shown = order ?? checks.data ?? [];
  const move = (from: number, to: number) => {
    if (to < 0 || to >= shown.length || from === to) return;
    const next = moved(shown, from, to);
    const item = shown[from];
    setOrder(next);
    if (item !== undefined) setAnnounce(t("environment.chk.moved", { name: item.name, position: to + 1, count: next.length }));
    reorder.mutate({ projectId, checkIds: next.map((check) => check.checkId) });
  };
  const note = runnerNote(view.whereTasksRun);
  const reorderable = admin && shown.length > 1;

  return (
    <div>
      <Section first title={t("environment.svc.title")} count={services.data?.length} note={t("environment.svc.note")} label={t("environment.svc.title")}>
        <Table aria-label={t("environment.svc.title")} className="text-ui">
          <colgroup>
            <col />
            <col className="w-[70px]" />
            <col className="hidden w-[110px] min-[900px]:table-column" />
            <col className="hidden w-[150px] min-[900px]:table-column" />
            <col className="w-[130px]" />
            <col className="w-[28px]" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-1.5">{t("environment.svc.service")}</TableHead>
              <TableHead>{t("environment.svc.port")}</TableHead>
              <TableHead className="hidden min-[900px]:table-cell">{t("environment.svc.variables")}</TableHead>
              <TableHead className="hidden min-[900px]:table-cell">{t("environment.svc.healthCheck")}</TableHead>
              <TableHead>{t("environment.svc.lastBox")}</TableHead>
              <TableHead><span className="sr-only">{t("common.remove")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.data === undefined ? rowSkeletons(6) : null}
            {services.data?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-10 pl-1.5 text-faint">{t("environment.svc.empty")}</TableCell>
              </TableRow>
            ) : null}
            {services.data?.map((service) => (
              <TableRow key={service.serviceId} data-service={service.name} {...openProps(() => { setEditing({ kind: "service", service }); }, service.name)}>
                <TableCell className="h-10 pl-1.5 pr-3">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="shrink-0 font-mono text-body text-text">{service.name}</span>
                    <span className="truncate font-mono text-sm text-faint" title={service.image}>{service.image}</span>
                  </span>
                </TableCell>
                <TableCell className="h-10 font-mono text-[12.5px] text-text">{service.port ?? <None />}</TableCell>
                <TableCell className="hidden h-10 text-[12.5px] text-muted min-[900px]:table-cell">{variablesText(service.variables) ?? <None />}</TableCell>
                <TableCell className="hidden h-10 pr-3 min-[900px]:table-cell">
                  {service.healthCheck === null ? <None /> : <span className="block truncate font-mono text-[12.5px] text-muted" title={service.healthCheck}>{service.healthCheck}</span>}
                </TableCell>
                <TableCell className="h-10"><LastBox service={service} /></TableCell>
                <TableCell className="h-10 text-right">
                  {admin ? <RemoveButton label={t("environment.svc.remove", { name: service.name })} onClick={() => { setRemoving({ kind: "service", service }); }} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {admin ? <AddButton onClick={() => { setEditing({ kind: "service", service: null }); }}>{t("environment.svc.add")}</AddButton> : null}
        {note === null ? null : note.kind === "note" ? (
          <p className="mt-2 flex items-start gap-2 text-[12.5px] text-muted" data-testid="services-runner-note">
            <ServerIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-faint" />
            {note.text}
          </p>
        ) : (
          <div role="status" data-testid="services-blocked" className="mt-3 flex gap-2.5 border-l-2 border-red bg-surface p-3">
            <BanIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-red" />
            <div>
              <p className="text-body font-semibold text-text">{t("environment.svc.blockedTitle")}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">{note.detail}</p>
            </div>
          </div>
        )}
        {removeService.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(removeService.error)}</p>}
      </Section>

      <Section title={t("environment.chk.title")} count={checks.data?.length} note={t("environment.chk.note")} label={t("environment.chk.title")}>
        <Table aria-label={t("environment.chk.title")} className="text-ui">
          <colgroup>
            <col className="w-[24px]" />
            <col className="w-[24px]" />
            <col className="w-[120px]" />
            <col />
            <col className="hidden w-[170px] min-[900px]:table-column" />
            <col className="w-[70px]" />
            <col className="w-[28px]" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead><span className="sr-only">{t("environment.chk.handle", { name: "" })}</span></TableHead>
              <TableHead>{t("environment.chk.number")}</TableHead>
              <TableHead>{t("environment.chk.name")}</TableHead>
              <TableHead>{t("environment.chk.command")}</TableHead>
              <TableHead className="hidden min-[900px]:table-cell">{t("environment.chk.repo")}</TableHead>
              <TableHead>{t("environment.chk.timeout")}</TableHead>
              <TableHead><span className="sr-only">{t("common.remove")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.data === undefined ? rowSkeletons(7) : null}
            {checks.data?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-10 pl-1.5 text-faint">{t("environment.chk.empty")}</TableCell>
              </TableRow>
            ) : null}
            {shown.map((check, index) => (
              <TableRow
                key={check.checkId}
                data-check={check.name}
                {...openProps(() => { setEditing({ kind: "check", check }); }, check.name)}
                {...(reorderable
                  ? {
                      onDragOver: (event: DragEvent<HTMLTableRowElement>) => { event.preventDefault(); },
                      onDrop: (event: DragEvent<HTMLTableRowElement>) => {
                        event.preventDefault();
                        if (dragging !== null) move(dragging, index);
                        setDragging(null);
                      },
                    }
                  : {})}
                className={cn("cursor-pointer hover:bg-raise focus-visible:bg-raise focus-visible:outline-none", dragging === index && "opacity-50")}
              >
                <TableCell className="h-10">
                  {reorderable ? (
                    <button
                      type="button"
                      draggable
                      aria-label={t("environment.chk.handle", { name: check.name })}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      className="hidden size-5 cursor-grab place-items-center rounded-sm align-middle text-faint hover:text-muted sm:inline-grid"
                      onClick={(event) => { event.stopPropagation(); }}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(index);
                      }}
                      onDragEnd={() => { setDragging(null); }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                        event.preventDefault();
                        move(index, event.key === "ArrowUp" ? index - 1 : index + 1);
                      }}
                    >
                      <GripVerticalIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                    </button>
                  ) : null}
                </TableCell>
                <TableCell className="h-10 font-mono text-[12.5px] text-muted">{index + 1}</TableCell>
                <TableCell className="h-10 truncate pr-3 font-mono text-body text-text">{check.name}</TableCell>
                <TableCell className="h-10 pr-3">
                  <span className="block truncate font-mono text-[12.5px] text-muted" title={check.command}>{check.command}</span>
                </TableCell>
                <TableCell className="hidden h-10 truncate pr-3 min-[900px]:table-cell">
                  {check.repoFullName === null ? <span className="text-[12.5px] text-faint">{t("environment.chk.workspaceRoot")}</span> : <span className="font-mono text-[12.5px] text-muted">{check.repoFullName}</span>}
                </TableCell>
                <TableCell className="h-10 font-mono text-[12.5px] text-muted">{timeoutText(check.timeoutSeconds)}</TableCell>
                <TableCell className="h-10 text-right">
                  {admin ? <RemoveButton label={t("environment.chk.remove", { name: check.name })} onClick={() => { setRemoving({ kind: "check", check }); }} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <span className="sr-only" aria-live="polite">{announce}</span>
        {reorder.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(reorder.error)}</p>}
        {removeCheck.error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{errorText(removeCheck.error)}</p>}
        {admin ? <AddButton onClick={() => { setEditing({ kind: "check", check: null }); }}>{t("environment.chk.add")}</AddButton> : null}
        <p className="mt-2 text-[12.5px] text-faint">{t("environment.chk.help")}</p>
      </Section>

      <p className="mt-[22px] flex items-start gap-2 text-[12.5px] text-muted">
        <ShieldCheckIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-faint" />
        {t("environment.footnoteServices")}
      </p>

      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        {editing?.kind === "service" ? (
          <ServiceSheet key={editing.service?.serviceId ?? "new"} projectId={projectId} service={editing.service} admin={admin} onClose={() => { setEditing(null); }} />
        ) : editing?.kind === "check" ? (
          <CheckSheet key={editing.check?.checkId ?? "new"} projectId={projectId} check={editing.check} repos={view.repos} admin={admin} onClose={() => { setEditing(null); }} />
        ) : null}
      </Sheet>

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        {removing === null ? null : removing.kind === "service" ? (
          <AlertDialogContent
            title={t("environment.svc.removeTitle", { name: removing.service.name })}
            body={t("environment.svc.removeBody")}
            cancel={t("environment.svc.cancel")}
            action={t("environment.svc.removeAction")}
            onAction={() => { removeService.mutate({ projectId, serviceId: removing.service.serviceId }); }}
          />
        ) : (
          <AlertDialogContent
            title={t("environment.chk.removeTitle", { name: removing.check.name })}
            body={t("environment.chk.removeBody")}
            cancel={t("environment.svc.cancel")}
            action={t("environment.svc.removeAction")}
            onAction={() => { removeCheck.mutate({ projectId, checkId: removing.check.checkId }); }}
          />
        )}
      </AlertDialog>
    </div>
  );
};

// ---------- the panel ----------

const ROW_LABEL = 120;

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <PropRow label={label} labelWidth={ROW_LABEL}>
    {children}
  </PropRow>
);

/** A panel group whose label row can hold a button at its right. */
const Group = ({ title, end, children, testId }: { readonly title: string; readonly end?: ReactNode; readonly children: ReactNode; readonly testId?: string }) => (
  <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0" data-testid={testId}>
    <div className="mb-2 flex min-h-[26px] items-center">
      <h3 className="text-xs font-medium text-faint">{title}</h3>
      {end === undefined ? null : <div className="ml-auto">{end}</div>}
    </div>
    {children}
  </div>
);

const Digest = ({ digest }: { readonly digest: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <span className="group flex min-w-0 items-center gap-2">
      <span className="font-mono" title={digest}>{shortDigest(digest)}</span>
      <button
        type="button"
        className="text-sm text-teal opacity-0 hover:underline focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => {
          void copyText(digest, undefined).then((outcome) => { setCopied(outcome === "copied"); });
        }}
      >
        {copied ? "✓" : t("environment.snap.copy")}
      </button>
    </span>
  );
};

const SnapshotRows = ({ snapshot, pressed }: { readonly snapshot: SnapshotView; readonly pressed: boolean }) => {
  const { ready, pending, lastFailure } = snapshot;
  const inUse =
    ready === null ? (
      <span className="text-muted">{t("environment.snap.fullSetup")}</span>
    ) : (
      <span className="truncate">{t("environment.snap.inUseValue", { age: agoShort(ready.builtAt), runner: ready.runnerName ?? "–" })}</span>
    );
  if (pending === null && pressed) {
    return (
      <>
        <Row label={t("environment.snap.status")}><Status tone="grey">{t("environment.snap.queued")}</Status></Row>
        <Row label={t("environment.snap.inUse")}>{inUse}</Row>
      </>
    );
  }
  if (pending !== null) {
    return (
      <>
        <Row label={t("environment.snap.status")}>
          <Status tone="grey">
            {pending.state === "building" ? t("environment.snap.building") : t("environment.snap.queued")}
            {pending.state === "building" ? <span className="font-mono text-sm text-muted">{t("environment.snap.since", { age: agoShort(pending.since).replace(/ ago$/, "") })}</span> : null}
          </Status>
        </Row>
        {pending.runnerName === null ? null : <Row label={t("environment.snap.onRunner")}><span className="truncate font-mono">{pending.runnerName}</span></Row>}
        <Row label={t("environment.snap.why")}><span className="truncate">{snapshotReasonText(pending.reason, pending.requestedBy)}</span></Row>
        <Row label={t("environment.snap.inUse")}>{inUse}</Row>
        {snapshot.waitingForDockerRunner ? <p className="mt-1.5 text-sm text-faint">{t("environment.snap.waiting")}</p> : null}
      </>
    );
  }
  if (lastFailure !== null) {
    const [firstLine = ""] = lastFailure.detail.split("\n");
    return (
      <>
        <Row label={t("environment.snap.status")}><Status tone="red">{t("environment.snap.failed")}</Status></Row>
        <Row label={t("environment.snap.failReason")}><span className="whitespace-normal">{snapshotFailureText(lastFailure.reason)}</span></Row>
        {firstLine === "" ? null : (
          <Row label={t("environment.snap.detail")}>
            <span className="truncate font-mono text-sm text-faint" title={lastFailure.detail}>{firstLine}</span>
          </Row>
        )}
        <Row label={t("environment.snap.inUse")}>{inUse}</Row>
        {lastFailure.reason === "secret-found" ? <Row label={t("environment.snap.secretScan")}><span className="text-red">{t("environment.snap.scanFailed")}</span></Row> : null}
      </>
    );
  }
  if (ready !== null) {
    return (
      <>
        <Row label={t("environment.snap.status")}><Status tone="green">{t("environment.snap.ready")}</Status></Row>
        <Row label={t("environment.snap.built")}>
          <span className="truncate">
            {agoShort(ready.builtAt)}
            {ready.durationMs === null ? null : <> · <span className="font-mono">{formatDuration(ready.durationMs)}</span></>}
          </span>
        </Row>
        {ready.runnerName === null ? null : <Row label={t("environment.snap.onRunner")}><span className="truncate font-mono">{ready.runnerName}</span></Row>}
        <Row label={t("environment.snap.why")}><span className="truncate">{snapshotReasonText(ready.reason, ready.requestedBy)}</span></Row>
        {ready.secretScan === null ? null : (
          <Row label={t("environment.snap.secretScan")}>
            <span className={ready.secretScan === "passed" ? undefined : "text-red"}>{ready.secretScan === "passed" ? t("environment.snap.passed") : t("environment.snap.scanFailed")}</span>
          </Row>
        )}
        {ready.digest === null ? null : <Row label={t("environment.snap.digest")}><Digest digest={ready.digest} /></Row>}
      </>
    );
  }
  return (
    <>
      <Row label={t("environment.snap.status")}><span className="text-faint">{t("environment.snap.noneYet")}</span></Row>
      <p className="mt-1.5 text-sm text-faint">{t("environment.snap.noneHelp")}</p>
    </>
  );
};

/**
 * The snapshot's groups of the properties panel: the Snapshot group on both tabs (milestone 1 kept
 * its place at the top), and on the Services and checks tab, On host runners and Where tasks run.
 */
export const SnapshotProperties = ({ projectId, view, admin, servicesTab }: { readonly projectId: ProjectId; readonly view: View | undefined; readonly admin: boolean; readonly servicesTab: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    ...trpc.environments.snapshot.get.queryOptions({ projectId }),
    refetchInterval: (query) => (query.state.data?.pending === null ? false : 10_000),
  });
  // Pressed: the build is queued by the job, so until the snapshot shows it the button says so.
  const [pressed, setPressed] = useState(false);
  const rebuild = useMutation(
    trpc.environments.snapshot.rebuild.mutationOptions({
      onSuccess: async () => {
        setPressed(true);
        await queryClient.invalidateQueries({ queryKey: trpc.environments.snapshot.get.queryKey({ projectId }) });
      },
    }),
  );
  const data = snapshot.data;
  const hostOnly = data?.kind === "host-cache";
  const pending = data?.pending !== null && data?.pending !== undefined;
  useEffect(() => {
    if (pending) setPressed(false);
  }, [pending]);
  const queued = pending || pressed || rebuild.isPending;
  const where = view?.whereTasksRun;
  return (
    <>
      <Group
        title={t("environment.snap.group")}
        testId="snapshot-group"
        end={
          admin && !hostOnly && data !== undefined ? (
            <Button size="sm" disabled={queued} onClick={() => { rebuild.mutate({ projectId }); }} className="[&_svg]:size-[13px]">
              <RefreshCwIcon aria-hidden className="stroke-[1.75]" />
              {queued ? t("environment.snap.queuedButton") : t("environment.snap.rebuild")}
            </Button>
          ) : undefined
        }
      >
        {data === undefined ? (
          snapshot.error === null ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="grid h-8 grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
                <Skeleton className="w-14" />
                <Skeleton className="w-24" />
              </div>
            ))
          ) : (
            <p role="alert" className="text-ui text-red">{errorText(snapshot.error)}</p>
          )
        ) : hostOnly ? (
          <Row label={t("environment.snap.kind")}>{t("environment.snap.hostCache")}</Row>
        ) : (
          <SnapshotRows snapshot={data} pressed={pressed} />
        )}
        {rebuild.error === null ? null : <p role="alert" className="mt-1.5 text-ui text-red">{errorText(rebuild.error)}</p>}
      </Group>
      {servicesTab && !hostOnly ? (
        <Group title={t("environment.snap.hostGroup")}>
          <Row label={t("environment.snap.instead")}>{t("environment.snap.hostCache")}</Row>
          <Row label={t("environment.snap.services")}>
            <span className="inline-flex h-[22px] items-center rounded-sm border border-line-2 px-2 font-mono text-xs text-muted">{t("environment.snap.notOnHost")}</span>
          </Row>
        </Group>
      ) : null}
      {servicesTab && where !== undefined ? (
        <Group title={t("environment.snap.whereGroup")} testId="where-tasks-run">
          <Row label={t("environment.snap.pools")}>
            <span className="truncate">{where.pools.length === 0 ? t("environment.snap.none") : poolsText(where.pools.map((pool) => pool.name))}</span>
          </Row>
          <Row label={t("environment.snap.canStart")}>
            <span className="font-mono">{where.servicesRunnersOnline === 1 ? t("environment.snap.runnerOnline") : t("environment.snap.runnersOnline", { count: where.servicesRunnersOnline })}</span>
          </Row>
          <Row label={t("environment.snap.executors")}>
            <span className="truncate font-mono">{where.executorsOnline.length === 0 ? t("environment.snap.none") : where.executorsOnline.join(", ")}</span>
          </Row>
        </Group>
      ) : null}
    </>
  );
};
