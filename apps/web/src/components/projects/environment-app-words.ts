import { appProcessListIssues, appProcessListWords, appProcessSchema } from "@ostra/domain/app-processes";
import type { AppProcessForm, AppProcessListIssue } from "@ostra/domain/app-processes";
import { appAddressName, appAddresses, inBoxAppAddress, inBoxServiceAddress } from "@ostra/protocol";
import type { AppProcessReason, AppProcessState, AppReadyCheck, RepoId } from "@ostra/protocol";

import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";

// The App tab's words and rules (app-targets/m8/environment-app-processes.md; F-140, milestone 8's
// ticket 17). The editor sheet checks a process with the same schema and the same list rules the
// API runs on save (`appProcessSchema`, `appProcessListIssues`), so what it refuses is what the API
// refuses: a field that doesn't read in the target's words, under its field, and a rule the list
// breaks in the API's own words (`appProcessListWords`).

/** A ready check as the sheet edits it: the kind, and the path or command typed for each. */
export type ReadyKind = AppReadyCheck["kind"];

/** The sheet's fields, as typed. */
export type ProcessForm = {
  readonly name: string;
  readonly label: string;
  readonly repoId: string;
  readonly folder: string;
  readonly command: string;
  readonly port: string;
  readonly readyKind: ReadyKind;
  readonly readyPath: string;
  readonly readyCommand: string;
  readonly primary: boolean;
  readonly hostRewrite: boolean;
};

/** A field of the sheet that a refusal names. */
export type ProcessField = "name" | "label" | "repo" | "folder" | "command" | "port" | "ready";

/** Each field's refusal, in words; an empty map when the process reads and the list keeps its rules. */
export type ProcessIssues = Partial<Readonly<Record<ProcessField, string>>>;

/** A saved process, as the list keeps it and the API takes it back. */
export type SavedProcess = {
  readonly name: string;
  readonly repoId: RepoId;
  readonly folder: string;
  readonly command: string;
  readonly port: number;
  readonly ready: AppReadyCheck;
  readonly label: string;
  readonly primary: boolean;
  readonly hostRewrite: boolean;
};

/** The ready check the form describes. */
export const readyOf = (form: ProcessForm): AppReadyCheck => {
  switch (form.readyKind) {
    case "http":
      return { kind: "http", path: form.readyPath.trim() };
    case "command":
      return { kind: "command", command: form.readyCommand.trim() };
    case "port":
      return { kind: "port" };
    default:
      return form.readyKind satisfies never;
  }
};

/** The process the form describes, as the API's `save` takes it. Its port is a number only when typed as one. */
export const processOf = (form: ProcessForm): AppProcessForm => ({
  name: form.name.trim(),
  repoId: form.repoId,
  folder: form.folder.trim() === "" ? "." : form.folder.trim(),
  command: form.command,
  port: /^\d+$/.test(form.port.trim()) ? Number(form.port.trim()) : Number.NaN,
  ready: readyOf(form),
  label: form.label,
  primary: form.primary,
  hostRewrite: form.hostRewrite,
});

/** The form a saved process opens with. */
export const formOf = (process: Omit<SavedProcess, "repoId"> & { readonly repoId: string }): ProcessForm => ({
  name: process.name,
  label: process.label,
  repoId: process.repoId,
  folder: process.folder,
  command: process.command,
  port: String(process.port),
  readyKind: process.ready.kind,
  readyPath: process.ready.kind === "http" ? process.ready.path : "/",
  readyCommand: process.ready.kind === "command" ? process.ready.command : "",
  primary: process.primary,
  hostRewrite: process.hostRewrite,
});

/** A new process's empty form, in the first repo. */
export const emptyForm = (repoId: string, primary: boolean): ProcessForm => ({
  name: "",
  label: "",
  repoId,
  folder: ".",
  command: "",
  port: "",
  readyKind: "http",
  readyPath: "/",
  readyCommand: "",
  primary,
  hostRewrite: true,
});

/** A field's refusal when it doesn't read, in the target's words (environment-app-processes.md, "The refusals"). */
const fieldWords = (field: ProcessField, form: ProcessForm): string => {
  switch (field) {
    case "name":
      return t("environment.app.refuse.name");
    case "label":
      return t("environment.app.refuse.label");
    case "repo":
      return t("environment.app.refuse.repo");
    case "folder":
      return t("environment.app.refuse.folder");
    case "command":
      return t("environment.app.refuse.command");
    case "port": {
      const port = Number(form.port.trim());
      return /^\d+$/.test(form.port.trim()) && port >= 1 && port < 1024 ? t("environment.app.refuse.portLow") : t("environment.app.refuse.port");
    }
    case "ready":
      return form.readyKind === "command" ? t("environment.app.refuse.readyCommand") : t("environment.app.refuse.readyPath");
    default:
      return field satisfies never;
  }
};

/** The field a schema issue's path names. */
const fieldOfPath = (path: readonly PropertyKey[]): ProcessField | null => {
  const [first] = path;
  switch (first) {
    case "name":
    case "label":
    case "folder":
    case "command":
    case "port":
    case "ready":
      return first;
    case "repoId":
      return "repo";
    case undefined:
    default:
      return null;
  }
};

/** The field a rule the list breaks is about. */
const fieldOfRule = (issue: AppProcessListIssue): ProcessField | null => {
  switch (issue.rule) {
    case "unique-name":
      return "name";
    case "unique-port":
    case "reserved-port":
      return "port";
    case "unknown-repo":
      return "repo";
    case "one-primary":
      // The sheet never breaks it: turning "The primary preview" on moves it here.
      return null;
    default:
      return issue satisfies never;
  }
};

/**
 * What the API would refuse of this process in this list: each field that doesn't read
 * (`appProcessSchema`), then each rule the list with it breaks (`appProcessListIssues`, over the
 * others as they are, with the primary moved here when this one is). `others` are the list's other
 * processes; `repoIds` the project's repos.
 */
export const processFormIssues = (form: ProcessForm, others: readonly SavedProcess[], repoIds: readonly RepoId[]): ProcessIssues => {
  const issues: Partial<Record<ProcessField, string>> = {};
  const parsed = appProcessSchema.safeParse(processOf(form));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOfPath(issue.path);
      if (field !== null) issues[field] ??= fieldWords(field, form);
    }
    return issues;
  }
  const list = [...others.map((other) => (form.primary ? { ...other, primary: false } : other)), parsed.data];
  for (const issue of appProcessListIssues(list, repoIds)) {
    const field = fieldOfRule(issue);
    if (field !== null) issues[field] ??= appProcessListWords(issue);
  }
  return issues;
};

/**
 * The list the API saves with this process in it: in the place of the one it edits (`replacing`),
 * else at the end, the primary moved here when it is one. `list` is the whole saved list.
 */
export const listWith = (list: readonly SavedProcess[], process: SavedProcess, replacing: string | null): SavedProcess[] => {
  const moved = list.map((other) => (process.primary && other.name !== replacing ? { ...other, primary: false } : other));
  const at = replacing === null ? -1 : moved.findIndex((other) => other.name === replacing);
  return at < 0 ? [...moved, process] : moved.map((other, index) => (index === at ? process : other));
};

/** A rule the API's `save` refused, back on the field it's about. */
export const issuesFromRules = (issues: readonly { readonly rule: AppProcessListIssue["rule"]; readonly message: string }[]): ProcessIssues => {
  const out: Partial<Record<ProcessField, string>> = {};
  for (const issue of issues) {
    const field = issue.rule === "unique-name" ? "name" : issue.rule === "unknown-repo" ? "repo" : issue.rule === "one-primary" ? null : "port";
    if (field !== null) out[field] ??= issue.message;
  }
  return out;
};

/** `HTTP /health`, `Command pnpm check`, `Port open`: the table's "Ready when" (the words, then the mono part). */
export const readyWords = (ready: AppReadyCheck): { readonly words: string; readonly mono: string | null } => {
  switch (ready.kind) {
    case "http":
      return { words: t("environment.app.ready.http"), mono: ready.path };
    case "command":
      return { words: t("environment.app.ready.command"), mono: ready.command };
    case "port":
      return { words: t("environment.app.ready.port"), mono: null };
    default:
      return ready satisfies never;
  }
};

/** `calculator-web/api`: the repo's short name, with the folder when it isn't the root. */
export const whereText = (repoFullName: string, folder: string): string => {
  const short = repoFullName.split("/").at(-1) ?? repoFullName;
  return folder === "." || folder === "" ? short : `${short}/${folder}`;
};

/** How a process did on the last box: a word, its tone and the time it took to get ready. */
export const lastBoxWords = (
  lastBox: { readonly state: AppProcessState; readonly exitCode: number | null; readonly reason: AppProcessReason | null; readonly readyAfterMs: number | null } | null,
): { readonly word: string; readonly tone: "green" | "red" | null; readonly extra: string | null } => {
  if (lastBox === null) return { word: t("environment.app.last.notRunYet"), tone: null, extra: null };
  switch (lastBox.state) {
    case "ready":
      return { word: t("environment.app.last.ready"), tone: "green", extra: lastBox.readyAfterMs === null ? null : t("environment.app.last.seconds", { n: Math.max(1, Math.round(lastBox.readyAfterMs / 1000)) }) };
    case "exited":
    case "failed":
      return lastBox.reason === "ready-timeout"
        ? { word: t("environment.app.last.didntAnswer"), tone: "red", extra: null }
        : { word: lastBox.exitCode === null ? t("environment.app.last.failed") : t("environment.app.last.exited", { code: lastBox.exitCode }), tone: "red", extra: null };
    case "starting":
      return { word: t("environment.app.last.starting"), tone: null, extra: null };
    case "stopped":
      return { word: t("environment.app.last.stopped"), tone: null, extra: null };
    default:
      return lastBox.state satisfies never;
  }
};

/** `On build-01, 2h ago`: where and when the last box ran it. */
export const lastBoxWhere = (runnerName: string | null, at: number, now: number = Date.now()): string => {
  const age = formatAge(at, now);
  return runnerName === null ? t("environment.app.last.onBox", { age }) : t("environment.app.last.onRunner", { runner: runnerName, age });
};

/** The in-box addresses the panel lists: each process's, then each service's on `docker` (the kubernetes one in its tooltip). */
export const addressRows = (
  processes: readonly { readonly name: string; readonly port: number }[],
  services: readonly { readonly name: string; readonly port: number | null }[],
): readonly { readonly name: string; readonly value: string; readonly other: string | null; readonly kind: "app" | "service" }[] => {
  const docker = appAddresses(processes, services, "docker");
  return [
    ...processes.map((process) => ({ name: appAddressName(process.name), value: inBoxAppAddress(process.port), other: null, kind: "app" as const })),
    ...services.flatMap((service) => {
      const name = appAddressName(service.name, "service");
      const value = docker[name];
      return value === undefined ? [] : [{ name, value, other: inBoxServiceAddress(service, "kubernetes"), kind: "service" as const }];
    }),
  ];
};

/** What a process's sheet says of its addresses: the others' it gets, and where they reach it. */
export const addressesNote = (name: string, port: string, others: readonly { readonly name: string }[], serviceCount: number): string => {
  const own = appAddressName(name.trim() === "" ? "app" : name.trim());
  const at = /^\d+$/.test(port.trim()) ? inBoxAppAddress(Number(port.trim())) : t("environment.app.sheet.noPortYet");
  const theirs = others.map((other) => appAddressName(other.name));
  const gets =
    theirs.length === 0
      ? t("environment.app.sheet.getsServices", { n: serviceCount })
      : t("environment.app.sheet.gets", { names: theirs.join(", "), n: serviceCount });
  return `${gets} ${t("environment.app.sheet.reachedAt", { name: own, address: at })}`;
};

/** A detected process's key for "Ignore": its repo, name, file and command, so a change to the file shows it again. */
export const ignoreKey = (projectId: string, entry: { readonly repoId: string; readonly process: { readonly name: string; readonly source: string; readonly command: string | null; readonly port: number } }): string =>
  `ostra:app-ignored:${projectId}:${entry.repoId}:${entry.process.name}:${entry.process.source}:${String(entry.process.port)}:${entry.process.command ?? ""}`;
