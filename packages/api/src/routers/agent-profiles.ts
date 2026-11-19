import { randomUUID } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef } from "@ostra/adapter-sdk";
import { apiFormatFromDb } from "@ostra/db";
import {
  agentDisplayName,
  archiveAgentProfile,
  PRESET_NAMES,
  presetRules,
  profileLimits,
  profileMcpServersSchema,
  profilesForMember,
  saveAgentProfile,
  SELECTABLE_AGENT_ADAPTERS,
  visibleProjects,
} from "@ostra/domain";
import type { MemberScope, ProfileMcpServer } from "@ostra/domain";
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
  memberIdSchema,
  modelIdSchema,
  projectIdSchema,
  providerIdSchema,
  ruleMatches,
  taskKindSchema,
} from "@ostra/protocol";
import type { AgentProfileId, ApprovalRequestSubject, ApprovalRule, ApprovalTool, OrganizationId, RuleContext } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

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
  planFirst: z.boolean(),
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
});

type ProfileRow = Awaited<ReturnType<typeof loadRows>>[number];

const profileInclude = {
  model: { include: { provider: { select: { id: true, name: true, apiFormat: true } } } },
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
      planFirst: row.planFirst,
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
  instructions: z.string().max(profileLimits.instructionsMax).nullable(),
  approvalRules: approvalRulesSchema,
  planFirst: z.boolean(),
  access: memberAccessInput,
  mcpServers: z.array(mcpServerInput).max(profileLimits.mcpServersMax),
  skills: z.array(skillInput).max(profileLimits.skillsMax),
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
      const usable = await profilesForMember(db, ctx.scope, { projectId: input.projectId });
      const rows = await db.agentProfile.findMany({
        where: { organizationId: ctx.scope.organizationId, id: { in: usable.map((profile) => profile.profileId) } },
        select: { id: true, adapter: true, approvalRules: true, model: { select: { endpointModelId: true, displayName: true } } },
      });
      const byId = new Map(rows.map((row) => [row.id, row] as const));
      const offered = usable.map((profile) => {
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
        instructions: input.instructions,
        approvalRules: input.approvalRules,
        planFirst: input.planFirst,
        access: input.access,
        mcpServers: servers,
        skills: input.skills,
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

  /** Archives a profile; project defaults on it move to the built-in one (Q189). Organization admins only. */
  archive: adminProcedure
    .input(z.strictObject({ profileId: agentProfileIdSchema }))
    .output(z.object({ movedDefaults: z.array(projectIdSchema) }))
    .mutation(async ({ ctx, input }) => {
      const result = await archiveAgentProfile({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { profileId: input.profileId });
      const checked = unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "built-in": "BAD_REQUEST" });
      return { movedDefaults: [...checked.movedDefaults] };
    }),

  /** The model of the built-in OpenCode profile: one of the providers' listed models (F-088). */
  setDefaultModel: adminProcedure
    .input(z.strictObject({ modelId: modelIdSchema }))
    .output(z.object({ profileId: agentProfileIdSchema, modelId: modelIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, listed: true, providerId: true } });
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
        await tx.agentProfile.update({ where: { id: profile.id }, data: { modelId: model.id } });
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
