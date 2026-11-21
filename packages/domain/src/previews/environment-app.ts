import type { Db, Tx } from "@ostra/db";
import {
  environmentIdSchema,
  environmentProposalIdSchema,
  environmentProposalSchema,
  organizationIdSchema,
  previewRefusalWords,
  projectIdSchema,
  repoIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { EnvironmentProposal, OrganizationId, ProjectId, RepoId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { DetectedAppProcess } from "../environment/detect-app.ts";
import type { ProposeAppProcess, SaveAppProcesses } from "../use-cases/m8-preview-signatures.ts";
import { createNeedsYouItemInTx } from "../use-cases/needs-you-items.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { appProcessListIssues, appProcessListWords, appProcessSchema, appProcessToRow, screenshotSettingsSchema, servicePreviewLabelSchema, specAppProcesses } from "./app-processes.ts";
import type { AppProcess, AppProcessListIssue, AppProcessRow } from "./app-processes.ts";

// An environment's app processes as core keeps them (milestone 8, F-140, ADR 0068; ticket 15): the
// rows, a project admin's save, a proposal's processes merged in on "Accept", "Keep it" on a port
// the agent announced, the list the environment page shows with detection's processes marked, and
// whether a task's runner can run them at all. A process's command is never logged: the audit
// entries name processes and fields, never a command's text.

type SaveResult = Awaited<ReturnType<SaveAppProcesses>>;
type KeepResult = Awaited<ReturnType<ProposeAppProcess>>;

/** The environment an app process belongs to. */
export type AppEnvironment = { readonly id: string; readonly organizationId: OrganizationId; readonly projectId: ProjectId };

/** The environment's app process rows, in their order. */
export const appProcessRowsInTx = (tx: Pick<Tx, "appProcess">, environmentId: string): Promise<readonly AppProcessRow[]> =>
  tx.appProcess.findMany({
    where: { environmentId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { name: true, repoId: true, folder: true, command: true, port: true, readyKind: true, readyValue: true, label: true, primary: true, hostRewrite: true, position: true },
  });

/** The environment's app processes, in their order; a row that no longer parses is left out. */
export const appProcessesInTx = async (tx: Pick<Tx, "appProcess">, environmentId: string): Promise<readonly AppProcess[]> =>
  specAppProcesses(await appProcessRowsInTx(tx, environmentId));

/** Replaces the environment's app processes with `processes`, in their order, in the caller's transaction. */
export const writeAppProcessesInTx = async (tx: Pick<Tx, "appProcess">, environment: AppEnvironment, processes: readonly AppProcess[]): Promise<void> => {
  await tx.appProcess.deleteMany({ where: { environmentId: environment.id } });
  if (processes.length === 0) {
    return;
  }
  await tx.appProcess.createMany({
    data: processes.map((process, position) => ({
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
      ...appProcessToRow(process, position),
    })),
  });
};

/**
 * A proposal's processes merged into the environment's (F-113, F-140): each proposed process takes
 * the place of the one of the same name or the same port, the rest are kept, and a new one goes at
 * the end. A proposed primary is the primary: the one the environment had loses it.
 */
export const mergeAppProcesses = (existing: readonly AppProcess[], proposed: readonly AppProcess[]): readonly AppProcess[] => {
  const proposedPrimary = proposed.some((process) => process.primary);
  const placed = new Set<number>();
  const merged: AppProcess[] = [];
  for (const process of existing) {
    const index = proposed.findIndex((one) => one.name === process.name || one.port === process.port);
    const replacement = index === -1 ? undefined : proposed[index];
    if (replacement === undefined) {
      merged.push(proposedPrimary ? { ...process, primary: false } : process);
    } else if (!placed.has(index)) {
      placed.add(index);
      merged.push(replacement);
    }
  }
  proposed.forEach((process, index) => {
    if (!placed.has(index)) {
      merged.push(process);
    }
  });
  return merged;
};

/** The first rule a list breaks, in the form's words, or `null`: the rules, the repos and the cap. */
export const appProcessListRefusal = (processes: readonly AppProcess[], repoIds: readonly RepoId[]): { readonly message: string; readonly issues: readonly AppProcessListIssue[] } | null => {
  if (processes.length > runnerLimits.appProcessesMax) {
    return { message: `An environment has at most ${String(runnerLimits.appProcessesMax)} app processes`, issues: [] };
  }
  const issues = appProcessListIssues(processes, repoIds);
  const [first] = issues;
  return first === undefined ? null : { message: appProcessListWords(first), issues };
};

/**
 * What changed between two lists, by name and field, and whether the ones in both moved (the start
 * order): the audit entry's words, never a command's text.
 */
export const appProcessChanges = (
  before: readonly AppProcess[],
  after: readonly AppProcess[],
): { readonly added: string; readonly removed: string; readonly changed: string; readonly reordered: boolean } => {
  const fields = ["repoId", "folder", "command", "port", "ready", "label", "primary", "hostRewrite"] as const;
  const changed = after.flatMap((process) => {
    const old = before.find((one) => one.name === process.name);
    if (old === undefined) {
      return [];
    }
    const differ = fields.filter((field) => JSON.stringify(old[field]) !== JSON.stringify(process[field]));
    return differ.length === 0 ? [] : [`${process.name}:${differ.join("+")}`];
  });
  return {
    added: after.filter((process) => !before.some((one) => one.name === process.name)).map((process) => process.name).join(","),
    removed: before.filter((process) => !after.some((one) => one.name === process.name)).map((process) => process.name).join(","),
    changed: changed.join(","),
    reordered:
      after.filter((process) => before.some((one) => one.name === process.name)).map((process) => process.name).join(",") !==
      before.filter((process) => after.some((one) => one.name === process.name)).map((process) => process.name).join(","),
  };
};

/**
 * A project admin saves the environment's app processes, its "Screenshots after each turn" and each
 * service's preview label (F-140, F-121): the whole list in its order, refused with each rule's
 * words, in one transaction with its audit entry. A part left out is kept as it is (ticket 16: the
 * App tab saves them apart), and a service left out keeps its own label. A service without a port
 * is no preview: nothing would answer.
 */
export const saveAppProcesses: SaveAppProcesses = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  let parsed: AppProcess[] | null = null;
  if (input.processes !== undefined) {
    parsed = [];
    for (const form of input.processes) {
      const one = appProcessSchema.safeParse(form);
      if (!one.success) {
        return { ok: false, error: "invalid-input", message: `An app process doesn't read: ${one.error.issues[0]?.message ?? "check its fields"}` };
      }
      parsed.push(one.data);
    }
  }
  const screenshots = input.screenshots === undefined ? null : screenshotSettingsSchema.safeParse(input.screenshots);
  if (screenshots?.success === false) {
    return { ok: false, error: "invalid-input", message: "The screenshots' routes or widths don't read" };
  }
  const servicePreviews = input.servicePreviews ?? {};
  for (const label of Object.values(servicePreviews)) {
    if (!servicePreviewLabelSchema.safeParse(label).success) {
      return { ok: false, error: "invalid-input", message: "A service's preview label doesn't read" };
    }
  }
  return deps.db.$transaction(async (tx): Promise<SaveResult> => {
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "Only a project admin saves the app's processes" };
    }
    const environment = await tx.environment.findFirst({ where: { projectId, organizationId }, select: { id: true } });
    if (environment === null) {
      return { ok: false, error: "not-found", message: "This project has no environment" };
    }
    await tx.$queryRaw`SELECT 1 FROM "environment" WHERE "id" = ${environment.id} FOR UPDATE`;
    if (parsed !== null) {
      const repoIds = (await tx.repo.findMany({ where: { projectId, organizationId }, select: { id: true } })).map((repo) => repoIdSchema.parse(repo.id));
      const refusal = appProcessListRefusal(parsed, repoIds);
      if (refusal !== null) {
        return refusal.issues.length === 0 ? { ok: false, error: "invalid-input", message: refusal.message } : { ok: false, error: "rule-broken", ...refusal };
      }
    }
    const services = await tx.service.findMany({ where: { environmentId: environment.id }, select: { id: true, name: true, port: true } });
    for (const [name, label] of Object.entries(servicePreviews)) {
      const service = services.find((one) => one.name === name);
      if (service === undefined) {
        return { ok: false, error: "invalid-input", message: "A preview label names a service the environment doesn't have" };
      }
      if (label !== null && service.port === null) {
        return { ok: false, error: "invalid-input", message: `The service ${name} has no port, so it can't be a preview` };
      }
    }
    const before = await appProcessesInTx(tx, environment.id);
    const after = parsed ?? before;
    if (parsed !== null) {
      await writeAppProcessesInTx(tx, { id: environment.id, organizationId, projectId }, parsed);
    }
    const saved =
      screenshots === null
        ? await tx.environment.findUniqueOrThrow({ where: { id: environment.id }, select: { screenshotsAfterTurn: true } })
        : await tx.environment.update({
            where: { id: environment.id },
            data: { screenshotsAfterTurn: screenshots.data.afterTurn, screenshotRoutes: [...screenshots.data.routes], screenshotWidths: [...screenshots.data.widths] },
            select: { screenshotsAfterTurn: true },
          });
    for (const service of services) {
      const label = servicePreviews[service.name];
      if (label !== undefined) {
        await tx.service.update({ where: { id: service.id }, data: { previewLabel: label } });
      }
    }
    const parts = [parsed === null ? null : "processes", screenshots === null ? null : "screenshots", Object.keys(servicePreviews).length === 0 ? null : "service-previews"].filter((part) => part !== null);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "environment.app-processes-saved",
      entity: "environment",
      entityId: environmentIdSchema.parse(environment.id),
      data: {
        parts: parts.join(","),
        processes: after.length,
        ...appProcessChanges(before, after),
        screenshotsAfterTurn: saved.screenshotsAfterTurn,
        servicePreviews: Object.keys(servicePreviews).length,
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "environment", entityId: environmentIdSchema.parse(environment.id) });
    return { ok: true, saved: after.length };
  });
};

// ---------- "Keep it" (F-140) ----------

/**
 * The command a kept process starts with until a project admin names it: the agent started the port
 * itself, and nothing tells ostra how. It fails loudly if it ever runs, and "Accept" refuses it as
 * it is ("Edit and accept" names the real one).
 */
export const KEPT_COMMAND_PLACEHOLDER = "echo 'Name the command that starts this app process in the environment' >&2; exit 1";

/** Whether a proposal still holds a kept process without its command. */
export const keptProcessWithoutCommand = (processes: readonly AppProcess[]): AppProcess | null => processes.find((process) => process.command === KEPT_COMMAND_PLACEHOLDER) ?? null;

/** The words a kept process's notes start with. Names and ports only, never the agent's text but its label. */
export const keptNotes = (input: { readonly port: number; readonly taskTitle: string }): string =>
  `Kept from a task: the agent started this on port ${String(input.port)} in "${input.taskTitle.slice(0, 200)}". ` +
  "Name the command that starts it, its folder and its ready check, then accept it.";

/** A name for a kept process: its label's, else its port's, unique in the environment. */
const keptName = (label: string, port: number, taken: ReadonlySet<string>): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const base = slug === "" || /^\d/.test(slug) ? `app-${String(port)}` : slug;
  if (!taken.has(base)) {
    return base;
  }
  const withPort = `${base}-${String(port)}`.slice(0, 40);
  return taken.has(withPort) ? `app-${String(port)}` : withPort;
};

/**
 * "Keep it" (F-140): a port the agent announced in a task becomes an environment proposal with that
 * one app process, the source `kept`, for a project admin, as an onboarding proposal is. Any member
 * who can open the task keeps it; the proposal waits on the project's admins (`environment_proposal`),
 * and "Accept" adds the process and changes nothing else of the environment. Its command is the
 * placeholder until an admin names it.
 */
export const proposeAppProcess: ProposeAppProcess = (deps, scope, input) =>
  deps.db.$transaction(async (tx): Promise<KeepResult> => {
    const organizationId = scope.organizationId;
    const task = await tx.task.findFirst({
      where: { id: input.taskId, organizationId },
      select: { id: true, projectId: true, title: true, project: { select: { access: true } } },
    });
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    const projectId = projectIdSchema.parse(task.projectId);
    const access = requireProjectAccess(scope, { id: projectId, organizationId, access: task.project.access }, "read");
    if (!access.ok) {
      return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such task" } : { ok: false, error: "forbidden", message: "You can't keep this task's previews" };
    }
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${task.id} FOR UPDATE`;
    const preview = await tx.taskPreview.findUnique({ where: { taskId_key: { taskId: task.id, key: input.key } } });
    if (preview === null) {
      return { ok: false, error: "not-announced", message: "The agent didn't announce that preview in this task" };
    }
    if (preview.keptProposalId !== null) {
      const kept = await tx.environmentProposal.findFirst({ where: { id: preview.keptProposalId, organizationId }, select: { state: true } });
      if (kept !== null && kept.state !== "rejected" && kept.state !== "superseded") {
        return { ok: false, error: "already-kept", message: "That preview was kept already" };
      }
    }
    const environment =
      (await tx.environment.findFirst({ where: { projectId, organizationId }, select: { id: true, setupScript: true } })) ??
      (await tx.environment.create({ data: { organizationId, projectId, status: "draft" }, select: { id: true, setupScript: true } }));
    const existing = await appProcessesInTx(tx, environment.id);
    if (existing.some((process) => process.port === preview.port)) {
      return { ok: false, error: "already-kept", message: `The environment has an app process on port ${String(preview.port)} already` };
    }
    const repos = await tx.repo.findMany({ where: { projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const [firstRepo] = repos;
    if (firstRepo === undefined) {
      return { ok: false, error: "not-found", message: "The project has no repo to run it in" };
    }
    const firstRepoId = repoIdSchema.parse(firstRepo.id);
    // The proposal's other parts are the environment as it is, so its diff shows the process alone;
    // "Accept" of a kept proposal applies the processes only (`decideEnvironmentProposal`).
    const checks = await tx.check.findMany({ where: { environmentId: environment.id }, orderBy: { position: "asc" }, select: { name: true, command: true, timeoutSeconds: true, repoId: true } });
    const services = await tx.service.findMany({ where: { environmentId: environment.id }, orderBy: { createdAt: "asc" }, select: { name: true, image: true, port: true, healthCheck: true, previewLabel: true } });
    const process: AppProcess = {
      name: keptName(preview.label, preview.port, new Set(existing.map((one) => one.name))),
      repoId: firstRepoId,
      folder: ".",
      command: KEPT_COMMAND_PLACEHOLDER,
      port: preview.port,
      ready: { kind: "port" },
      label: preview.label,
      primary: preview.primary && !existing.some((one) => one.primary),
      hostRewrite: true,
    };
    const body = environmentProposalSchema.safeParse({
      repos: [
        {
          repoId: firstRepoId,
          setupScript: environment.setupScript,
          checks: checks.filter((check) => check.repoId === null || check.repoId === firstRepoId).map((check) => ({ name: check.name, command: check.command, timeoutSeconds: check.timeoutSeconds })),
          variableNames: [],
        },
      ],
      services: services.map((service) => ({
        name: service.name,
        image: service.image,
        port: service.port,
        healthCheck: service.healthCheck === "" ? null : service.healthCheck,
        variableNames: [],
        preview: service.previewLabel === null ? null : { label: service.previewLabel },
      })),
      notes: keptNotes({ port: preview.port, taskTitle: task.title }),
      appProcesses: [process],
    } satisfies EnvironmentProposal);
    if (!body.success) {
      return { ok: false, error: "not-announced", message: "The announced preview can't be proposed as it is" };
    }
    const row = await tx.environmentProposal.create({
      data: { organizationId, projectId, environmentId: environment.id, taskId: task.id, body: body.data, notes: body.data.notes, state: "proposed", source: "kept" },
      select: { id: true },
    });
    const proposalId = environmentProposalIdSchema.parse(row.id);
    await tx.taskPreview.update({ where: { id: preview.id }, data: { keptProposalId: proposalId } });
    const taskId = taskIdSchema.parse(task.id);
    const session = await tx.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId: sessionIdSchema.parse(session.id), at: deps.clock.now(), event: { kind: "environment.proposed", proposalId } });
    }
    await createNeedsYouItemInTx(deps, tx, { organizationId, projectId, taskId, reason: "environment_proposal", audience: "project_members" });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "environment.app-process-kept",
      entity: "environment",
      entityId: environmentIdSchema.parse(environment.id),
      data: { proposalId, taskId, port: preview.port, name: process.name },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "environment", entityId: environmentIdSchema.parse(environment.id) });
    return { ok: true, proposalId };
  });

// ---------- the environment page's list ----------

/** One process the environment page lists: saved, or found by detection and not saved yet (F-112). */
export type EnvironmentAppProcessEntry =
  | { readonly origin: "saved"; readonly process: AppProcess }
  | { readonly origin: "detected"; readonly repoId: RepoId; readonly process: DetectedAppProcess };

/**
 * The environment's app processes for its page (F-140): the saved ones in their order, then what
 * detection found in each repo and isn't saved yet (by name or port), marked `detected` for a
 * project admin to save. A detected process may lack its command: detection can't always tell.
 */
export const environmentAppProcessList = (
  saved: readonly AppProcess[],
  detected: readonly { readonly repoId: RepoId; readonly processes: readonly DetectedAppProcess[] }[],
): readonly EnvironmentAppProcessEntry[] => {
  const names = new Set(saved.map((process) => process.name));
  const ports = new Set(saved.map((process) => process.port));
  const entries: EnvironmentAppProcessEntry[] = saved.map((process) => ({ origin: "saved", process }));
  for (const repo of detected) {
    for (const process of repo.processes) {
      if (names.has(process.name) || ports.has(process.port)) {
        continue;
      }
      names.add(process.name);
      ports.add(process.port);
      entries.push({ origin: "detected", repoId: repo.repoId, process });
    }
  }
  return entries;
};

/**
 * What detection found in each of a project's repos as one list for the environment (F-112, F-140):
 * in the repos' order, the first of a name or a port wins, one primary (the first repo's), at most
 * `appProcessesMax`. A process may still lack its command.
 */
export const detectedAppProcesses = (
  repos: readonly { readonly repoId: RepoId; readonly processes: readonly DetectedAppProcess[] }[],
): readonly { readonly repoId: RepoId; readonly process: DetectedAppProcess }[] => {
  const names = new Set<string>();
  const ports = new Set<number>();
  let primary = false;
  const out: { readonly repoId: RepoId; readonly process: DetectedAppProcess }[] = [];
  for (const repo of repos) {
    for (const process of repo.processes) {
      if (names.has(process.name) || ports.has(process.port) || out.length >= runnerLimits.appProcessesMax) {
        continue;
      }
      names.add(process.name);
      ports.add(process.port);
      out.push({ repoId: repo.repoId, process: { ...process, primary: process.primary && !primary } });
      primary ||= process.primary;
    }
  }
  return out;
};

/**
 * Detection's processes as app processes, for an onboarding box to start (F-113, F-140): the ones
 * with a command, each checked by the environment's rules; one that doesn't read is left out.
 */
export const appProcessesFromDetected = (detected: readonly { readonly repoId: RepoId; readonly process: DetectedAppProcess }[]): readonly AppProcess[] =>
  detected.flatMap(({ repoId, process }) => {
    if (process.command === null) {
      return [];
    }
    const parsed = appProcessSchema.safeParse({
      name: process.name,
      repoId,
      folder: process.folder,
      command: process.command,
      port: process.port,
      ready: process.ready,
      label: process.label,
      primary: process.primary,
    });
    return parsed.success && appProcessListIssues([parsed.data]).length === 0 ? [parsed.data] : [];
  });

// ---------- a task's runner and the app ----------

/** Whether a task's app processes can run where it runs (F-140): its runner's protocol minor. */
export type TaskAppSupport =
  | { readonly kind: "supported" }
  /** The environment declares no app process. */
  | { readonly kind: "no-app" }
  /** The task hasn't run on a runner yet. */
  | { readonly kind: "no-runner" }
  /** A runner below minor 7 runs the task as before, without them: the page says so. */
  | { readonly kind: "runner-needs-upgrade"; readonly words: string };

/**
 * What the task's page says about its app (F-140): a task on a minor-6 runner runs as before, and
 * the page says the runner needs upgrading for screenshots and previews. Read from the task's
 * newest lease's runner, as it last connected.
 */
export const taskAppSupport = async (db: Pick<Db, "appProcess" | "lease" | "runnerPresence">, task: { readonly id: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId }): Promise<TaskAppSupport> => {
  if ((await db.appProcess.count({ where: { projectId: task.projectId, organizationId: task.organizationId } })) === 0) {
    return { kind: "no-app" };
  }
  const lease = await db.lease.findFirst({ where: { taskId: task.id, organizationId: task.organizationId }, orderBy: { epoch: "desc" }, select: { runnerId: true } });
  if (lease === null) {
    return { kind: "no-runner" };
  }
  const presence = await db.runnerPresence.findFirst({ where: { runnerId: lease.runnerId, organizationId: organizationIdSchema.parse(task.organizationId) }, select: { minor: true } });
  return (presence?.minor ?? 0) >= 7 ? { kind: "supported" } : { kind: "runner-needs-upgrade", words: previewRefusalWords("runner-needs-upgrade") };
};
