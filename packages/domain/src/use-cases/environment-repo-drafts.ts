import type { Db, Tx } from "@ostra/db";
import { environmentIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { EnvironmentConfig, EnvironmentId, MemberId, OrganizationId, ProjectId, RepoId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { DetectedEnvironment } from "../environment/detect.ts";
import { repoDraftChange, setupLanguageOf, setupToolOf } from "../environment/repo-drafts.ts";
import type { RepoDraftChange, RepoDraftLine, RepoLanguage } from "../environment/repo-drafts.ts";
import { scanMemoryText } from "../memory/secret-scan.ts";
import { organizationSecretValues } from "../memory/store.ts";
import type { AuditLog, ChangeNotices, Clock, JobQueue, ServerAdapters } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { readRepoDetection } from "./create-project.ts";
import { repoAccessFor } from "./repo-access.ts";
import { saveEnvironment } from "./save-environment.ts";

// F-112/c1, Q345 option (b) (the maintainer, 2026-11-22): a repo added to a project whose
// environment is saved runs detection for that repo (no agent, no model) and its draft is held
// beside the saved setup, which keeps running as it is. A project admin applies it (a save, at
// once), edits it first (the page's editors, saved through `environments.save`) or dismisses it
// (with Undo). A dismissed draft doesn't come back unless the repo is removed and added again;
// removing the repo drops its draft.

/** What detection read in the repo, as the draft row keeps it (`EnvironmentRepoDraft.detection`). */
export const detectedEnvironmentSchema = z.object({
  baseImage: z.string().nullable(),
  setupLines: z.array(z.string()),
  setupScript: z.string().nullable(),
  variables: z.array(z.object({ name: z.string(), secret: z.boolean(), source: z.string() })),
  tools: z.array(z.object({ tool: z.string(), version: z.string(), source: z.string() })),
  services: z.array(z.object({ name: z.string(), image: z.string().nullable(), ports: z.array(z.number().int()), source: z.string(), runsOnHost: z.literal(false) })),
  appProcesses: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      port: z.number().int(),
      command: z.string().nullable(),
      folder: z.string(),
      ready: z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), path: z.string() }), z.object({ kind: z.literal("port") })]),
      primary: z.boolean(),
      source: z.string(),
    }),
  ),
  reasons: z.array(z.object({ file: z.string(), finding: z.string() })),
});

/** A detection as the row stores it: plain JSON. */
const detectionJson = (detection: DetectedEnvironment): z.infer<typeof detectedEnvironmentSchema> => ({
  baseImage: detection.baseImage,
  setupLines: [...detection.setupLines],
  setupScript: detection.setupScript,
  variables: detection.variables.map((variable) => ({ ...variable })),
  tools: detection.tools.map((tool) => ({ ...tool })),
  services: detection.services.map((service) => ({ ...service, ports: [...service.ports] })),
  appProcesses: detection.appProcesses.map((process) => ({ ...process, ready: { ...process.ready } })),
  reasons: detection.reasons.map((reason) => ({ ...reason })),
});

export type RepoDraftsDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly jobs: JobQueue;
  readonly adapters: ServerAdapters;
};

/**
 * After `projects.addRepo` on a project whose environment is saved: detection reads the new repo's
 * files and its draft is stored beside the saved setup, which stays as it is. Nothing is stored
 * when the environment is still a draft (that draft is made again instead), when the repo's files
 * can't be read, or when there's nothing to review (the saved script already does what detection
 * found). Answers whether a draft is waiting. Read outside any transaction: the files come from the
 * code host.
 */
export const draftAddedRepo = async (
  deps: Pick<RepoDraftsDeps, "db" | "notices"> & { readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore"> },
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly repoId: RepoId; readonly memberId: MemberId },
): Promise<boolean> => {
  const { db } = deps;
  const environment = await db.environment.findFirst({ where: { projectId: input.projectId, organizationId: input.organizationId }, select: { id: true, status: true } });
  if (environment?.status !== "saved") {
    return false;
  }
  const repo = await db.repo.findFirst({ where: { id: input.repoId, projectId: input.projectId, organizationId: input.organizationId }, select: { id: true, defaultBranch: true } });
  if (repo === null) {
    return false;
  }
  const access = await repoAccessFor(db, deps.adapters.secretStore, input.organizationId, input.repoId);
  if (!access.ok) {
    return false;
  }
  const read = await readRepoDetection(deps.adapters.codeHost, access.access, repo.defaultBranch);
  if (!read.ok) {
    return false;
  }
  const detection = detectionJson(read.detection);
  return db.$transaction(async (tx) => {
    const now = await tx.environment.findFirst({ where: { id: environment.id, organizationId: input.organizationId }, select: { status: true } });
    const exists = await tx.repo.count({ where: { id: input.repoId, projectId: input.projectId } });
    if (now?.status !== "saved" || exists === 0) {
      return false;
    }
    const created = await tx.environmentRepoDraft.createMany({
      data: [{ organizationId: input.organizationId, projectId: input.projectId, environmentId: environment.id, repoId: input.repoId, createdByMemberId: input.memberId, detection }],
      skipDuplicates: true,
    });
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, entity: "environment", entityId: environmentIdSchema.parse(environment.id) });
    if (created.count === 0) {
      return false;
    }
    // Nothing to review (the saved script already runs detection's lines): no draft, and no band.
    const waiting = await waitingDraftsInTx(tx, input.organizationId, input.projectId);
    if (!waiting.some((draft) => draft.repoId === input.repoId)) {
      await tx.environmentRepoDraft.deleteMany({ where: { repoId: input.repoId, projectId: input.projectId } });
      return false;
    }
    return true;
  });
};

/** A waiting draft as the Setup tab shows it. */
export type RepoDraftView = {
  readonly repoId: RepoId;
  readonly fullName: string;
  /** Epoch ms. */
  readonly createdAt: number;
  /** The name of the member who added the repo, when they're known. */
  readonly createdBy: string | null;
  readonly kind: "case" | "plain" | "nothing";
  /** The setup script Apply saves, line by line: kept, or added. Empty for `nothing`. */
  readonly lines: readonly RepoDraftLine[];
  /** The script those lines make (`null` for `nothing`): what "Edit first" puts in the editor. */
  readonly script: string | null;
  /** Where the repo's variables and secrets are written in its checkout. */
  readonly envFile: string;
  /** Detection's variables and secrets, by name, that the repo's section doesn't have yet. */
  readonly variables: readonly { readonly name: string; readonly secret: boolean; readonly source: string }[];
  readonly reasons: readonly { readonly file: string; readonly finding: string }[];
  readonly tools: readonly { readonly tool: string; readonly version: string; readonly source: string }[];
  readonly services: readonly { readonly name: string; readonly image: string | null; readonly ports: readonly number[]; readonly source: string }[];
  /** The repo's language and the tool its setup runs first, from its lines (`Python · uv`). */
  readonly language: RepoLanguage | null;
  readonly tool: string | null;
  /** The tool the saved script runs first (`pnpm`), for a plain script's words. */
  readonly savedTool: string | null;
};

type DraftRow = {
  readonly repoId: RepoId;
  readonly fullName: string;
  readonly envFile: string;
  readonly createdAt: Date;
  readonly createdByMemberId: string | null;
  readonly detection: z.infer<typeof detectedEnvironmentSchema>;
  readonly change: Exclude<RepoDraftChange, { readonly kind: "settled" }>;
};

/**
 * Every draft still waiting in a project, in the order the repos were added, each with what Apply
 * would save now: the change is worked out against the saved script as it is. Drafts with nothing
 * left to review are left out.
 */
const waitingDraftsInTx = async (db: Db | Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<readonly DraftRow[]> => {
  const environment = await db.environment.findFirst({ where: { projectId, organizationId }, select: { status: true, setupScript: true } });
  if (environment?.status !== "saved") {
    return [];
  }
  const [repos, rows] = await Promise.all([
    db.repo.findMany({ where: { projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, fullName: true, envFile: true } }),
    db.environmentRepoDraft.findMany({ where: { projectId, organizationId, dismissedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  const waiting = new Set(rows.map((row) => row.repoId));
  return rows.flatMap((row): DraftRow[] => {
    const repo = repos.find((one) => one.id === row.repoId);
    const detection = detectedEnvironmentSchema.safeParse(row.detection);
    if (repo === undefined || !detection.success) {
      return [];
    }
    // The repos that run the saved script as it is: not the new one, nor another whose own draft waits.
    const others = repos.filter((one) => one.id !== row.repoId);
    const running = others.filter((one) => !waiting.has(one.id));
    const change = repoDraftChange({
      savedScript: environment.setupScript,
      fullName: repo.fullName,
      setupLines: detection.data.setupLines,
      otherRepos: (running.length > 0 ? running : others).map((one) => one.fullName),
    });
    if (change.kind === "settled") {
      return [];
    }
    return [{ repoId: repoIdSchema.parse(row.repoId), fullName: repo.fullName, envFile: repo.envFile, createdAt: row.createdAt, createdByMemberId: row.createdByMemberId, detection: detection.data, change }];
  });
};

/** The project's waiting drafts, for anyone who can open the project. */
export const listRepoDrafts = async (db: Db, scope: MemberScope, projectId: ProjectId): Promise<readonly RepoDraftView[]> => {
  const organizationId = scope.organizationId;
  const [drafts, environment] = await Promise.all([
    waitingDraftsInTx(db, organizationId, projectId),
    db.environment.findFirst({ where: { projectId, organizationId }, select: { id: true, setupScript: true } }),
  ]);
  if (drafts.length === 0 || environment === null) {
    return [];
  }
  const [entries, members] = await Promise.all([
    db.environmentEntry.findMany({ where: { environmentId: environment.id, kind: { in: ["variable", "secret"] } }, select: { repoId: true, name: true } }),
    db.member.findMany({ where: { organizationId, id: { in: drafts.flatMap((draft) => (draft.createdByMemberId === null ? [] : [draft.createdByMemberId])) } }, select: { id: true, user: { select: { name: true } } } }),
  ]);
  const savedLines = (environment.setupScript ?? "").split("\n");
  return drafts.map((draft) => {
    const has = new Set(entries.filter((entry) => entry.repoId === draft.repoId).map((entry) => entry.name));
    const change = draft.change;
    return {
      repoId: draft.repoId,
      fullName: draft.fullName,
      createdAt: draft.createdAt.getTime(),
      createdBy: members.find((member) => member.id === draft.createdByMemberId)?.user.name ?? null,
      kind: change.kind,
      lines: change.kind === "nothing" ? [] : change.lines,
      script: change.kind === "nothing" ? null : change.script,
      envFile: draft.envFile,
      variables: draft.detection.variables.filter((variable) => !has.has(variable.name)),
      reasons: draft.detection.reasons,
      tools: draft.detection.tools,
      services: draft.detection.services.map((service) => ({ name: service.name, image: service.image, ports: service.ports, source: service.source })),
      language: setupLanguageOf(draft.detection.setupLines),
      tool: setupToolOf(draft.detection.setupLines),
      savedTool: setupToolOf(savedLines),
    };
  });
};

/** The project, when the member may decide its drafts: a project admin, or an organization admin. */
const adminProject = async (db: Db | Tx, scope: MemberScope, projectId: ProjectId): Promise<UseCaseResult<{ readonly projectId: ProjectId }, "not-found" | "forbidden">> => {
  const project = await db.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const info = { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access };
  const access = requireProjectAccess(scope, info, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "Only a project admin decides a new repo's draft" };
  }
  return { ok: true, projectId: info.id };
};

export type ApplyRepoDraftResult =
  | UseCaseResult<
      {
        readonly environmentId: EnvironmentId;
        /** Secrets detection named that have no value yet: the store keeps none without one, so the page asks for them. */
        readonly secretsWithoutValue: readonly string[];
      },
      "not-found" | "forbidden" | "nothing-to-apply" | "unknown-repo" | "duplicate-entry" | "secret-without-value"
    >
  | { readonly ok: false; readonly error: "secret-found"; readonly message: string; readonly found: readonly string[] };

/**
 * "Apply": saves the environment at once with the draft's lines in the setup script (a new branch
 * of its `case`, or a plain script made a `case`) and its variables added to the repo's section,
 * values empty. A save like any other: scanned for secret values, audited (`environment.saved`,
 * naming the draft's repo) and versioned, and the snapshot rebuilds. The draft is done.
 */
export const applyRepoDraft = async (deps: RepoDraftsDeps, scope: MemberScope, input: { readonly projectId: ProjectId; readonly repoId: RepoId }): Promise<ApplyRepoDraftResult> => {
  const project = await adminProject(deps.db, scope, input.projectId);
  if (!project.ok) {
    return project;
  }
  const organizationId = scope.organizationId;
  return deps.db.$transaction(
    async (tx): Promise<ApplyRepoDraftResult> => {
      await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "environment" WHERE "projectId" = ${input.projectId} AND "organizationId" = ${organizationId} FOR UPDATE`;
      const draft = (await waitingDraftsInTx(tx, organizationId, input.projectId)).find((one) => one.repoId === input.repoId);
      if (draft === undefined) {
        return { ok: false, error: "not-found", message: "This repo has no draft waiting" };
      }
      if (draft.change.kind !== "case" && draft.change.kind !== "plain") {
        return { ok: false, error: "nothing-to-apply", message: "Detection found nothing to set up in this repo" };
      }
      const added = draft.change.lines.filter((line) => line.kind === "add").map((line) => line.text);
      const scan = scanMemoryText(added, await organizationSecretValues(tx, deps.adapters.secretStore, organizationId));
      if (!scan.ok) {
        return { ok: false, error: "secret-found", message: `The repo's setup lines hold ${scan.found.join(", ")}: name the variable instead, and set its value as a secret.`, found: scan.found };
      }
      const environment = await tx.environment.findFirstOrThrow({ where: { projectId: input.projectId, organizationId }, select: { id: true, baseImage: true } });
      const [entries, repos] = await Promise.all([
        tx.environmentEntry.findMany({ where: { environmentId: environment.id }, orderBy: { createdAt: "asc" } }),
        tx.repo.findMany({ where: { projectId: input.projectId, organizationId }, select: { id: true, envFile: true } }),
      ]);
      // The environment as it is: its entries kept, a secret by its reference (no value is sent).
      const kept = entries.flatMap((entry): EnvironmentConfig["entries"] => {
        const repoId = repoIdSchema.parse(entry.repoId);
        const base = { repoId, availableDuringSetup: entry.availableDuringSetup };
        switch (entry.kind) {
          case "variable":
            return entry.name === null ? [] : [{ ...base, kind: "variable", name: entry.name, value: entry.value ?? "" }];
          case "secret":
            return entry.name === null ? [] : [{ ...base, kind: "secret", name: entry.name }];
          case "file":
            return entry.path === null ? [] : [{ ...base, kind: "file", path: entry.path, content: entry.value ?? "" }];
          default:
            return entry.kind satisfies never;
        }
      });
      const names = new Set(entries.filter((entry) => entry.repoId === input.repoId).map((entry) => entry.name));
      const missing = draft.detection.variables.filter((variable) => !names.has(variable.name));
      const variables = missing.filter((variable) => !variable.secret).map((variable) => ({ kind: "variable" as const, repoId: input.repoId, name: variable.name, value: "", availableDuringSetup: false }));
      const saved = await saveEnvironment(
        { tx, scope, notices: deps.notices, audit: deps.audit, clock: deps.clock, adapters: deps.adapters },
        {
          projectId: input.projectId,
          environment: {
            baseImage: environment.baseImage,
            setupScript: draft.change.script,
            envFiles: repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), path: repo.envFile })),
            entries: [...kept, ...variables],
          },
          repoDrafts: [input.repoId],
        },
      );
      if (!saved.ok) {
        return saved;
      }
      // The environment changed: its snapshot rebuilds (F-051), as any save's does.
      await deps.jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId, projectId: input.projectId, reason: "environment-changed" });
      return { ok: true, environmentId: saved.environmentId, secretsWithoutValue: missing.filter((variable) => variable.secret).map((variable) => variable.name) };
    },
    { timeout: 30_000 },
  );
};

/**
 * "Dismiss" (`undo: false`): the draft is set aside and the environment stays as it is; or "Undo"
 * (`undo: true`), while the page is open: the draft waits again. Each is an audit entry.
 */
export const dismissRepoDraft = async (
  deps: Pick<RepoDraftsDeps, "db" | "audit" | "notices" | "clock">,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly repoId: RepoId; readonly undo: boolean },
): Promise<UseCaseResult<{ readonly dismissed: boolean }, "not-found" | "forbidden">> => {
  const project = await adminProject(deps.db, scope, input.projectId);
  if (!project.ok) {
    return project;
  }
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const draft = await tx.environmentRepoDraft.findFirst({ where: { repoId: input.repoId, projectId: input.projectId, organizationId }, select: { id: true, environmentId: true, dismissedAt: true, repo: { select: { fullName: true } } } });
    if (draft === null || (input.undo ? draft.dismissedAt === null : draft.dismissedAt !== null)) {
      return { ok: false, error: "not-found", message: input.undo ? "This repo has no dismissed draft" : "This repo has no draft waiting" } as const;
    }
    await tx.environmentRepoDraft.update({
      where: { id: draft.id },
      data: input.undo ? { dismissedAt: null, dismissedByMemberId: null } : { dismissedAt: new Date(deps.clock.now()), dismissedByMemberId: scope.memberId },
    });
    const environmentId = environmentIdSchema.parse(draft.environmentId);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: input.undo ? "environment.repo-draft-restored" : "environment.repo-draft-dismissed",
      entity: "environment",
      entityId: environmentId,
      data: { repoId: input.repoId, fullName: repoFullNameSchema.parse(draft.repo.fullName) },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "environment", entityId: environmentId });
    return { ok: true, dismissed: !input.undo } as const;
  });
};
