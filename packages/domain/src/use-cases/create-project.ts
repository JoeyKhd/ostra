import type { Tx } from "@ostra/db";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAppCredentials, CodeHostAdapter, RepoAccess } from "@ostra/adapter-sdk";
import { connectionIdSchema, environmentIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { EnvironmentId, ProjectId, RepoFullName, RepoId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { detectEnvironment, pathsToRead } from "../environment/detect.ts";
import type { DetectedEnvironment } from "../environment/detect.ts";
import type { Ports } from "../ports.ts";
import { ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import type { UseCaseResult } from "./common.ts";
import { ensureDefaultPool } from "./pools.ts";

// F-086: an admin creates a project with one repo linked through the organization's App, and its one
// environment as a draft (F-112 fills it from the repo's files). Its default code agent profile is
// the organization's built-in OpenCode profile. Written by ticket 32.

export const createProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens"),
  access: z.enum(["open", "restricted"]).default("open"),
  repo: z.strictObject({
    connectionId: connectionIdSchema,
    installationId: z.string().min(1).max(64),
    fullName: repoFullNameSchema,
  }),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export type CreateProjectResult = UseCaseResult<
  {
    readonly projectId: ProjectId;
    readonly repoId: RepoId;
    readonly environmentId: EnvironmentId;
    /**
     * What detection found in the repo, with its reasons, for the panel to show while the admin
     * reviews the draft. Additive to the first contract (ticket 32).
     */
    readonly detection: DetectedEnvironment;
  },
  "forbidden" | "slug-taken" | "repo-not-installed" | "no-agent-profile"
>;

export type CreateProjectDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type CreateProject = (deps: CreateProjectDeps, input: CreateProjectInput) => Promise<CreateProjectResult>;

const refuse = (error: Exclude<CreateProjectResult, { readonly ok: true }>["error"], message: string): CreateProjectResult => ({
  ok: false,
  error,
  message,
});

/**
 * Reads the repo's files and drafts its environment (F-112). A repo whose files can't be read
 * drafts nothing, with the reason, rather than blocking the project.
 */
export const detectRepoEnvironment = async (codeHost: CodeHostAdapter, access: RepoAccess, ref: string): Promise<DetectedEnvironment> => {
  const listed = await codeHost.listTree(access, ref);
  const tree = listed.ok ? listed.value : null;
  const read = await codeHost.readFiles(access, ref, pathsToRead(tree));
  if (!read.ok) {
    return { ...detectEnvironment({ tree: null, files: new Map() }), reasons: [{ file: "(the repo)", finding: `its files could not be read: ${read.error.message}` }] };
  }
  return detectEnvironment({ tree, files: new Map(read.value.files.map((file) => [file.path, file.content] as const)) });
};

/** The folder a repo is checked out in, inside a task's workspace: its name, kept to safe characters. */
const checkoutDirOf = (fullName: RepoFullName): string => {
  const name = fullName.split("/")[1] ?? "repo";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return safe === "" ? "repo" : safe;
};

export const createProject: CreateProject = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin creates a project");
  }
  if ((await tx.project.count({ where: { organizationId, slug: input.slug } })) > 0) {
    return refuse("slug-taken", "A project with that slug exists");
  }

  // The repo must be one the organization's App can reach: listed by its installation.
  const connection = await tx.connection.findFirst({ where: { id: input.repo.connectionId, organizationId, kind: "github" } });
  if (connection === null) {
    return refuse("repo-not-installed", "That GitHub connection doesn't exist in this organization");
  }
  const keyRef = secretRefSchema.safeParse(connection.privateKeySecretRef);
  if (!keyRef.success) {
    throw new Error("the GitHub connection's private key reference is malformed");
  }
  const key = await deps.adapters.secretStore.get(organizationId, keyRef.data);
  if (!key.ok) {
    throw new Error(`the GitHub App's private key could not be read: ${key.error.code}`);
  }
  const app: CodeHostAppCredentials = { appId: connection.appId, privateKey: key.value };
  const repos = await deps.adapters.codeHost.listRepos(app, input.repo.installationId);
  if (!repos.ok) {
    return refuse("repo-not-installed", `GitHub did not list the installation's repos: ${repos.error.message}`);
  }
  const hostRepo = repos.value.find((candidate) => candidate.fullName.toLowerCase() === input.repo.fullName.toLowerCase());
  if (hostRepo === undefined) {
    return refuse("repo-not-installed", "The App's installation doesn't include that repo");
  }

  const profileId = await ensureBuiltInAgentProfile(tx, organizationId);
  const poolId = await ensureDefaultPool(tx, organizationId);

  const detection = await detectRepoEnvironment(
    deps.adapters.codeHost,
    { app, installationId: input.repo.installationId, repo: hostRepo.fullName },
    hostRepo.defaultBranch,
  );

  const project = await tx.project.create({
    data: {
      organizationId,
      name: input.name,
      slug: input.slug,
      access: input.access,
      defaultRefineProfileId: profileId,
      defaultCodeProfileId: profileId,
      defaultReviewProfileId: profileId,
    },
    select: { id: true },
  });
  const projectId = projectIdSchema.parse(project.id);
  const repo = await tx.repo.create({
    data: {
      organizationId,
      projectId,
      connectionId: connection.id,
      installationId: input.repo.installationId,
      hostRepoId: hostRepo.hostRepoId,
      fullName: hostRepo.fullName,
      defaultBranch: hostRepo.defaultBranch,
      checkoutDir: checkoutDirOf(hostRepo.fullName),
    },
    select: { id: true },
  });
  await tx.projectPool.create({ data: { organizationId, projectId, poolId } });
  // The environment starts as a draft: the detected setup script and base image, to be reviewed.
  // Variables and secrets are listed in the detection for the form; a secret has no value yet, and
  // a row without one can't be stored (the kind's check), so nothing is saved for them here.
  const environment = await tx.environment.create({
    data: { organizationId, projectId, status: "draft", setupScript: detection.setupScript, baseImage: detection.baseImage },
    select: { id: true },
  });

  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "project.created",
    entity: "project",
    entityId: projectId,
    data: { slug: input.slug, access: input.access, repo: hostRepo.fullName },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  return {
    ok: true,
    projectId,
    repoId: repoIdSchema.parse(repo.id),
    environmentId: environmentIdSchema.parse(environment.id),
    detection,
  };
};
