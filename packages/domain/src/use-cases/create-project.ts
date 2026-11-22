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
import { draftFromRepos } from "../environment/repo-drafts.ts";
import type { Ports } from "../ports.ts";
import { ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import { builtInProfileOfKindInTx } from "./refine-drafts.ts";
import type { UseCaseResult } from "./common.ts";
import { ensureDefaultPool } from "./pools.ts";
import { checkoutDirFor, PROJECT_MAX_REPOS_DEFAULT } from "../repos/several-repos.ts";
import { appOwnerInTx, installationUsable, linkInstallationInTx, linkOwnInstallationInTx, seenInstallationOf } from "../code-host/installations.ts";

// F-086: an admin creates a project with one repo linked through the organization's App, and its one
// environment as a draft (F-112 fills it from the repo's files). Its default code agent profile is
// the organization's built-in OpenCode profile. Written by ticket 32. Since 2026-11-22 (F-112/c1),
// the draft comes from each of the project's repos, not the first alone (`draftFromRepos`).

/** A repo the project is created with: the App's connection, the installation and the repo. */
const projectRepoInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  installationId: z.string().min(1).max(64),
  fullName: repoFullNameSchema,
});

export const createProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens"),
  access: z.enum(["open", "restricted"]).default("open"),
  repo: projectRepoInputSchema,
  /**
   * Milestone 4 (F-098, ticket 30): the project's other repos, after `repo`, in order. Each is one
   * a linked App installation reaches, as `repo` is; none twice. The API holds the total to
   * `OSTRA_PROJECT_MAX_REPOS`.
   */
  moreRepos: z.array(projectRepoInputSchema).max(PROJECT_MAX_REPOS_DEFAULT - 1).optional(),
}).refine(
  (input) => new Set([input.repo, ...(input.moreRepos ?? [])].map((repo) => repo.fullName.toLowerCase())).size === 1 + (input.moreRepos?.length ?? 0),
  { message: "Each repo once", path: ["moreRepos"] },
);
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export type CreateProjectResult = UseCaseResult<
  {
    readonly projectId: ProjectId;
    readonly repoId: RepoId;
    readonly environmentId: EnvironmentId;
    /**
     * What detection found in the first repo, with its reasons, for the panel to show while the
     * admin reviews the draft. Additive to the first contract (ticket 32). Every repo's is in
     * `environments.detect`, and the stored draft is made from them all (F-112).
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

/** The repo's files read and its environment detected (F-112), or why its files couldn't be read. */
export const readRepoDetection = async (
  codeHost: CodeHostAdapter,
  access: RepoAccess,
  ref: string,
): Promise<{ readonly ok: true; readonly detection: DetectedEnvironment } | { readonly ok: false; readonly reason: string }> => {
  const listed = await codeHost.listTree(access, ref);
  const tree = listed.ok ? listed.value : null;
  const read = await codeHost.readFiles(access, ref, pathsToRead(tree));
  if (!read.ok) {
    return { ok: false, reason: `its files could not be read: ${read.error.message}` };
  }
  return { ok: true, detection: detectEnvironment({ tree, files: new Map(read.value.files.map((file) => [file.path, file.content] as const)) }) };
};

/**
 * Reads the repo's files and drafts its environment (F-112). A repo whose files can't be read
 * drafts nothing, with the reason, rather than blocking the project.
 */
export const detectRepoEnvironment = async (codeHost: CodeHostAdapter, access: RepoAccess, ref: string): Promise<DetectedEnvironment> => {
  const read = await readRepoDetection(codeHost, access, ref);
  return read.ok ? read.detection : detectionWithoutFiles(read.reason);
};

/** A draft with nothing read from the repo, and why (F-112): what detection says when it can't read it. */
export const detectionWithoutFiles = (finding: string): DetectedEnvironment => ({
  ...detectEnvironment({ tree: null, files: new Map() }),
  reasons: [{ file: "(the repo)", finding }],
});

/** The folder a repo is checked out in, inside a task's workspace: its name, kept to safe characters. */
const checkoutDirOf = (fullName: RepoFullName): string => {
  const name = fullName.split("/")[1] ?? "repo";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return safe === "" ? "repo" : safe;
};

type HostRepo = Extract<Awaited<ReturnType<CodeHostAdapter["listRepos"]>>, { readonly ok: true }>["value"][number];

const refusal = (error: Exclude<CreateProjectResult, { readonly ok: true }>["error"], message: string) => ({ ok: false, error, message }) as const;

/** A repo a linked installation of one of the organization's Apps lists, or why not. */
const reachRepo = async (
  deps: CreateProjectDeps,
  wanted: z.infer<typeof projectRepoInputSchema>,
): Promise<{ readonly ok: true; readonly app: CodeHostAppCredentials; readonly hostRepo: HostRepo } | Extract<CreateProjectResult, { readonly ok: false }>> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const connection = await tx.connection.findFirst({ where: { id: wanted.connectionId, organizationId, kind: "github" } });
  if (connection === null) {
    return refusal("repo-not-installed", "That GitHub connection doesn't exist in this organization");
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
  // Milestone 4 (F-136, ADR 0065): a repo comes only through a linked installation, checked before
  // anything is minted for it. One ostra hasn't seen yet is linked here when it's on the App owner's
  // own account; one on another account waits for an admin on the GitHub page. When the host
  // doesn't say who owns the App, the admin's choice links it, as before milestone 4.
  const installationId = wanted.installationId;
  const known = await tx.codeHostInstallation.findUnique({
    where: { connectionId_installationId: { connectionId: connection.id, installationId } },
    select: { state: true, removedAt: true },
  });
  if (known !== null && !installationUsable(known)) {
    return refusal("repo-not-installed", "That GitHub installation isn't linked to ostra: an organization admin links it on the GitHub page");
  }
  if (known === null) {
    const listed = await deps.adapters.codeHost.listInstallations(app);
    const seen = listed.ok ? listed.value.find((installation) => installation.installationId === installationId) : undefined;
    if (seen === undefined) {
      return refusal("repo-not-installed", "The App has no such installation");
    }
    const owner = await appOwnerInTx(tx, deps.adapters.codeHost, app, connection);
    const connectionId = connectionIdSchema.parse(connection.id);
    if (owner.accountId === null && owner.login === null) {
      await linkInstallationInTx(deps, tx, { organizationId, connectionId, installation: seenInstallationOf(seen), memberId: scope.memberId });
    } else if (!(await linkOwnInstallationInTx(deps, tx, { organizationId, connectionId, owner, installation: seenInstallationOf(seen) }))) {
      return refusal("repo-not-installed", "That GitHub installation isn't linked to ostra: an organization admin links it on the GitHub page");
    }
  }
  const repos = await deps.adapters.codeHost.listRepos(app, wanted.installationId);
  if (!repos.ok) {
    return refusal("repo-not-installed", `GitHub did not list the installation's repos: ${repos.error.message}`);
  }
  const hostRepo = repos.value.find((candidate) => candidate.fullName.toLowerCase() === wanted.fullName.toLowerCase());
  if (hostRepo === undefined) {
    return refusal("repo-not-installed", `The App's installation doesn't include ${wanted.fullName}`);
  }

  return { ok: true, app, hostRepo };
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

  // Each repo must be one the organization's App can reach: listed by a linked installation.
  const reached: { readonly connectionId: string; readonly installationId: string; readonly app: CodeHostAppCredentials; readonly hostRepo: HostRepo }[] = [];
  for (const wanted of [input.repo, ...(input.moreRepos ?? [])]) {
    const found = await reachRepo(deps, wanted);
    if (!found.ok) {
      return found;
    }
    reached.push({ connectionId: wanted.connectionId, installationId: wanted.installationId, app: found.app, hostRepo: found.hostRepo });
  }
  const [first] = reached;
  if (first === undefined) {
    throw new Error("a project has a first repo");
  }
  const { hostRepo } = first;

  const profileId = await ensureBuiltInAgentProfile(tx, organizationId);
  const poolId = await ensureDefaultPool(tx, organizationId);

  // F-112: each repo's files, through its own App's installation, in the project's order.
  const detections = [];
  for (const entry of reached) {
    const fullName = repoFullNameSchema.parse(entry.hostRepo.fullName);
    detections.push({
      fullName,
      detection: await detectRepoEnvironment(deps.adapters.codeHost, { app: entry.app, installationId: entry.installationId, repo: fullName }, entry.hostRepo.defaultBranch),
    });
  }
  const detection = detections[0]?.detection ?? detectionWithoutFiles("the project has no repo");
  const draft = draftFromRepos(detections);

  const project = await tx.project.create({
    data: {
      organizationId,
      name: input.name,
      slug: input.slug,
      access: input.access,
      // Milestone 6 (F-099, F-100): the built-in Refine and Review profiles, where the organization has them.
      defaultRefineProfileId: (await builtInProfileOfKindInTx(tx, organizationId, "refine")) ?? profileId,
      defaultCodeProfileId: profileId,
      defaultReviewProfileId: (await builtInProfileOfKindInTx(tx, organizationId, "review")) ?? profileId,
    },
    select: { id: true },
  });
  const projectId = projectIdSchema.parse(project.id);
  // Each repo at its place in the order (F-098), each in its own folder.
  const taken = new Set<string>();
  let firstRepoId: RepoId | null = null;
  for (const [position, entry] of reached.entries()) {
    const checkoutDir = position === 0 ? checkoutDirOf(entry.hostRepo.fullName) : checkoutDirFor(repoFullNameSchema.parse(entry.hostRepo.fullName), taken);
    taken.add(checkoutDir);
    const created = await tx.repo.create({
      data: {
        organizationId,
        projectId,
        connectionId: entry.connectionId,
        installationId: entry.installationId,
        hostRepoId: entry.hostRepo.hostRepoId,
        fullName: entry.hostRepo.fullName,
        defaultBranch: entry.hostRepo.defaultBranch,
        checkoutDir,
        position,
      },
      select: { id: true },
    });
    firstRepoId ??= repoIdSchema.parse(created.id);
  }
  if (firstRepoId === null) {
    throw new Error("a project has a first repo");
  }
  await tx.projectPool.create({ data: { organizationId, projectId, poolId } });
  // The environment starts as a draft: the setup script and base image detected from each repo, to
  // be reviewed. Variables and secrets are listed in the detection for the form; a secret has no
  // value yet, and a row without one can't be stored (the kind's check), so nothing is saved for
  // them here.
  const environment = await tx.environment.create({
    data: { organizationId, projectId, status: "draft", setupScript: draft.setupScript, baseImage: draft.baseImage },
    select: { id: true },
  });

  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "project.created",
    entity: "project",
    entityId: projectId,
    data: { slug: input.slug, access: input.access, repo: hostRepo.fullName, ...(reached.length > 1 ? { repos: reached.map((entry) => entry.hostRepo.fullName).join(",") } : {}) },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  return {
    ok: true,
    projectId,
    repoId: firstRepoId,
    environmentId: environmentIdSchema.parse(environment.id),
    detection,
  };
};
