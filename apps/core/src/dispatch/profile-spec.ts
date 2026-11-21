import { createHash } from "node:crypto";

import type { Db } from "@ostra/db";
import type { Logger } from "@ostra/adapter-sdk";
import { mcpProxyPathFor, profileLibraryOf, storedMcpServersSchema, storedSkillFilesSchema } from "@ostra/domain";
import { agentProfileIdSchema, approvalRulesSchema, blobIdSchema, organizationIdSchema, projectIdSchema, runnerLimits, taskIdSchema, taskRuleSchema } from "@ostra/protocol";
import type { ApprovalRule, BlobId, TaskRule, TaskSpecMcpServer, TaskSpecSkill, TurnMode } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";

// The task spec's profile parts (F-021, ADR 0049, milestone 3's ticket 16): what the dispatch adds
// to the agent section from the profile the session runs with. Instructions sit beside the repo's
// own `AGENTS.md` (the agent section's `instructions`, as milestone 1 sent them); skills are copied
// into the blob store as blobs of the task and named by their blob IDs; an HTTP MCP server becomes a
// path on the sidecar's MCP proxy, whose URL and secret headers go in the credentials only; a stdio
// server keeps its command and its variables, which hold no secret; the profile's approval rules
// and the task's own rules; plan first. The first turn runs in plan mode only for the task's first
// session, with plan first on and no plan proposed yet.
//
// Milestone 8 (F-145, ADR 0069, "Delivery: unchanged", ticket 28): the library items on the profile,
// attached or on every profile, at their current versions, after its own. A library skill's files
// are the organization's blobs, each checked against the digest its version pinned and copied into
// the task's blobs exactly as an own skill's are, so the runner's path doesn't change and nothing is
// fetched in the box; a library server is an HTTP server on the sidecar's MCP proxy, whose address
// and headers go in the credentials only (`issueTaskCredentials`), read-only when an admin marked it.
// An item the profile can't hold any more, or a server that asks for a sign-in, is left out and
// logged by its ID.

/** The purposes the copied skill blobs are stored under: words, never content. */
export const SKILL_BODY_PURPOSE = "agent-skill";
export const SKILL_FILE_PURPOSE = "agent-skill-file";

export type ProfileSpecParts = {
  readonly skills: readonly TaskSpecSkill[];
  readonly mcpServers: readonly TaskSpecMcpServer[];
  readonly approvalRules: readonly ApprovalRule[];
  readonly taskRules: readonly TaskRule[];
  readonly planFirst: boolean;
  readonly firstTurnMode: TurnMode;
};

export type ProfileSpecResult =
  | { readonly ok: true; readonly parts: ProfileSpecParts }
  /** The profile's stored rules or servers don't parse, or a skill's file can't be copied: the task doesn't run without them. */
  | { readonly ok: false; readonly message: string };

type Task = { readonly id: string; readonly organizationId: string; readonly projectId: string; readonly planState: "none" | "proposed" | "approved" };
type Profile = { readonly id: string; readonly approvalRules: unknown; readonly planFirst: boolean; readonly mcpServers: unknown };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Stores bytes as a blob of the task, once: the same bytes for the same purpose on the same task
 * are the blob already there, so a spec fetched twice copies nothing twice.
 */
const taskBlob = async (
  db: Db,
  blobs: Pick<BlobService, "put">,
  task: Task,
  input: { readonly purpose: string; readonly contentType: string; readonly bytes: Uint8Array },
): Promise<BlobId | null> => {
  const digest = sha256(input.bytes);
  const existing = await db.blob.findFirst({
    where: { organizationId: task.organizationId, taskId: task.id, purpose: input.purpose, sha256: digest },
    select: { id: true },
  });
  if (existing !== null) {
    return blobIdSchema.parse(existing.id);
  }
  const stored = await blobs.put(
    { organizationId: organizationIdSchema.parse(task.organizationId), task: { projectId: projectIdSchema.parse(task.projectId), taskId: taskIdSchema.parse(task.id) } },
    input,
  );
  return stored.ok ? stored.value.blobId : null;
};

export const profileSpecParts = async (
  deps: { readonly db: Db; readonly blobs?: Pick<BlobService, "put" | "read">; readonly logger?: Logger },
  task: Task,
  session: { readonly id: string },
  profile: Profile,
): Promise<ProfileSpecResult> => {
  const { db } = deps;
  const rules = approvalRulesSchema.safeParse(profile.approvalRules);
  if (!rules.success) {
    return { ok: false, message: "the profile's approval rules don't parse" };
  }
  const servers = storedMcpServersSchema.safeParse(profile.mcpServers);
  if (!servers.success) {
    return { ok: false, message: "the profile's MCP servers don't parse" };
  }
  const mcpServers: TaskSpecMcpServer[] = servers.data.map((server) =>
    server.transport === "http"
      ? { name: server.name, transport: "http", proxyPath: mcpProxyPathFor(server.name), readOnly: server.readOnly }
      : { name: server.name, transport: "stdio", command: server.command, args: [...server.args], env: { ...server.env }, readOnly: server.readOnly },
  );

  const skillRows = await db.agentProfileSkill.findMany({
    where: { profileId: profile.id, organizationId: task.organizationId },
    orderBy: [{ name: "asc" }],
    take: runnerLimits.skillsMax,
  });
  const skills: TaskSpecSkill[] = [];
  if (skillRows.length > 0 && deps.blobs === undefined) {
    return { ok: false, message: "the profile has skills, and this server has no blob store to hand them over" };
  }
  for (const skill of skillRows) {
    if (deps.blobs === undefined) {
      break;
    }
    const files = storedSkillFilesSchema.safeParse(skill.files);
    if (!files.success) {
      return { ok: false, message: "a skill's files don't parse" };
    }
    const body = await taskBlob(db, deps.blobs, task, { purpose: SKILL_BODY_PURPOSE, contentType: "text/markdown", bytes: new TextEncoder().encode(skill.body) });
    if (body === null) {
      return { ok: false, message: "a skill couldn't be copied into the blob store" };
    }
    const copied: { path: string; blobId: BlobId }[] = [];
    for (const file of files.data) {
      // The profile's file is its organization's: read for that organization only, then copied as the task's.
      const read = await deps.blobs.read(organizationIdSchema.parse(task.organizationId), file.blobId);
      if (!read.ok || read.value.size > runnerLimits.skillFileMaxBytes) {
        return { ok: false, message: "a skill's file couldn't be read from the blob store" };
      }
      const blobId = await taskBlob(db, deps.blobs, task, { purpose: SKILL_FILE_PURPOSE, contentType: read.value.contentType, bytes: read.value.bytes });
      if (blobId === null) {
        return { ok: false, message: "a skill's file couldn't be copied into the blob store" };
      }
      copied.push({ path: file.path, blobId });
    }
    skills.push({ name: skill.name, blobId: body, files: copied });
  }

  // Milestone 8 (F-145, ticket 28): the library's, after the profile's own.
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const library = await profileLibraryOf(db, { organizationId, profileId: agentProfileIdSchema.parse(profile.id) });
  for (const left of library.leftOut) {
    deps.logger?.warn("dispatch.library-item-left-out", { taskId: task.id, profileId: profile.id, itemId: left.itemId, reason: left.reason });
  }
  if (library.skills.length > 0 && deps.blobs === undefined) {
    return { ok: false, message: "the profile has library skills, and this server has no blob store to hand them over" };
  }
  for (const skill of library.skills) {
    if (deps.blobs === undefined) {
      break;
    }
    let body: BlobId | null = null;
    const copied: { path: string; blobId: BlobId }[] = [];
    for (const file of skill.files) {
      // The library's file is its organization's: read for that organization only, its bytes the ones its version pinned.
      const read = await deps.blobs.read(organizationId, file.blobId);
      if (!read.ok || read.value.size > runnerLimits.skillFileMaxBytes || sha256(read.value.bytes) !== file.sha256) {
        return { ok: false, message: "a library skill's file couldn't be read from the blob store as its version pinned it" };
      }
      const isBody = file.path === "SKILL.md";
      const blobId = await taskBlob(db, deps.blobs, task, {
        purpose: isBody ? SKILL_BODY_PURPOSE : SKILL_FILE_PURPOSE,
        contentType: isBody ? "text/markdown" : read.value.contentType,
        bytes: read.value.bytes,
      });
      if (blobId === null) {
        return { ok: false, message: "a library skill's file couldn't be copied into the blob store" };
      }
      if (isBody) {
        body = blobId;
      } else {
        copied.push({ path: file.path, blobId });
      }
    }
    if (body === null) {
      return { ok: false, message: "a library skill has no SKILL.md" };
    }
    skills.push({ name: skill.name, blobId: body, files: copied });
  }
  for (const server of library.servers) {
    mcpServers.push({ name: server.name, transport: "http", proxyPath: mcpProxyPathFor(server.name), readOnly: server.readOnly });
  }

  const taskRules: TaskRule[] = (
    await db.taskApprovalRule.findMany({ where: { taskId: task.id, organizationId: task.organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  ).map((row) => taskRuleSchema.parse({ ruleId: row.id, tool: row.tool, pattern: row.pattern }));

  // Plan mode on the task's first session, before any plan was proposed (ADR 0049, Q169), and on a
  // session a plan revision reopened (ticket 18: "Ask for changes" after the box idled out), whose
  // message carries `intent: "plan-revision"` while the plan still waits.
  const earlier = await db.session.count({ where: { taskId: task.id, id: { not: session.id } } });
  const revision =
    task.planState === "proposed"
      ? await db.event.findFirst({
          where: { taskId: task.id, sessionId: session.id, kind: "user.message", payload: { path: ["intent"], equals: "plan-revision" } },
          select: { seq: true },
        })
      : null;
  const firstTurnMode: TurnMode = profile.planFirst && ((task.planState === "none" && earlier === 0) || revision !== null) ? "plan" : "build";
  return {
    ok: true,
    parts: { skills, mcpServers, approvalRules: rules.data, taskRules, planFirst: profile.planFirst, firstTurnMode },
  };
};
