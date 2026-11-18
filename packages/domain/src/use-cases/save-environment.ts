import type { Tx } from "@ostra/db";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";
import { DEFAULT_ENV_FILE, environmentConfigSchema, environmentIdSchema, projectIdSchema } from "@ostra/protocol";
import type { EnvironmentId, OrganizationId } from "@ostra/protocol";
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

const secretKey = (repoId: string, name: string): string => `${repoId}\u0000${name}`;

export const saveEnvironment: SaveEnvironment = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId: OrganizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuse("not-found", "No such project");
  }
  const access = requireProjectAccess(
    scope,
    { id: projectIdSchema.parse(project.id), organizationId, access: project.access },
    "admin",
  );
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such project") : refuse("forbidden", "Only a project admin saves its environment");
  }

  const { environment } = input;
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, select: { id: true } });
  const repoIds = new Set(repos.map((repo) => repo.id));
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
  const envFileRepos = new Set<string>();
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
      existingRefs.set(secretKey(entry.repoId, entry.name), ref.data);
    }
  }

  const created: SecretRef[] = [];
  const rows: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    repoId: string;
    kind: "variable" | "secret" | "file";
    name: string | null;
    path: string | null;
    value: string | null;
    secretRef: string | null;
    availableDuringSetup: boolean;
  }[] = [];
  const base = { organizationId, projectId: project.id, environmentId: environmentRow.id };
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
    const envFileOf = new Map<string, string>(environment.envFiles.map((file) => [file.repoId, file.path] as const));
    for (const repo of repos) {
      await tx.repo.update({ where: { id: repo.id }, data: { envFile: envFileOf.get(repo.id) ?? DEFAULT_ENV_FILE } });
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
      projectId: projectIdSchema.parse(project.id),
      actor: { kind: "member", id: scope.memberId },
      action: "environment.saved",
      entity: "environment",
      entityId: environmentId,
      data: {
        variables: rows.filter((candidate) => candidate.kind === "variable").length,
        secrets: rows.filter((candidate) => candidate.kind === "secret").length,
        files: rows.filter((candidate) => candidate.kind === "file").length,
        hasSetupScript: environment.setupScript !== null,
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), entity: "environment", entityId: environmentId });

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
