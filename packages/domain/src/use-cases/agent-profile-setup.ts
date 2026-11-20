import { agentProfileIdSchema, approvalRulesSchema, projectIdSchema, providerIdSchema, runnerLimits } from "@ostra/protocol";
import type { AgentProfileId, TaskKind } from "@ostra/protocol";
import { z } from "zod";

import type { DbOrTx } from "@ostra/db";
import { effortLevelFromDb, effortLevelToDb } from "@ostra/db";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { modelNameColumns, modelNameOfColumns, modelNameOfModel, modelNameText } from "../providers/model-name.ts";
import { loadListedModelsInTx, loadProviderList } from "../providers/provider-lists.ts";
import { resolveProfileModel, resolveProjectModel } from "../providers/resolve.ts";
import { BUILT_IN_PROFILE_ADAPTER, ensureBuiltInAgentProfile } from "./agent-profiles.ts";
import type { UseCaseResult } from "./common.ts";
import type { ArchiveAgentProfile, ProfilesForMember, SaveAgentProfile, SetProjectDefaultProfile } from "./m3-signatures.ts";

// F-021, ADR 0049 (ticket 34): an agent profile's own setup (its rules, skills, MCP servers, plan
// first and who may use it), its archive, which profiles a member may start a task with, and a
// project's defaults. The signatures are `m3-signatures.ts`'s; these are their bodies.

/**
 * The agents an admin may pick for a profile: the `AgentAdapter`s this install ships. Claude Code
 * joins when its adapter does (milestone 7): a profile naming an agent nobody can launch would only
 * fail a task later.
 */
export const SELECTABLE_AGENT_ADAPTERS: readonly string[] = [BUILT_IN_PROFILE_ADAPTER];

/** The limits of a profile's text and lists (working values, ADR 0049). */
export const profileLimits = {
  nameMax: 100,
  instructionsMax: 65_536,
  skillBodyMax: runnerLimits.skillFileMaxBytes,
  skillNameMax: 64,
  skillFilesMax: runnerLimits.skillFilesMax,
  skillFileMaxBytes: runnerLimits.skillFileMaxBytes,
  skillsMax: runnerLimits.skillsMax,
  mcpServersMax: 20,
  headersMax: 20,
  mcpArgsMax: 50,
  mcpEnvMax: 50,
  listedMembersMax: 500,
} as const;

/** A skill's or an MCP server's name: lowercase letters, digits and dashes. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An HTTP header's name (RFC 9110 token characters). */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/;
const ENV_NAME = /^[A-Za-z_]\w*$/;

const secretRef = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[a-z][a-z0-9-]*:\S+$/);

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "an http or https URL");

/** The profile's `mcpServers` column, as `saveAgentProfile` writes it and the panel and core read it. */
export const profileMcpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    name: z.string().regex(SLUG).max(profileLimits.skillNameMax),
    transport: z.literal("http"),
    url: httpUrl,
    readOnly: z.boolean(),
    headerSecretRefs: z.record(z.string().regex(HEADER_NAME), secretRef).refine((headers) => Object.keys(headers).length <= profileLimits.headersMax, "too many headers"),
  }),
  z.strictObject({
    name: z.string().regex(SLUG).max(profileLimits.skillNameMax),
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(1024)).max(profileLimits.mcpArgsMax),
    env: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).refine((env) => Object.keys(env).length <= profileLimits.mcpEnvMax, "too many variables"),
    readOnly: z.boolean(),
  }),
]);
export const profileMcpServersSchema = z.array(profileMcpServerSchema).max(profileLimits.mcpServersMax);

/** A skill's file path: relative, forward slashes, nothing that leaves the skill's folder. */
export const skillFilePathValid = (path: string): boolean => {
  if (path === "" || path.length > 512 || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

type SaveError = "forbidden" | "not-found" | "name-taken" | "built-in-is-everyones" | "archived" | "invalid-input";
type SaveResult = UseCaseResult<{ readonly profileId: AgentProfileId }, SaveError>;

const refuseSave = (error: SaveError, message: string): SaveResult => ({ ok: false, error, message });

/** The names of the fields a save changed, for the audit entry: never a value. */
const changedFields = (before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

/**
 * Creates or edits a profile (F-021): organization admins only. Validates the rules by the
 * protocol's schema, the MCP servers and the skills by this module's, and that the model and every
 * listed member belong to the organization. The built-in profile can be edited, but stays open to
 * everyone and stays an OpenCode profile. One transaction: the row, its skills and members, the
 * audit entry and the change notice.
 */
export const saveAgentProfile: SaveAgentProfile = async (deps, scope, input) => {
  if (scope.role !== "admin") {
    return refuseSave("forbidden", "Only an organization admin may change agent profiles");
  }
  const organizationId = scope.organizationId;
  const name = input.name.trim();
  if (name === "" || name.length > profileLimits.nameMax) {
    return refuseSave("invalid-input", `A profile's name is 1 to ${String(profileLimits.nameMax)} characters`);
  }
  if (!SELECTABLE_AGENT_ADAPTERS.includes(input.adapter)) {
    return refuseSave("invalid-input", `No agent named ${input.adapter} is installed`);
  }
  if (input.instructions !== null && input.instructions.length > profileLimits.instructionsMax) {
    return refuseSave("invalid-input", "The instructions are too long");
  }
  const rules = approvalRulesSchema.safeParse(input.approvalRules);
  if (!rules.success) {
    return refuseSave("invalid-input", "An approval rule is invalid: its match must fit its tool");
  }
  const servers = profileMcpServersSchema.safeParse(input.mcpServers);
  if (!servers.success || new Set(servers.data.map((server) => server.name)).size !== servers.data.length) {
    return refuseSave("invalid-input", "An MCP server is invalid, or two share a name");
  }
  if (input.skills.length > profileLimits.skillsMax || new Set(input.skills.map((skill) => skill.name)).size !== input.skills.length) {
    return refuseSave("invalid-input", "Another skill already has that name");
  }
  for (const skill of input.skills) {
    if (!SLUG.test(skill.name) || skill.name.length > profileLimits.skillNameMax) {
      return refuseSave("invalid-input", "A skill's name is lowercase letters, digits and dashes only");
    }
    if (skill.body.length > profileLimits.skillBodyMax) {
      return refuseSave("invalid-input", `${skill.name}'s SKILL.md is over 1 MiB`);
    }
    if (skill.files.length > profileLimits.skillFilesMax) {
      return refuseSave("invalid-input", "A skill holds at most 20 files");
    }
    const paths = skill.files.map((file) => file.path);
    if (!paths.every(skillFilePathValid) || new Set(paths).size !== paths.length || paths.includes("SKILL.md")) {
      return refuseSave("invalid-input", "A skill file's path must be relative, inside the skill, and listed once");
    }
  }
  if (input.access.kind === "listed") {
    if (new Set(input.access.members).size !== input.access.members.length) {
      return refuseSave("invalid-input", "A member is listed twice");
    }
    if (input.access.members.length > profileLimits.listedMembersMax) {
      return refuseSave("invalid-input", "Too many members are listed");
    }
  }

  return deps.db.$transaction(async (tx): Promise<SaveResult> => {
    const existing = input.profileId === null ? null : await tx.agentProfile.findFirst({ where: { id: input.profileId, organizationId }, include: { skills: true, members: true } });
    if (input.profileId !== null && existing === null) {
      return refuseSave("not-found", "No such agent profile");
    }
    if (existing !== null && existing.archivedAt !== null) {
      return refuseSave("archived", "An archived profile can't be edited");
    }
    if (existing?.builtIn === true) {
      if (input.access.kind !== "everyone") {
        return refuseSave("built-in-is-everyones", "The built-in profile is open to everyone");
      }
      if (input.adapter !== existing.adapter) {
        return refuseSave("invalid-input", "The built-in profile's agent can't change");
      }
    }
    if (existing !== null && input.access.kind === "listed") {
      const defaults = await tx.project.count({
        where: { organizationId, OR: [{ defaultRefineProfileId: existing.id }, { defaultCodeProfileId: existing.id }, { defaultReviewProfileId: existing.id }] },
      });
      if (defaults > 0) {
        return refuseSave("invalid-input", "A project defaults to this profile, so it must stay open to everyone");
      }
    }
    const clash = await tx.agentProfile.findFirst({
      where: { organizationId, name, ...(input.profileId === null ? {} : { id: { not: input.profileId } }) },
      select: { id: true },
    });
    if (clash !== null) {
      return refuseSave("name-taken", "Another profile already has that name");
    }
    // The provider (F-135, F-021; ADR 0065 amended 2026-11-20): absent keeps the stored one, and a
    // model given as one provider's row (`modelId`) names that provider, unless the profile had none.
    const byRow =
      (input.modelName === undefined || input.modelName === null) && input.modelId !== null
        ? await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { providerId: true } })
        : null;
    const stored = existing?.providerId ?? null;
    const providerId = input.providerId !== undefined ? input.providerId : byRow !== null && stored !== null ? byRow.providerId : stored;
    if (byRow !== null && providerId !== null && providerId !== byRow.providerId) {
      return refuseSave("invalid-input", "The model is another provider's");
    }
    const provider = providerId === null ? null : await tx.modelProvider.findFirst({ where: { id: providerId, organizationId }, select: { id: true, name: true } });
    if (providerId !== null && provider === null) {
      return refuseSave("invalid-input", "No such provider");
    }
    // The model by name (F-135): the name is what the profile means; `modelId` is still written,
    // as its provider's row for it (or, with no provider, the default list's), so the previous
    // release reads the same profile.
    let modelId = input.modelId;
    let nameColumns: { readonly modelCatalogId: string | null; readonly modelCustomName: string | null } = { modelCatalogId: null, modelCustomName: null };
    if (input.modelName !== undefined && input.modelName !== null && provider !== null) {
      nameColumns = modelNameColumns(input.modelName);
      const served = resolveProfileModel([providerIdSchema.parse(provider.id)], [], await loadListedModelsInTx(tx, organizationId), input.modelName, providerIdSchema.parse(provider.id));
      const unchanged =
        existing !== null &&
        existing.providerId === provider.id &&
        JSON.stringify(modelNameOfColumns(existing)) === JSON.stringify(modelNameOfColumns(nameColumns));
      // A profile names only a model its provider lists; one saved before that it stopped listing
      // keeps saving, and its tasks wait with the reason (the no-key path).
      if (!served.ok && !unchanged) {
        return refuseSave("invalid-input", `${provider.name} doesn't list ${modelNameText(input.modelName)}`);
      }
      modelId = served.ok ? served.modelId : existing?.modelId ?? null;
    } else if (input.modelName !== undefined && input.modelName !== null) {
      nameColumns = modelNameColumns(input.modelName);
      const defaults = await loadProviderList(tx, organizationId, null);
      const resolved = defaults === null ? null : resolveProjectModel(defaults.list, defaults.choices, defaults.models, input.modelName);
      modelId = resolved?.ok === true ? resolved.modelId : null;
    } else if (providerId !== null && byRow === null) {
      return refuseSave("invalid-input", "A profile on a provider names one of its models");
    } else if (input.modelId !== null) {
      const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { listed: true, catalogId: true, endpointModelId: true } });
      if (model === null) {
        return refuseSave("invalid-input", "No such model");
      }
      if (!model.listed) {
        return refuseSave("invalid-input", "The endpoint no longer lists that model");
      }
      nameColumns = modelNameColumns(modelNameOfModel(model));
    }
    if (input.access.kind === "listed") {
      const found = await tx.member.count({ where: { organizationId, id: { in: [...input.access.members] } } });
      if (found !== input.access.members.length) {
        return refuseSave("invalid-input", "A listed member isn't in this organization");
      }
    }
    const blobIds = [...new Set(input.skills.flatMap((skill) => skill.files.map((file) => file.blobId)))];
    if (blobIds.length > 0) {
      const blobs = await tx.blob.findMany({ where: { id: { in: blobIds }, organizationId }, select: { id: true, size: true } });
      if (blobs.length !== blobIds.length) {
        return refuseSave("invalid-input", "A skill file isn't uploaded");
      }
      if (blobs.some((blob) => blob.size > profileLimits.skillFileMaxBytes)) {
        return refuseSave("invalid-input", "A skill file is over 1 MiB");
      }
    }

    const data = {
      name,
      adapter: input.adapter,
      modelId,
      providerId,
      instructions: input.instructions === null || input.instructions.trim() === "" ? null : input.instructions,
      approvalRules: rules.data,
      planFirst: input.planFirst,
      access: input.access.kind,
      mcpServers: servers.data,
      // F-137: the level, kept when the save leaves it out.
      effort: effortLevelToDb[input.effort ?? (existing === null ? "default" : effortLevelFromDb[existing.effort])],
      // F-111: the closing turn's switch, kept when the save leaves it out.
      closingTurn: input.closingTurn ?? existing?.closingTurn ?? false,
    };
    const saved =
      existing === null
        ? await tx.agentProfile.create({ data: { organizationId, ...data, ...nameColumns }, select: { id: true } })
        : await tx.agentProfile.update({ where: { id: existing.id }, data: { ...data, ...nameColumns }, select: { id: true } });
    const profileId = agentProfileIdSchema.parse(saved.id);

    // Who may use it, and its skills: each replaced as a set (small, bounded lists).
    await tx.agentProfileMember.deleteMany({ where: { profileId, organizationId } });
    if (input.access.kind === "listed") {
      await tx.agentProfileMember.createMany({ data: input.access.members.map((memberId) => ({ organizationId, profileId, memberId })) });
    }
    await tx.agentProfileSkill.deleteMany({ where: { profileId, organizationId } });
    if (input.skills.length > 0) {
      await tx.agentProfileSkill.createMany({
        data: input.skills.map((skill) => ({
          organizationId,
          profileId,
          name: skill.name,
          body: skill.body,
          files: skill.files.map((file) => ({ path: file.path, blobId: file.blobId })),
        })),
      });
    }

    const skillsOf = (skills: readonly { readonly name: string; readonly body: string; readonly files: unknown }[]): string =>
      JSON.stringify(skills.map((skill) => [skill.name, skill.body, skill.files]).sort());
    const changed =
      existing === null
        ? []
        : changedFields(
            {
              name: existing.name,
              adapter: existing.adapter,
              modelId: existing.modelId,
              providerId: existing.providerId,
              instructions: existing.instructions,
              approvalRules: existing.approvalRules,
              planFirst: existing.planFirst,
              access: existing.access,
              mcpServers: existing.mcpServers,
              effort: existing.effort,
              closingTurn: existing.closingTurn,
              skills: skillsOf(existing.skills),
              members: existing.members.map((member) => member.memberId).sort(),
            },
            {
              ...data,
              skills: skillsOf(input.skills.map((skill) => ({ ...skill, files: skill.files.map((file) => ({ path: file.path, blobId: file.blobId })) }))),
              members: input.access.kind === "listed" ? [...input.access.members].sort() : [],
            },
          );
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: existing === null ? "agent-profile.created" : "agent-profile.updated",
      entity: "agent-profile",
      entityId: profileId,
      // Field names and counts only: no instructions, no rule text, no header, no skill body.
      data: {
        agent: input.adapter,
        rules: rules.data.length,
        skills: input.skills.length,
        mcpServers: servers.data.length,
        access: input.access.kind,
        planFirst: input.planFirst,
        effort: data.effort,
        closingTurn: data.closingTurn,
        changed: changed.join(","),
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: profileId });
    return { ok: true, profileId };
  });
};

/**
 * Archives a profile (Q189): any but the built-in one. In the same transaction every project
 * default that points at it moves to the built-in profile, and the audit entry names those projects.
 */
export const archiveAgentProfile: ArchiveAgentProfile = async (deps, scope, input) => {
  if (scope.role !== "admin") {
    return { ok: false, error: "forbidden", message: "Only an organization admin may archive an agent profile" };
  }
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const profile = await tx.agentProfile.findFirst({ where: { id: input.profileId, organizationId }, select: { id: true, builtIn: true, builtInKind: true, archivedAt: true } });
    if (profile === null) {
      return { ok: false, error: "not-found", message: "No such agent profile" } as const;
    }
    if (profile.builtIn || profile.builtInKind !== null) {
      // Milestone 6 (F-099): the built-in Refine and Review profiles can be edited, never archived.
      return { ok: false, error: "built-in", message: "A built-in profile can't be archived" } as const;
    }
    const builtInId = await ensureBuiltInAgentProfile(tx, organizationId);
    const moved = new Set<string>();
    for (const column of ["defaultRefineProfileId", "defaultCodeProfileId", "defaultReviewProfileId"] as const) {
      const projects = await tx.project.findMany({ where: { organizationId, [column]: profile.id }, select: { id: true } });
      if (projects.length > 0) {
        await tx.project.updateMany({ where: { organizationId, [column]: profile.id }, data: { [column]: builtInId } });
        for (const project of projects) {
          moved.add(project.id);
        }
      }
    }
    if (profile.archivedAt === null) {
      await tx.agentProfile.update({ where: { id: profile.id }, data: { archivedAt: new Date(deps.clock.now()) } });
    }
    const movedDefaults = [...moved].map((id) => projectIdSchema.parse(id));
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "agent-profile.archived",
      entity: "agent-profile",
      entityId: input.profileId,
      data: { movedDefaults: movedDefaults.join(",") },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: input.profileId });
    for (const projectId of movedDefaults) {
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
    }
    return { ok: true, movedDefaults } as const;
  });
};

/**
 * The profiles a member may start a task with (F-021): never archived ones; open to everyone, or
 * listing the member; an organization admin sees every one. The built-in profile first, then by name.
 */
export const profilesForMember: ProfilesForMember = async (db, scope, input) => {
  const organizationId = scope.organizationId;
  if (input.projectId !== null && (await db.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true } })) === null) {
    return [];
  }
  const rows = await db.agentProfile.findMany({
    where: {
      organizationId,
      archivedAt: null,
      ...(scope.role === "admin" ? {} : { OR: [{ access: "everyone" as const }, { members: { some: { memberId: scope.memberId } } }] }),
    },
    orderBy: [{ builtIn: "desc" }, { name: "asc" }],
    select: { id: true, name: true, builtIn: true, planFirst: true },
  });
  return rows.map((row) => ({ profileId: agentProfileIdSchema.parse(row.id), name: row.name, builtIn: row.builtIn, planFirst: row.planFirst }));
};

/** The `Project` column that holds each task kind's default profile. */
export const defaultProfileColumn = {
  refine: "defaultRefineProfileId",
  code: "defaultCodeProfileId",
  review: "defaultReviewProfileId",
} as const satisfies Record<TaskKind, string>;

/** A project's default profile for a task kind: project admins; the profile must be open to every member of the project. */
export const setProjectDefaultProfile: SetProjectDefaultProfile = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" } as const;
    }
    const access = requireProjectAccess(scope, { id: input.projectId, organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found"
        ? ({ ok: false, error: "not-found", message: "No such project" } as const)
        : ({ ok: false, error: "forbidden", message: "Only a project admin may set its defaults" } as const);
    }
    const profile = await tx.agentProfile.findFirst({
      where: { id: input.profileId, organizationId },
      select: { id: true, access: true, archivedAt: true, providerId: true, provider: { select: { name: true } } },
    });
    if (profile === null) {
      return { ok: false, error: "not-found", message: "No such agent profile" } as const;
    }
    if (profile.archivedAt !== null) {
      return { ok: false, error: "archived", message: "An archived profile can't be a default" } as const;
    }
    if (profile.access !== "everyone") {
      return { ok: false, error: "not-open-to-every-member", message: "A default must be open to every member of the project" } as const;
    }
    // F-135 (ADR 0065 amended 2026-11-20): the project's list decides which profiles run there.
    if (profile.providerId !== null) {
      const list = await loadProviderList(tx, organizationId, input.projectId);
      if (!(list?.list.some((providerId) => providerId === profile.providerId) ?? false)) {
        return {
          ok: false,
          error: "provider-not-allowed",
          message: `The profile runs on ${profile.provider?.name ?? "a provider"}, which this project's list doesn't allow: an organization admin adds it in Models and keys`,
        } as const;
      }
    }
    await tx.project.update({ where: { id: input.projectId }, data: { [defaultProfileColumn[input.kind]]: profile.id } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.default-profile-set",
      entity: "agent-profile",
      entityId: input.profileId,
      data: { kind: input.kind },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: input.profileId });
    return { ok: true, profileId: input.profileId } as const;
  });
};

/**
 * Whether a member may start a task with a profile they chose (F-021): it exists in their
 * organization and isn't archived, and it's open to everyone or lists them (admins use every one).
 * The refusal names the profile, since a member who picked it should see which one.
 */
export type ProfileUse =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "no-agent-profile" | "forbidden"; readonly message: string };

export const checkProfileUse = async (db: DbOrTx, scope: MemberScope, profileId: AgentProfileId): Promise<ProfileUse> => {
  const profile = await db.agentProfile.findFirst({
    where: { id: profileId, organizationId: scope.organizationId },
    select: { name: true, access: true, archivedAt: true, members: { where: { memberId: scope.memberId }, select: { id: true } } },
  });
  if (profile === null) {
    return { ok: false, error: "no-agent-profile", message: "No such agent profile" };
  }
  if (profile.archivedAt !== null) {
    return { ok: false, error: "no-agent-profile", message: `The agent profile "${profile.name}" is archived` };
  }
  if (scope.role !== "admin" && profile.access === "listed" && profile.members.length === 0) {
    return { ok: false, error: "forbidden", message: `You may not use the agent profile "${profile.name}"` };
  }
  return { ok: true };
};
