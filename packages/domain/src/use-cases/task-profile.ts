import type { Tx } from "@ostra/db";
import { agentItemNameSchema, agentProfileIdSchema, blobIdSchema, envNameSchema, repoRelativePathSchema, runnerLimits } from "@ostra/protocol";
import type { AgentProfileId, TaskKind } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import { modelNameOfColumns } from "../providers/model-name.ts";
import { checkProfileUse } from "./agent-profile-setup.ts";
import { BUILT_IN_PROFILE_ADAPTER } from "./agent-profiles.ts";
import type { ProfileMcpServer } from "./m3-signatures.ts";

// The profile a task starts with (F-021, ADR 0049, milestone 3's ticket 16). A task records it in
// `Task.agentProfileId`: the member's choice at the start, else the project's default for the
// task's kind, else the organization's built-in OpenCode profile. A reopen keeps it. An archived
// profile still serves the tasks that have it, and is offered to no new task (Q189). Who may use a
// profile: everyone for an `everyone` profile and the built-in one, the listed members for a
// `listed` one, and every organization admin. Another organization's profile is never found.

/** What the checks read of a profile. */
export type ProfileAccessFacts = {
  readonly id: string;
  readonly organizationId: string;
  readonly builtIn: boolean;
  readonly access: "everyone" | "listed";
  readonly archivedAt: Date | null;
};

/** Whether the member may run a task with the profile (ADR 0049). Archived or not: the caller decides that. */
export const memberMayUseProfileInTx = async (tx: Pick<Tx, "agentProfileMember">, scope: MemberScope, profile: ProfileAccessFacts): Promise<boolean> => {
  if (profile.organizationId !== scope.organizationId) {
    return false;
  }
  if (profile.builtIn || profile.access === "everyone" || scope.role === "admin") {
    return true;
  }
  const listed = await tx.agentProfileMember.findFirst({
    where: { profileId: profile.id, memberId: scope.memberId, organizationId: scope.organizationId },
    select: { id: true },
  });
  return listed !== null;
};

/** The project's default profile column for a task kind. */
const defaultFor = (
  project: { readonly defaultRefineProfileId: string | null; readonly defaultCodeProfileId: string | null; readonly defaultReviewProfileId: string | null },
  kind: TaskKind,
): string | null => {
  switch (kind) {
    case "refine":
      return project.defaultRefineProfileId;
    case "code":
      return project.defaultCodeProfileId;
    case "review":
      return project.defaultReviewProfileId;
    default:
      return kind satisfies never;
  }
};

const profileInclude = { model: { include: { provider: { select: { allowOnPersonalRunners: true } } } } } as const;

/** The profile a start resolved to, with its model and the model's provider. */
export type StartProfile = NonNullable<Awaited<ReturnType<typeof findProfile>>>;

const findProfile = (tx: Pick<Tx, "agentProfile">, organizationId: string, profileId: string) =>
  tx.agentProfile.findFirst({ where: { id: profileId, organizationId }, include: profileInclude });

export type ResolveProfileResult =
  | { readonly ok: true; readonly profile: StartProfile; readonly profileId: AgentProfileId }
  | {
      readonly ok: false;
      /** `forbidden`: the member may not use the profile they chose; `no-agent-profile`: it's archived, not in the organization, or has no model. */
      readonly error: "forbidden" | "no-agent-profile";
      readonly message: string;
    };

const NO_MODEL = "The task's agent profile has no model yet: an admin picks one under Models";

/**
 * The profile a new task starts with: the member's choice, which they must be allowed to use and
 * which mustn't be archived; else the project's default for the kind; else the organization's
 * built-in profile. A default the member may not use, or one archived since, is passed over for the
 * built-in profile, which is always everyone's.
 */
export const resolveStartProfileInTx = async (
  tx: Tx,
  scope: MemberScope,
  input: {
    readonly project: { readonly defaultRefineProfileId: string | null; readonly defaultCodeProfileId: string | null; readonly defaultReviewProfileId: string | null };
    readonly kind: TaskKind;
    readonly chosen: AgentProfileId | undefined;
  },
): Promise<ResolveProfileResult> => {
  const organizationId = scope.organizationId;
  // Milestone 4 (F-135, ADR 0065): a profile has a model when it names one, by name or by its
  // row; which provider serves it is the project's list's to say, and the caller checks that next.
  const withModel = (profile: StartProfile): ResolveProfileResult =>
    profile.model === null && modelNameOfColumns(profile) === null
      ? { ok: false, error: "no-agent-profile", message: NO_MODEL }
      : { ok: true, profile, profileId: agentProfileIdSchema.parse(profile.id) };

  if (input.chosen !== undefined) {
    // The API's own check (ticket 34): another organization's profile reads as one that isn't
    // there, an archived one is offered to no new task, a listed one only to its members.
    const use = await checkProfileUse(tx, scope, input.chosen);
    if (!use.ok) {
      return use;
    }
    const chosen = await findProfile(tx, organizationId, input.chosen);
    if (chosen === null) {
      return { ok: false, error: "no-agent-profile", message: "No such agent profile" };
    }
    return withModel(chosen);
  }
  const defaultId = defaultFor(input.project, input.kind);
  if (defaultId !== null) {
    const fallback = await findProfile(tx, organizationId, defaultId);
    if (fallback !== null && fallback.archivedAt === null && (await memberMayUseProfileInTx(tx, scope, fallback))) {
      return withModel(fallback);
    }
  }
  const builtIn = await tx.agentProfile.findFirst({
    where: { organizationId, builtIn: true, adapter: BUILT_IN_PROFILE_ADAPTER },
    include: profileInclude,
    orderBy: { createdAt: "asc" },
  });
  if (builtIn === null) {
    return { ok: false, error: "no-agent-profile", message: NO_MODEL };
  }
  return withModel(builtIn);
};

/**
 * The profile a reopen runs with: the one the task started with, kept even when it's archived
 * since (Q189), for tasks from before milestone 3 the newest session's, else the project's default.
 * The member must be allowed to use it.
 */
export const resolveReopenProfileInTx = async (
  tx: Pick<Tx, "agentProfile" | "agentProfileMember" | "project">,
  scope: MemberScope,
  input: { readonly task: { readonly agentProfileId: string | null; readonly projectId: string; readonly kind: TaskKind }; readonly previousSessionProfileId: string | null },
): Promise<{ readonly ok: true; readonly profileId: AgentProfileId | null } | { readonly ok: false; readonly error: "profile-not-allowed"; readonly message: string }> => {
  let profileId = input.task.agentProfileId ?? input.previousSessionProfileId;
  if (profileId === null) {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: input.task.projectId },
      select: { defaultRefineProfileId: true, defaultCodeProfileId: true, defaultReviewProfileId: true },
    });
    profileId = defaultFor(project, input.task.kind);
  }
  if (profileId === null) {
    return { ok: true, profileId: null };
  }
  const profile = await tx.agentProfile.findFirst({
    where: { id: profileId, organizationId: scope.organizationId },
    select: { id: true, organizationId: true, builtIn: true, access: true, archivedAt: true, name: true },
  });
  // A profile the organization doesn't hold is never used: the dispatch would find no model.
  if (profile === null) {
    return { ok: true, profileId: null };
  }
  if (!(await memberMayUseProfileInTx(tx, scope, profile))) {
    return { ok: false, error: "profile-not-allowed", message: `You may not use this task's agent profile, "${profile.name}": ask someone who may to reopen it` };
  }
  return { ok: true, profileId: agentProfileIdSchema.parse(profile.id) };
};

/** The lowest protocol minor that runs every part of a profile (spec section 5.1). */
export const PROFILE_FEATURES_MINOR = 2;

/**
 * Whether a profile uses what a runner below minor 2 can't do: approval rules, plan first, skills
 * or MCP servers. Such a task is never offered to an older runner (ticket 16); without them a
 * minor-1 runner takes it as milestone 2 did.
 */
export const profileNeedsMinor2 = (profile: {
  readonly approvalRules: unknown;
  readonly planFirst: boolean;
  readonly mcpServers: unknown;
  readonly skillCount: number;
}): boolean =>
  profile.planFirst ||
  profile.skillCount > 0 ||
  // Anything but an empty list counts, so a column that doesn't parse never reaches an older runner.
  !(Array.isArray(profile.approvalRules) && profile.approvalRules.length === 0) ||
  !(Array.isArray(profile.mcpServers) && profile.mcpServers.length === 0);

// ---------- the profile's stored JSON (`AgentProfile.mcpServers`, `AgentProfileSkill.files`) ----------

/**
 * An MCP server as `AgentProfile.mcpServers` holds it (ADR 0049): an HTTP server's headers by
 * their secret references, never a value. `saveAgentProfile` writes it; the dispatch and the
 * credentials read it. A row that doesn't parse runs nothing.
 */
export const storedMcpServerSchema: z.ZodType<ProfileMcpServer> = z.discriminatedUnion("transport", [
  z.strictObject({
    name: agentItemNameSchema,
    transport: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }),
    readOnly: z.boolean(),
    headerSecretRefs: z.record(z.string().min(1).max(256), z.string().min(1).max(512)),
  }),
  z.strictObject({
    name: agentItemNameSchema,
    transport: z.literal("stdio"),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(100),
    env: z.record(envNameSchema, z.string().max(65_536)),
    readOnly: z.boolean(),
  }),
]);
export const storedMcpServersSchema = z.array(storedMcpServerSchema).max(runnerLimits.mcpServersMax);

/** A skill's other files as `AgentProfileSkill.files` holds them: each a blob of the organization. */
export const storedSkillFilesSchema = z.array(z.strictObject({ path: repoRelativePathSchema, blobId: blobIdSchema })).max(runnerLimits.skillFilesMax);

/** The sidecar's MCP proxy path of an HTTP server (ADR 0049, Q170): one per server name. */
export const mcpProxyPathFor = (name: string): string => `/mcp/${name}`;
