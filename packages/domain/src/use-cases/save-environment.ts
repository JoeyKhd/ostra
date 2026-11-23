import type { Tx } from "@ostra/db";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";
import { DEFAULT_ENV_FILE, environmentConfigSchema, environmentIdSchema, projectIdSchema, repoIdSchema } from "@ostra/protocol";
import type { EnvironmentId, OrganizationId, ProjectId, RepoId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// F-050, ADR 0038: a project admin saves the environment (reviewed from its draft): the setup
// script, and each repo's variables, secrets and files. Secret values go to the secret store and
// the entries keep references. Written by ticket 32.

export const saveEnvironmentInputSchema = z.strictObject({
  projectId: projectIdSchema,
  environment: environmentConfigSchema,
  /**
   * F-112/c1 (Q345 option (b)): the repos whose waiting drafts this save takes in, by "Apply" or
   * by "Edit first" and Save: their drafts are done, and the audit entry names them.
   */
  repoDrafts: z.array(repoIdSchema).max(100).optional(),
});
export type SaveEnvironmentInput = z.infer<typeof saveEnvironmentInputSchema>;

export type SaveEnvironmentResult = UseCaseResult<
  { readonly environmentId: EnvironmentId },
  "not-found" | "forbidden" | "unknown-repo" | "duplicate-entry" | "secret-without-value"
>;

export type SaveEnvironmentDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type SaveEnvironment = (deps: SaveEnvironmentDeps, input: SaveEnvironmentInput) => Promise<SaveEnvironmentResult>;

const refuse = (error: Exclude<SaveEnvironmentResult, { readonly ok: true }>["error"], message: string): SaveEnvironmentResult => ({
  ok: false,
  error,
  message,
});

const secretKey = (repoId: RepoId, name: string): string => `${repoId}\u0000${name}`;

export const saveEnvironment: SaveEnvironment = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId: OrganizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuse("not-found", "No such project");
  }
  const projectId = projectIdSchema.parse(project.id);
  const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such project") : refuse("forbidden", "Only a project admin saves its environment");
  }

  const { environment } = input;
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, select: { id: true } });
  const projectRepoIds = repos.map((repo) => repoIdSchema.parse(repo.id));
  const repoIds = new Set<RepoId>(projectRepoIds);
  if (environment.entries.some((entry) => !repoIds.has(entry.repoId)) || environment.envFiles.some((file) => !repoIds.has(file.repoId))) {
    return refuse("unknown-repo", "An entry names a repo that isn't in this project");
  }

  // A name is one variable or one secret per repo, and a path one file per repo.
  const seen = new Set<string>();
  for (const entry of environment.entries) {
    const key = entry.kind === "file" ? `file\u0000${entry.repoId}\u0000${entry.path}` : `name\u0000${entry.repoId}\u0000${entry.name}`;
    if (seen.has(key)) {
      return refuse("duplicate-entry", `${entry.kind === "file" ? entry.path : entry.name} appears twice for one repo`);
    }
    seen.add(key);
  }
  const envFileRepos = new Set<RepoId>();
  for (const file of environment.envFiles) {
    if (envFileRepos.has(file.repoId)) {
      return refuse("duplicate-entry", "A repo has two env files");
    }
    envFileRepos.add(file.repoId);
  }

  const row = await tx.environment.findFirst({ where: { projectId: project.id, organizationId }, select: { id: true } });
  const environmentRow =
    row ??
    (await tx.environment.create({ data: { organizationId, projectId: project.id, status: "draft" }, select: { id: true } }));
  const environmentId = environmentIdSchema.parse(environmentRow.id);

  // A secret saved without a value keeps the one it has; with a value, the value goes to the store.
  const existing = await tx.environmentEntry.findMany({ where: { environmentId: environmentRow.id, kind: "secret" }, select: { repoId: true, name: true, secretRef: true } });
  const existingRefs = new Map<string, SecretRef>();
  for (const entry of existing) {
    const ref = secretRefSchema.safeParse(entry.secretRef);
    if (entry.name !== null && ref.success) {
      existingRefs.set(secretKey(repoIdSchema.parse(entry.repoId), entry.name), ref.data);
    }
  }

  const created: SecretRef[] = [];
  const rows: {
    organizationId: OrganizationId;
    projectId: ProjectId;
    environmentId: EnvironmentId;
    repoId: RepoId;
    kind: "variable" | "secret" | "file";
    name: string | null;
    path: string | null;
    value: string | null;
    secretRef: string | null;
    availableDuringSetup: boolean;
  }[] = [];
  const base = { organizationId, projectId, environmentId };
  try {
    for (const entry of environment.entries) {
      switch (entry.kind) {
        case "variable":
          rows.push({ ...base, repoId: entry.repoId, kind: "variable", name: entry.name, path: null, value: entry.value, secretRef: null, availableDuringSetup: entry.availableDuringSetup });
          break;
        case "file":
          rows.push({ ...base, repoId: entry.repoId, kind: "file", name: null, path: entry.path, value: entry.content, secretRef: null, availableDuringSetup: entry.availableDuringSetup });
          break;
        case "secret": {
          let ref = existingRefs.get(secretKey(entry.repoId, entry.name));
          if (entry.value !== undefined) {
            const put = await deps.adapters.secretStore.put({ organizationId, purpose: "environment.secret" }, entry.value);
            if (!put.ok) {
              throw new Error(`the secret store did not keep an environment secret: ${put.error.code}`);
            }
            created.push(put.value);
            ref = put.value;
          }
          if (ref === undefined) {
            await Promise.allSettled(created.map((made) => deps.adapters.secretStore.delete(organizationId, made)));
            return refuse("secret-without-value", `The secret ${entry.name} has no value yet: give it one`);
          }
          rows.push({ ...base, repoId: entry.repoId, kind: "secret", name: entry.name, path: null, value: null, secretRef: ref, availableDuringSetup: entry.availableDuringSetup });
          break;
        }
        default:
          return entry satisfies never;
      }
    }

    await tx.environmentEntry.deleteMany({ where: { environmentId: environmentRow.id } });
    if (rows.length > 0) {
      await tx.environmentEntry.createMany({ data: rows });
    }
    // Where each repo's variables and secrets are written in its checkout (spec section 11, item 7).
    const envFileOf = new Map<RepoId, string>(environment.envFiles.map((file) => [file.repoId, file.path] as const));
    for (const repoId of projectRepoIds) {
      await tx.repo.update({ where: { id: repoId }, data: { envFile: envFileOf.get(repoId) ?? DEFAULT_ENV_FILE } });
    }
    // F-112/c1: the drafts this save took in are done.
    const drafted = input.repoDrafts === undefined || input.repoDrafts.length === 0
      ? []
      : await tx.repo.findMany({ where: { id: { in: [...input.repoDrafts] }, projectId: project.id, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, fullName: true } });
    if (drafted.length > 0) {
      await tx.environmentRepoDraft.deleteMany({ where: { environmentId: environmentRow.id, repoId: { in: drafted.map((repo) => repo.id) } } });
    }
    await tx.environment.update({
      where: { id: environmentRow.id },
      data: {
        baseImage: environment.baseImage,
        setupScript: environment.setupScript,
        status: "saved",
        savedAt: new Date(deps.clock.now()),
        savedByMemberId: scope.memberId,
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "environment.saved",
      entity: "environment",
      entityId: environmentId,
      data: {
        variables: rows.filter((candidate) => candidate.kind === "variable").length,
        secrets: rows.filter((candidate) => candidate.kind === "secret").length,
        files: rows.filter((candidate) => candidate.kind === "file").length,
        hasSetupScript: environment.setupScript !== null,
        ...(drafted.length === 0 ? {} : { repoDraft: drafted.map((repo) => repo.fullName).join(", ") }),
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "environment", entityId: environmentId });

    // Secrets this save replaced or dropped are deleted last, once everything else is written.
    const keep = new Set<string>(rows.flatMap((candidate) => (candidate.secretRef === null ? [] : [candidate.secretRef])));
    await Promise.allSettled(
      [...existingRefs.values()].filter((ref) => !keep.has(ref)).map((ref) => deps.adapters.secretStore.delete(organizationId, ref)),
    );
    return { ok: true, environmentId };
  } catch (error) {
    await Promise.allSettled(created.map((ref) => deps.adapters.secretStore.delete(organizationId, ref)));
    throw error;
  }
};
