import { randomUUID } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";
import { apiFormatFromDb, effortLevelFromDb } from "@ostra/db";
import {
  agentDisplayName,
  archiveAgentProfile,
  loadListedModelsInTx,
  loadProviderList,
  modelNameColumns,
  modelNameKey,
  modelNameOfModel,
  modelNameSchema,
  modelNameText,
  PRESET_NAMES,
  presetRules,
  profileLimits,
  profileMcpServersSchema,
  profileModelName,
  profilesForMember,
  resolveProfileModel,
  resolveProjectModel,
  saveAgentProfile,
  setProfileLabels,
  SELECTABLE_AGENT_ADAPTERS,
  visibleProjects,
} from "@ostra/domain";
import type { MemberScope, ModelName, ProfileMcpServer } from "@ostra/domain";
import {
  agentProfileIdSchema,
  apiFormatSchema,
  approvalRuleMatchSchema,
  approvalRulePresetSchema,
  approvalRuleSchema,
  approvalRulesSchema,
  approvalSubjectSchema,
  approvalToolSchema,
  blobIdSchema,
  HTTP_HEADER_VALUE,
  clampEffort,
  effortLevelSchema,
  memberIdSchema,
  modelIdSchema,
  projectIdSchema,
  providerIdSchema,
  ruleMatches,
  taskKindSchema,
} from "@ostra/protocol";
import type { AgentProfileId, ApprovalRequestSubject, ApprovalRule, ApprovalTool, EffortLevel, ModelId, OrganizationId, ProviderId, RuleContext } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { effortLevelViewSchema, levelRefusal, levelsOfModel, loadModelEffort, reasoningOf, reasoningSourceSchema, toLevelViews } from "../services/agent-effort.ts";
import type { AgentEffort } from "../services/agent-effort.ts";
import { adminProcedure, loadProjectAccess, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-021, F-026 (the rules), F-063 (the switch), ticket 34: agent profiles. Any member sees the
// profiles they may use (an organization admin sees all); organization admins create, edit and
// archive. An HTTP MCP server's header values are written to the secret store here and only their
// references are kept; no procedure returns a value, only "set" (ADR 0049).

const epoch = (date: Date | null): number | null => (date === null ? null : date.getTime());

/** Up to two initials of a name, for a member's avatar. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => (word.codePointAt(0) === undefined ? "" : String.fromCodePoint(word.codePointAt(0) ?? 63).toUpperCase()))
    .join("");

// ---------- views ----------

const modelViewSchema = z.object({
  id: modelIdSchema,
  endpointModelId: z.string(),
  displayName: z.string().nullable(),
  providerId: providerIdSchema,
  providerName: z.string(),
  apiFormat: apiFormatSchema,
});

const accessViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("listed"), members: z.array(z.object({ memberId: memberIdSchema, name: z.string(), initials: z.string() })) }),
]);

const ruleViewSchema = z.object({
  ruleId: approvalRuleSchema.shape.ruleId,
  name: z.string(),
  tool: approvalToolSchema,
  preset: approvalRulePresetSchema.nullable(),
  match: approvalRuleMatchSchema,
});

const lastEditSchema = z.object({
  action: z.enum(["created", "updated", "archived", "model-set"]),
  actorName: z.string().nullable(),
  at: z.number(),
});

const profileRowSchema = z.object({
  id: agentProfileIdSchema,
  name: z.string(),
  adapter: z.string(),
  agentName: z.string(),
  builtIn: z.boolean(),
  model: modelViewSchema.nullable(),
  /** F-135 (ADR 0065): the model by name, as the profile saved it. */
  modelName: modelNameSchema.nullable(),
  /**
   * F-135, F-021 (ADR 0065 amended 2026-11-20): the provider whose key its tasks use, and no other.
   * `null`: a profile saved before, which each project's own choice serves by name until an admin
   * picks one.
   */
  provider: z.object({ providerId: providerIdSchema, name: z.string() }).nullable(),
  /** F-137: how much its model reasons; a new task copies it. */
  effort: effortLevelSchema,
  planFirst: z.boolean(),
  /** F-111 (ADR 0044 amended): whether a task ends with a closing turn that proposes what it learned. */
  closingTurn: z.boolean(),
  /** Milestone 5 (F-069): the labels a runner must carry to take its tasks. */
  runnerLabels: z.array(z.string()),
  access: accessViewSchema,
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  rules: z.array(ruleViewSchema),
  skills: z.array(z.string()),
  mcpServers: z.array(z.object({ name: z.string(), transport: z.enum(["http", "stdio"]), readOnly: z.boolean() })),
  /** Each project and task kind that defaults to it, only for projects the viewer can open. */
  defaults: z.array(z.object({ projectId: projectIdSchema, projectName: z.string(), kind: taskKindSchema })),
  lastEdit: lastEditSchema.nullable(),
});

/**
 * The Effort control's choices on one model, for one agent (F-137, ADR 0066): the levels, `Default`
 * first (`Default` alone: no control), the level the stored one runs at by the clamp and whether it
 * moved, where the model's controls came from (`null`: nobody said, so a custom model doesn't
 * reason), and whether the agent takes a level at all.
 */
const effortOptionsSchema = z.object({
  levels: z.array(effortLevelViewSchema),
  runsAt: effortLevelSchema,
  adjusted: z.boolean(),
  reasoningSource: reasoningSourceSchema,
  customModel: z.boolean(),
  agentTakesEffort: z.boolean(),
});

type ModelForEffort = Parameters<typeof levelsOfModel>[2] & { readonly catalogId: string | null };

const effortOptionsOf = (effort: AgentEffort, adapter: string, model: ModelForEffort | null, stored: EffortLevel): z.infer<typeof effortOptionsSchema> => {
  const levels = model === null ? (["default"] as const) : levelsOfModel(effort, adapter, model);
  const clamped = clampEffort(stored, levels);
  return {
    levels: toLevelViews(levels),
    runsAt: clamped.level,
    adjusted: clamped.adjusted,
    reasoningSource: model === null ? null : reasoningOf(model).source,
    customModel: model !== null && model.catalogId === null,
    agentTakesEffort: effort.capabilityOf(adapter) !== "none",
  };
};

const mcpViewSchema = z.discriminatedUnion("transport", [
  z.object({
    name: z.string(),
    transport: z.literal("http"),
    url: z.string(),
    readOnly: z.boolean(),
    /** Header names only: a value is never returned. */
    headers: z.array(z.object({ name: z.string(), set: z.literal(true) })),
  }),
  z.object({ name: z.string(), transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()), readOnly: z.boolean() }),
]);

const profileDetailSchema = profileRowSchema.omit({ skills: true, mcpServers: true }).extend({
  instructions: z.string().nullable(),
  skills: z.array(
    z.object({
      name: z.string(),
      /** The `SKILL.md` text; the panel reads its description from it. */
      body: z.string(),
      files: z.array(z.object({ path: z.string(), blobId: blobIdSchema, size: z.number().nullable() })),
    }),
  ),
  mcpServers: z.array(mcpViewSchema),
  /** How many tasks started with it. */
  usedBy: z.number().int(),
  createdBy: z.object({ name: z.string().nullable(), at: z.number() }),
  archivedBy: z.object({ name: z.string().nullable(), at: z.number() }).nullable(),
  /** Whether the viewer can edit it: an organization admin, and it isn't archived. */
  canEdit: z.boolean(),
  /** F-137: what the Effort control offers on its model (ADR 0066). */
  effortOptions: effortOptionsSchema,
});

type ProfileRow = Awaited<ReturnType<typeof loadRows>>[number];

const profileInclude = {
  model: { include: { provider: { select: { id: true, name: true, apiFormat: true } } } },
  provider: { select: { id: true, name: true } },
  skills: { select: { name: true, body: true, files: true }, orderBy: { name: "asc" } },
  members: { select: { member: { select: { id: true, user: { select: { name: true } } } } } },
} as const;

const loadRows = async (db: AgentProfileDb, organizationId: OrganizationId, ids: readonly string[]) =>
  db.agentProfile.findMany({
    where: { organizationId, id: { in: [...ids] } },
    orderBy: [{ builtIn: "desc" }, { name: "asc" }],
    include: profileInclude,
  });

type AgentProfileDb = Parameters<typeof profilesForMember>[0];

const parseRules = (value: unknown): ApprovalRule[] => {
  const parsed = approvalRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const parseServers = (value: unknown): ProfileMcpServer[] => {
  const parsed = profileMcpServersSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const defaultKinds = [
  { kind: "refine", column: "defaultRefineProfileId" },
  { kind: "code", column: "defaultCodeProfileId" },
  { kind: "review", column: "defaultReviewProfileId" },
] as const;

type Names = ReadonlyMap<string, string>;

/** The audit entries that say who last changed each profile, and who created and archived it. */
const loadAuditTrail = async (db: AgentProfileDb, organizationId: OrganizationId, ids: readonly string[]) => {
  const entries = await db.auditEntry.findMany({
    where: { organizationId, entity: "agent-profile", entityId: { in: [...ids] }, action: { in: ["agent-profile.created", "agent-profile.updated", "agent-profile.archived", "agent-profile.model-set"] } },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, action: true, actorId: true, createdAt: true },
  });
  const actorIds = [...new Set(entries.flatMap((entry) => (entry.actorId === null ? [] : [entry.actorId])))];
  const members = await db.member.findMany({ where: { organizationId, id: { in: actorIds } }, select: { id: true, user: { select: { name: true } } } });
  const names: Names = new Map(members.map((member) => [member.id, member.user.name] as const));
  return { entries, names };
};

const toRow = async (
  db: AgentProfileDb,
  scope: MemberScope,
  rows: readonly ProfileRow[],
): Promise<z.infer<typeof profileRowSchema>[]> => {
  const ids = rows.map((row) => row.id);
  const organizationId = scope.organizationId;
  const projectRows = await db.project.findMany({
    where: { organizationId, OR: defaultKinds.map(({ column }) => ({ [column]: { in: ids } })) },
    select: { id: true, name: true, access: true, defaultRefineProfileId: true, defaultCodeProfileId: true, defaultReviewProfileId: true },
  });
  const visible = visibleProjects(
    scope,
    projectRows.map((row) => ({ id: projectIdSchema.parse(row.id), organizationId, access: row.access, row })),
  );
  const { entries, names } = await loadAuditTrail(db, organizationId, ids);
  return rows.map((row) => {
    const last = entries.find((entry) => entry.entityId === row.id);
    const action = last?.action.replace("agent-profile.", "");
    return {
      id: agentProfileIdSchema.parse(row.id),
      name: row.name,
      adapter: row.adapter,
      agentName: agentDisplayName(row.adapter),
      builtIn: row.builtIn,
      model:
        row.model === null
          ? null
          : {
              id: modelIdSchema.parse(row.model.id),
              endpointModelId: row.model.endpointModelId,
              displayName: row.model.displayName,
              providerId: providerIdSchema.parse(row.model.provider.id),
              providerName: row.model.provider.name,
              apiFormat: apiFormatFromDb[row.model.provider.apiFormat],
            },
      modelName: profileModelName(row),
      provider: row.provider === null ? null : { providerId: providerIdSchema.parse(row.provider.id), name: row.provider.name },
      effort: effortLevelFromDb[row.effort],
      planFirst: row.planFirst,
      closingTurn: row.closingTurn,
      runnerLabels: [...row.runnerLabels],
      access:
        row.access === "everyone"
          ? { kind: "everyone" as const }
          : {
              kind: "listed" as const,
              members: row.members.map(({ member }) => ({ memberId: memberIdSchema.parse(member.id), name: member.user.name, initials: initialsOf(member.user.name) })),
            },
      archivedAt: epoch(row.archivedAt),
      createdAt: row.createdAt.getTime(),
      rules: parseRules(row.approvalRules).map((rule) => ({ ruleId: rule.ruleId, name: rule.name, tool: rule.tool, preset: rule.preset ?? null, match: rule.match })),
      skills: row.skills.map((skill) => skill.name),
      mcpServers: parseServers(row.mcpServers).map((server) => ({ name: server.name, transport: server.transport, readOnly: server.readOnly })),
      defaults: visible.flatMap(({ row: project }) =>
        defaultKinds.flatMap(({ kind, column }) => (project[column] === row.id ? [{ projectId: projectIdSchema.parse(project.id), projectName: project.name, kind }] : [])),
      ),
      lastEdit:
        last === undefined || action === undefined
          ? null
          : lastEditSchema.parse({ action, actorName: last.actorId === null ? null : (names.get(last.actorId) ?? null), at: last.createdAt.getTime() }),
    };
  });
};

// ---------- the editor's input ----------

const memberAccessInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("everyone") }),
  z.strictObject({ kind: z.literal("listed"), members: z.array(memberIdSchema).max(profileLimits.listedMembersMax) }),
]);

const mcpServerInput = z.discriminatedUnion("transport", [
  z.strictObject({
    name: z.string().max(profileLimits.skillNameMax),
    transport: z.literal("http"),
    url: z.string().max(2048),
    readOnly: z.boolean().default(false),
    /** A header's value is written to the secret store; `null` keeps the one already stored under the name. */
    headers: z.array(z.strictObject({ name: z.string().max(200), value: z.string().trim().min(1).max(8192).regex(HTTP_HEADER_VALUE, "a header value can't hold a line break or another control character").nullable() })).max(profileLimits.headersMax).default([]),
  }),
  z.strictObject({
    name: z.string().max(profileLimits.skillNameMax),
    transport: z.literal("stdio"),
    command: z.string().max(1024),
    args: z.array(z.string().max(1024)).max(profileLimits.mcpArgsMax).default([]),
    env: z.record(z.string(), z.string().max(4096)).default({}),
    readOnly: z.boolean().default(false),
  }),
]);

const skillInput = z.strictObject({
  name: z.string().max(profileLimits.skillNameMax),
  body: z.string().max(profileLimits.skillBodyMax),
  files: z.array(z.strictObject({ path: z.string().max(512), blobId: blobIdSchema })).max(profileLimits.skillFilesMax),
});

const saveInput = z.strictObject({
  /** Absent creates a profile. */
  profileId: agentProfileIdSchema.optional(),
  name: z.string().max(profileLimits.nameMax),
  adapter: z.string().max(100),
  modelId: modelIdSchema.nullable(),
  /**
   * F-135 (ticket 50, ADR 0065): the model by name, pinning no provider; each project's list then
   * decides which provider serves it. Given, it wins over `modelId`.
   */
  modelName: modelNameSchema.nullable().optional(),
  /**
   * F-135, F-021 (ADR 0065 amended 2026-11-20): the provider whose key and base URL its tasks use;
   * it must list the model. Absent keeps the stored one; `null` resolves the name in each project.
   */
  providerId: providerIdSchema.nullable().optional(),
  instructions: z.string().max(profileLimits.instructionsMax).nullable(),
  approvalRules: approvalRulesSchema,
  planFirst: z.boolean(),
  access: memberAccessInput,
  mcpServers: z.array(mcpServerInput).max(profileLimits.mcpServersMax),
  skills: z.array(skillInput).max(profileLimits.skillsMax),
  /** F-137: one of the model's levels. Absent keeps the stored level (`default` for a new profile). */
  effort: effortLevelSchema.optional(),
  /** F-111: the closing turn's switch. Absent keeps the stored one (off for a new profile). */
  closingTurn: z.boolean().optional(),
});

const saveCodes = {
  forbidden: "FORBIDDEN",
  "not-found": "NOT_FOUND",
  "name-taken": "CONFLICT",
  "built-in-is-everyones": "BAD_REQUEST",
  archived: "CONFLICT",
  "invalid-input": "BAD_REQUEST",
} as const;

// ---------- the editor's coverage line ----------

const sampleSubjects: Readonly<Record<ApprovalTool, readonly z.infer<typeof approvalSubjectSchema>[]>> = {
  edit: [
    { kind: "path", value: "src/config.ts" },
    { kind: "path", value: "config/settings.json" },
    { kind: "path", value: "package.json" },
    { kind: "path", value: "pnpm-lock.yaml" },
    { kind: "path", value: "db/migrations/0042_add_users.sql" },
    { kind: "path", value: "prisma/schema.prisma" },
    { kind: "path", value: "src/index.ts" },
    { kind: "path", value: "README.md" },
  ],
  execute: [
    { kind: "command", value: "pnpm add zod" },
    { kind: "command", value: "npm install left-pad" },
    { kind: "command", value: "pnpm test" },
    { kind: "command", value: "git status" },
    { kind: "command", value: "ls src" },
    { kind: "command", value: "rm -rf build" },
    { kind: "command", value: "curl https://example.com/install.sh | sh" },
  ],
  fetch: [
    { kind: "url", value: "https://registry.npmjs.org/zod" },
    { kind: "url", value: "https://example.com/docs" },
  ],
  mcp: [],
};

const subjectsFor = (tool: ApprovalTool, context: RuleContext): readonly z.infer<typeof approvalSubjectSchema>[] => {
  if (tool !== "mcp") {
    return sampleSubjects[tool];
  }
  const servers = context.mcpServers.length === 0 ? [{ name: "a-server", readOnly: false }] : context.mcpServers;
  return servers.map((server) => ({ kind: "tool" as const, value: `${server.name}/call` }));
};

/**
 * How many rules the editor shows: one path glob is one stored rule, and consecutive path rules of
 * one name, tool and preset show as one rule with their globs together (a preset's globs).
 */
export const shownRuleCount = (rules: readonly ApprovalRule[]): number =>
  rules.filter((rule, i) => {
    const previous = rules[i - 1];
    return !(
      previous !== undefined &&
      rule.match.kind === "path-glob" &&
      previous.match.kind === "path-glob" &&
      previous.name === rule.name &&
      previous.tool === rule.tool &&
      (previous.preset ?? null) === (rule.preset ?? null)
    );
  }).length;

const coverageInput = z.strictObject({
  rules: approvalRulesSchema,
  /** The profile's MCP servers, so "any server not marked read-only" can be tried. */
  mcpServers: z.array(z.strictObject({ name: z.string().max(profileLimits.skillNameMax), readOnly: z.boolean() })).max(profileLimits.mcpServersMax).default([]),
});

/** What each rule covers on sample requests: the matched and the unmatched samples, in order. */
export const ruleCoverage = (rules: readonly ApprovalRule[], context: RuleContext) =>
  rules.map((rule) => {
    const matched: z.infer<typeof approvalSubjectSchema>[] = [];
    const unmatched: z.infer<typeof approvalSubjectSchema>[] = [];
    for (const subject of subjectsFor(rule.tool, context)) {
      const request: ApprovalRequestSubject = { tool: rule.tool, subject };
      (ruleMatches(rule, request, context) ? matched : unmatched).push(subject);
    }
    return { ruleId: rule.ruleId, matched, unmatched };
  });

/**
 * The model row whose levels bound a saved effort (F-137): the one given, else the profile's own
 * provider's row for the name, else the default list's.
 */
const effortRowOf = async (db: AgentProfileDb, organizationId: OrganizationId, input: z.infer<typeof saveInput>): Promise<ModelId | null> => {
  if (input.modelId !== null) {
    return input.modelId;
  }
  if (input.modelName === undefined || input.modelName === null) {
    return null;
  }
  if (input.providerId !== undefined && input.providerId !== null) {
    const served = resolveProfileModel([input.providerId], [], await loadListedModelsInTx(db, organizationId), input.modelName, input.providerId);
    return served.ok ? served.modelId : null;
  }
  const defaults = await loadProviderList(db, organizationId, null);
  const served = defaults === null ? null : resolveProjectModel(defaults.list, defaults.choices, defaults.models, input.modelName);
  return served?.ok === true ? served.modelId : null;
};

// ---------- secrets ----------

const refsOf = (servers: readonly ProfileMcpServer[]): SecretRef[] =>
  servers.flatMap((server) => (server.transport === "http" ? Object.values(server.headerSecretRefs).map((ref) => secretRefSchema.parse(ref)) : []));

export const agentProfilesRouter = router({
  /** The agents an admin may pick: the ones this install ships. */
  agents: memberProcedure.output(z.array(z.object({ adapter: z.string(), name: z.string() }))).query(() =>
    SELECTABLE_AGENT_ADAPTERS.map((adapter) => ({ adapter, name: agentDisplayName(adapter) })),
  ),

  /**
   * The profiles the member may use (an organization admin sees every one), each with what its row
   * and panel show. Archived ones come only to an admin who asks (`includeArchived`).
   */
  list: memberProcedure
    .input(z.strictObject({ includeArchived: z.boolean().optional() }).optional())
    .output(z.array(profileRowSchema))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const usable = await profilesForMember(db, ctx.scope, { projectId: null });
      const ids: string[] = usable.map((profile) => profile.profileId);
      if (ctx.scope.role === "admin" && input?.includeArchived === true) {
        const archived = await db.agentProfile.findMany({ where: { organizationId: ctx.scope.organizationId, archivedAt: { not: null } }, select: { id: true } });
        ids.push(...archived.map((row) => row.id));
      }
      return toRow(db, ctx.scope, await loadRows(db, ctx.scope.organizationId, ids));
    }),

  /** One profile in full, for the editor. A profile the member may not use is `NOT_FOUND`. */
  get: memberProcedure
    .input(z.strictObject({ profileId: agentProfileIdSchema }))
    .output(profileDetailSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const usable = await profilesForMember(db, ctx.scope, { projectId: null });
      const archivedOk = ctx.scope.role === "admin";
      const [row] = await loadRows(db, organizationId, [input.profileId]);
      if (row === undefined || (row.archivedAt === null ? !usable.some((profile) => profile.profileId === input.profileId) : !archivedOk)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such agent profile" });
      }
      const [base] = await toRow(db, ctx.scope, [row]);
      if (base === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such agent profile" });
      }
      const [usedBy, trail, blobs] = await Promise.all([
        db.task.count({ where: { organizationId, agentProfileId: row.id } }),
        loadAuditTrail(db, organizationId, [row.id]),
        db.blob.findMany({
          where: { organizationId, id: { in: row.skills.flatMap((skill) => z.array(z.object({ blobId: z.string() })).catch([]).parse(skill.files).map((file) => file.blobId)) } },
          select: { id: true, size: true },
        }),
      ]);
      const sizeOf = new Map(blobs.map((blob) => [blob.id, blob.size] as const));
      const created = trail.entries.findLast((entry) => entry.action === "agent-profile.created");
      const archived = trail.entries.find((entry) => entry.action === "agent-profile.archived");
      const nameOf = (actorId: string | null): string | null => (actorId === null ? null : (trail.names.get(actorId) ?? null));
      return {
        ...base,
        instructions: row.instructions,
        skills: row.skills.map((skill) => ({
          name: skill.name,
          body: skill.body,
          files: z
            .array(z.object({ path: z.string(), blobId: blobIdSchema }))
            .catch([])
            .parse(skill.files)
            .map((file) => ({ ...file, size: sizeOf.get(file.blobId) ?? null })),
        })),
        mcpServers: parseServers(row.mcpServers).map((server) =>
          server.transport === "http"
            ? { name: server.name, transport: "http" as const, url: server.url, readOnly: server.readOnly, headers: Object.keys(server.headerSecretRefs).map((name) => ({ name, set: true as const })) }
            : { name: server.name, transport: "stdio" as const, command: server.command, args: [...server.args], env: { ...server.env }, readOnly: server.readOnly },
        ),
        usedBy,
        createdBy: { name: nameOf(created?.actorId ?? null), at: (created?.createdAt ?? row.createdAt).getTime() },
        archivedBy: archived === undefined ? null : { name: nameOf(archived.actorId), at: archived.createdAt.getTime() },
        canEdit: ctx.scope.role === "admin" && row.archivedAt === null,
        effortOptions: effortOptionsOf(ctx.deps.agentEffort, row.adapter, row.model, effortLevelFromDb[row.effort]),
      };
    }),

  /**
   * What a task start offers (ticket 34): the profiles the member may use in this project, the
   * project's default for the kind first. Each says whether it has a model, since a task can't
   * start without one.
   */
  forStart: memberProcedure
    .input(z.strictObject({ projectId: projectIdSchema, kind: taskKindSchema }))
    .output(
      z.array(
        z.object({
          profileId: agentProfileIdSchema,
          name: z.string(),
          builtIn: z.boolean(),
          planFirst: z.boolean(),
          /** How many approval rules it has as the editor shows them, for the picker's small facts (ticket 42). */
          ruleCount: z.number().int(),
          isDefault: z.boolean(),
          agentName: z.string(),
          modelName: z.string().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      await loadProjectAccess(db, ctx.scope, input.projectId, "read");
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, organizationId: ctx.scope.organizationId },
        select: { defaultRefineProfileId: true, defaultCodeProfileId: true, defaultReviewProfileId: true },
      });
      const defaultId = { refine: project.defaultRefineProfileId, code: project.defaultCodeProfileId, review: project.defaultReviewProfileId }[input.kind];
      const [usable, list] = await Promise.all([
        profilesForMember(db, ctx.scope, { projectId: input.projectId }),
        loadProviderList(db, ctx.scope.organizationId, input.projectId),
      ]);
      const rows = await db.agentProfile.findMany({
        where: { organizationId: ctx.scope.organizationId, id: { in: usable.map((profile) => profile.profileId) } },
        select: { id: true, adapter: true, approvalRules: true, providerId: true, model: { select: { endpointModelId: true, displayName: true } } },
      });
      const byId = new Map(rows.map((row) => [row.id, row] as const));
      // F-135 (ADR 0065 amended 2026-11-20): the project's list decides which profiles run here, so
      // a profile on a provider it doesn't allow isn't offered.
      const allowed = new Set<string>(list?.list ?? []);
      const offered = usable.filter((profile) => {
        const providerId = byId.get(profile.profileId)?.providerId ?? null;
        return providerId === null || allowed.has(providerId);
      }).map((profile) => {
        const row = byId.get(profile.profileId);
        return {
          profileId: profile.profileId,
          name: profile.name,
          builtIn: profile.builtIn,
          planFirst: profile.planFirst,
          ruleCount: shownRuleCount(approvalRulesSchema.catch([]).parse(row?.approvalRules ?? [])),
          isDefault: profile.profileId === defaultId,
          agentName: agentDisplayName(row?.adapter ?? ""),
          modelName: row?.model === null || row?.model === undefined ? null : (row.model.displayName ?? row.model.endpointModelId),
        };
      });
      // The default first; the rest keep the built-in-then-name order.
      return [...offered.filter((profile) => profile.isDefault), ...offered.filter((profile) => !profile.isDefault)];
    }),

  /**
   * F-137 (ADR 0066): the levels an agent offers on a model, for the editor's Effort control as the
   * admin picks the model, and what a stored level runs at there. Any member; another
   * organization's model is `NOT_FOUND`.
   */
  effortLevels: memberProcedure
    .input(z.strictObject({ adapter: z.string().max(100), modelId: modelIdSchema, stored: effortLevelSchema.optional() }))
    .output(effortOptionsSchema)
    .query(async ({ ctx, input }) => {
      const model = await ctx.deps.db.model.findFirst({
        where: { id: input.modelId, organizationId: ctx.scope.organizationId },
        include: { provider: { select: { apiFormat: true } } },
      });
      if (model === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such model" });
      }
      return effortOptionsOf(ctx.deps.agentEffort, input.adapter, model, input.stored ?? "default");
    }),

  /** The four presets, each with fresh rule IDs, for the editor's one-click buttons. */
  presets: memberProcedure
    .output(z.array(z.object({ preset: approvalRulePresetSchema, name: z.string(), rules: z.array(approvalRuleSchema) })))
    .query(() => approvalRulePresetSchema.options.map((preset) => ({ preset, name: PRESET_NAMES[preset], rules: [...presetRules(preset, () => randomUUID())] }))),

  /** What each rule covers on sample requests, so the editor can say "asks for `pnpm add`, not `pnpm test`". */
  ruleCoverage: memberProcedure
    .input(coverageInput)
    .output(z.array(z.object({ ruleId: approvalRuleSchema.shape.ruleId, matched: z.array(approvalSubjectSchema), unmatched: z.array(approvalSubjectSchema) })))
    .query(({ input }) => ruleCoverage(input.rules, { mcpServers: input.mcpServers })),

  /** Creates or edits a profile. Organization admins only. */
  save: adminProcedure
    .input(saveInput)
    .output(z.object({ profileId: agentProfileIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const existing =
        input.profileId === undefined ? null : await db.agentProfile.findFirst({ where: { id: input.profileId, organizationId }, select: { mcpServers: true } });
      if (input.profileId !== undefined && existing === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such agent profile" });
      }
      // F-137: a level the model doesn't offer is refused, naming the ones it does (ADR 0066, Q289).
      if (input.effort !== undefined && input.effort !== "default") {
        const effortRow = await effortRowOf(db, organizationId, input);
        const offered = effortRow === null ? null : await loadModelEffort(db, ctx.deps.agentEffort, organizationId, effortRow, input.adapter);
        const levels = offered?.levels ?? ["default"];
        if (!levels.includes(input.effort)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: levelRefusal(input.effort, levels) });
        }
      }
      const before = existing === null ? [] : parseServers(existing.mcpServers);
      const written: SecretRef[] = [];
      const forgetWritten = async (): Promise<void> => {
        for (const ref of written) {
          await ports.adapters.secretStore.delete(organizationId, ref);
        }
      };

      // Header values go to the secret store now; a `null` keeps the reference already stored.
      const servers: ProfileMcpServer[] = [];
      for (const server of input.mcpServers) {
        if (server.transport === "stdio") {
          servers.push({ name: server.name, transport: "stdio", command: server.command, args: server.args, env: server.env, readOnly: server.readOnly });
          continue;
        }
        const old = before.find((candidate) => candidate.name === server.name && candidate.transport === "http");
        const headerSecretRefs: Record<string, string> = {};
        for (const header of server.headers) {
          if (header.value === null) {
            const kept = old?.transport === "http" ? old.headerSecretRefs[header.name] : undefined;
            if (kept === undefined) {
              await forgetWritten();
              throw new TRPCError({ code: "BAD_REQUEST", message: `${header.name} on ${server.name} has no stored value: enter it` });
            }
            headerSecretRefs[header.name] = kept;
            continue;
          }
          const stored = await ports.adapters.secretStore.put({ organizationId, purpose: "agent-profile.mcp-header" }, header.value);
          if (!stored.ok) {
            await forgetWritten();
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The secret store did not keep a header" });
          }
          written.push(stored.value);
          headerSecretRefs[header.name] = stored.value;
        }
        servers.push({ name: server.name, transport: "http", url: server.url, readOnly: server.readOnly, headerSecretRefs });
      }

      const result = await saveAgentProfile({ db, ...ports }, ctx.scope, {
        profileId: input.profileId ?? null,
        name: input.name,
        adapter: input.adapter,
        modelId: input.modelId,
        ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        instructions: input.instructions,
        approvalRules: input.approvalRules,
        planFirst: input.planFirst,
        access: input.access,
        mcpServers: servers,
        skills: input.skills,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.closingTurn === undefined ? {} : { closingTurn: input.closingTurn }),
      });
      if (!result.ok) {
        await forgetWritten();
        unwrap(result, saveCodes);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "unreachable" });
      }
      // The references the profile no longer holds are deleted from the secret store.
      const kept = new Set<string>(refsOf(servers));
      for (const ref of refsOf(before)) {
        if (!kept.has(ref)) {
          await ports.adapters.secretStore.delete(organizationId, ref);
        }
      }
      return { profileId: result.profileId };
    }),

  /**
   * F-135 (ADR 0065): the model names any of the organization's providers lists, for the profile
   * editor: each with the providers that list it, and the projects whose list serves it from none
   * ("no key" there). Organization admins, who save profiles.
   */
  modelOptions: adminProcedure
    .output(
      z.array(
        z.object({
          name: modelNameSchema,
          text: z.string(),
          displayName: z.string(),
          /** F-088: `endpointModelId` is the provider's own ID for it, which tells two models of one name apart. */
          providers: z.array(z.object({ providerId: providerIdSchema, name: z.string(), modelId: modelIdSchema, endpointModelId: z.string() })),
          projectsWithout: z.array(z.object({ projectId: projectIdSchema, name: z.string() })),
          /** Every project with the provider that serves the model there, `null` for "no key" (ticket 50, item 10). */
          projects: z.array(z.object({ projectId: projectIdSchema, name: z.string(), providerName: z.string().nullable() })),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const [rows, providers, projects] = await Promise.all([
        db.model.findMany({ where: { organizationId, listed: true }, select: { id: true, providerId: true, catalogId: true, endpointModelId: true, displayName: true }, orderBy: { id: "asc" } }),
        db.modelProvider.findMany({ where: { organizationId }, select: { id: true, name: true } }),
        db.project.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ]);
      const providerName = new Map(providers.map((provider) => [provider.id, provider.name] as const));
      const lists = await Promise.all(projects.map(async (project) => ({ project, state: await loadProviderList(db, organizationId, projectIdSchema.parse(project.id)) })));
      const byKey = new Map<string, { name: ModelName; displayName: string; providers: { providerId: ProviderId; name: string; modelId: ModelId; endpointModelId: string }[] }>();
      for (const row of rows) {
        const name = modelNameOfModel(row);
        const key = modelNameKey(name);
        const entry = byKey.get(key) ?? { name, displayName: row.displayName ?? row.endpointModelId, providers: [] };
        if (!entry.providers.some((provider) => provider.providerId === row.providerId)) {
          entry.providers.push({
            providerId: providerIdSchema.parse(row.providerId),
            name: providerName.get(row.providerId) ?? "",
            modelId: modelIdSchema.parse(row.id),
            endpointModelId: row.endpointModelId,
          });
        }
        byKey.set(key, entry);
      }
      return [...byKey.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([, entry]) => ({
          name: entry.name,
          text: modelNameText(entry.name),
          displayName: entry.displayName,
          providers: entry.providers.sort((x, y) => x.name.localeCompare(y.name)),
          projectsWithout: lists.flatMap(({ project, state }) =>
            state === null || resolveProjectModel(state.list, state.choices, state.models, entry.name).ok ? [] : [{ projectId: projectIdSchema.parse(project.id), name: project.name }],
          ),
          projects: lists.flatMap(({ project, state }) => {
            if (state === null) {
              return [];
            }
            const resolved = resolveProjectModel(state.list, state.choices, state.models, entry.name);
            return [{ projectId: projectIdSchema.parse(project.id), name: project.name, providerName: resolved.ok ? (providerName.get(resolved.providerId) ?? "") : null }];
          }),
        }));
    }),

  /**
   * F-135, F-021 (ADR 0065 amended 2026-11-20): the organization's providers, for the profile
   * editor's Provider field, by name, each with every project and whether its list allows that
   * provider. A profile on a provider runs only where it's allowed. Organization admins, who save
   * profiles. Never a token.
   */
  providerOptions: adminProcedure
    .output(
      z.array(
        z.object({
          providerId: providerIdSchema,
          name: z.string(),
          projects: z.array(z.object({ projectId: projectIdSchema, name: z.string(), allowed: z.boolean() })),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const [providers, projects] = await Promise.all([
        db.modelProvider.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        db.project.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ]);
      const lists = await Promise.all(projects.map(async (project) => ({ project, state: await loadProviderList(db, organizationId, projectIdSchema.parse(project.id)) })));
      return providers.map((provider) => ({
        providerId: providerIdSchema.parse(provider.id),
        name: provider.name,
        projects: lists.map(({ project, state }) => ({
          projectId: projectIdSchema.parse(project.id),
          name: project.name,
          allowed: state?.list.some((providerId) => providerId === provider.id) ?? false,
        })),
      }));
    }),

  /** Archives a profile; project defaults on it move to the built-in one (Q189). Organization admins only. */
  archive: adminProcedure
    .input(z.strictObject({ profileId: agentProfileIdSchema }))
    .output(z.object({ movedDefaults: z.array(projectIdSchema) }))
    .mutation(async ({ ctx, input }) => {
      const result = await archiveAgentProfile({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { profileId: input.profileId });
      const checked = unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "built-in": "BAD_REQUEST" });
      return { movedDefaults: [...checked.movedDefaults] };
    }),

  /**
   * Milestone 5 (F-069): the labels a runner must carry to take the profile's tasks, compared
   * exactly. Each matches the protocol's label schema; the built-in `executor:`, `os:` and `arch:`
   * are refused (ticket 27). Organization admins, who edit profiles. A queued task keeps the labels
   * it was queued with.
   */
  setRunnerLabels: adminProcedure
    .input(z.strictObject({ profileId: agentProfileIdSchema, labels: z.array(z.string().max(64)).max(64) }))
    .output(z.object({ runnerLabels: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const result = await setProfileLabels({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { profileId: input.profileId, labels: input.labels });
      unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST" });
      const row = await ctx.deps.db.agentProfile.findFirstOrThrow({ where: { id: input.profileId, organizationId: ctx.scope.organizationId }, select: { runnerLabels: true } });
      return { runnerLabels: [...row.runnerLabels] };
    }),

  /** The model of the built-in OpenCode profile: one of the providers' listed models (F-088). */
  setDefaultModel: adminProcedure
    .input(z.strictObject({ modelId: modelIdSchema }))
    .output(z.object({ profileId: agentProfileIdSchema, modelId: modelIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, listed: true, providerId: true, catalogId: true, endpointModelId: true } });
        if (model === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such model" });
        }
        if (!model.listed) {
          throw new TRPCError({ code: "CONFLICT", message: "The endpoint no longer lists that model" });
        }
        const profile = await tx.agentProfile.findFirst({ where: { organizationId, builtIn: true, adapter: "opencode" }, select: { id: true } });
        if (profile === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This organization has no built-in OpenCode profile" });
        }
        const profileId = agentProfileIdSchema.parse(profile.id);
        // F-135 (ADR 0065 amended 2026-11-20): a provider's listing names the model and its provider.
        const name = modelNameOfModel(model);
        await tx.agentProfile.update({
          where: { id: profile.id },
          data: { modelId: model.id, providerId: model.providerId, ...modelNameColumns(name) },
        });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "agent-profile.model-set",
          entity: "agent-profile",
          entityId: profileId,
          data: { modelId: model.id, providerId: model.providerId },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: profileId });
        return { profileId, modelId: input.modelId };
      });
    }),
});

export type { AgentProfileId };
