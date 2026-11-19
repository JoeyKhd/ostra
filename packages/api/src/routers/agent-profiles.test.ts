import { secretRefSchema } from "@ostra/adapter-sdk";
import { archiveAgentProfile, saveAgentProfile } from "@ostra/domain";
import { agentProfileIdSchema, approvalRuleIdSchema, blobIdSchema } from "@ostra/protocol";
import type { ApprovalRule, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 34: agent profiles. An admin edits them; a member uses the ones open to them; the secrets
// of an HTTP MCP server's headers go to the secret store and never come back; a project's default
// must be open to every member; a task records the profile it started with.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "calc")).projectId;
});

afterAll(async () => {
  await harness.dispose();
});

const admin = () => harness.as(harness.fixture.a.admin);
const member = () => harness.as(harness.fixture.a.member);
const insider = () => harness.as(harness.fixture.a.insider);

const noRules: ApprovalRule[] = [];
let counter = 0;
const base = (over: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    name: `Profile ${String(counter)}`,
    adapter: "opencode",
    modelId: world.modelId,
    instructions: null,
    approvalRules: noRules,
    planFirst: false,
    access: { kind: "everyone" as const },
    mcpServers: [],
    skills: [],
    ...over,
  };
};

const rule = (over: Partial<ApprovalRule> & Pick<ApprovalRule, "tool" | "match">): ApprovalRule => ({
  ruleId: approvalRuleIdSchema.parse(crypto.randomUUID()),
  name: "A rule",
  ...over,
});

const blob = async (size: number) => {
  const row = await harness.test.db.blob.create({
    data: { organizationId: harness.fixture.a.organization.id, store: "postgres", key: `skill-${crypto.randomUUID()}`, purpose: "skill-file", contentType: "text/plain", size, sha256: "0".repeat(64) },
    select: { id: true },
  });
  return blobIdSchema.parse(row.id);
};

describe("agentProfiles.save and .archive (F-021)", () => {
  it("F-021, F-063: an organization admin creates, edits and archives a profile; a member can't", async () => {
    const a = await admin();
    const created = await a.agentProfiles.save(base({ name: "Reviewer", instructions: "Be terse.", planFirst: true }));
    const got = await a.agentProfiles.get({ profileId: created.profileId });
    expect(got).toMatchObject({ name: "Reviewer", instructions: "Be terse.", planFirst: true, builtIn: false, canEdit: true, usedBy: 0, archivedAt: null, access: { kind: "everyone" } });

    await a.agentProfiles.save({ ...base({ name: "Reviewer 2", instructions: "Be kind." }), profileId: created.profileId });
    expect((await a.agentProfiles.get({ profileId: created.profileId })).name).toBe("Reviewer 2");
    expect(await harness.test.db.auditEntry.count({ where: { action: "agent-profile.created", entityId: created.profileId } })).toBe(1);
    const updated = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "agent-profile.updated", entityId: created.profileId } });
    expect(z.looseObject({ changed: z.string() }).parse(updated.data).changed).toContain("instructions");
    // The audit trail names fields, never their text.
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { entity: "agent-profile" } }))).not.toContain("Be kind");

    await expect((await member()).agentProfiles.save(base())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await member()).agentProfiles.save({ ...base(), profileId: created.profileId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await member()).agentProfiles.archive({ profileId: created.profileId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await a.agentProfiles.archive({ profileId: created.profileId });
    expect((await a.agentProfiles.list()).map((row) => row.id)).not.toContain(created.profileId);
    const withArchived = await a.agentProfiles.list({ includeArchived: true });
    expect(withArchived.find((row) => row.id === created.profileId)?.archivedAt).not.toBeNull();
    // A member never sees an archived profile, even when they ask.
    expect((await (await member()).agentProfiles.list({ includeArchived: true })).map((row) => row.id)).not.toContain(created.profileId);
    await expect((await member()).agentProfiles.get({ profileId: created.profileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An archived profile can't be edited, and a task can't start with it.
    await expect(a.agentProfiles.save({ ...base(), profileId: created.profileId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(a.tasks.create({ projectId, prompt: "x", agentProfileId: created.profileId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("F-021: the use cases refuse a member on their own, whatever the router in front of them does", async () => {
    const context = await harness.contextOf(harness.fixture.a.member);
    const scope = context.member?.scope;
    if (scope === undefined) throw new Error("no scope");
    const deps = { db: harness.test.db, ...harness.deps.ports };
    const input = { profileId: null, name: "Sneaky", adapter: "opencode", modelId: null, instructions: null, approvalRules: [], planFirst: false, access: { kind: "everyone" as const }, mcpServers: [], skills: [] };
    expect(await saveAgentProfile(deps, scope, input)).toMatchObject({ ok: false, error: "forbidden" });
    const existing = await (await admin()).agentProfiles.save(base({ name: "Not yours to archive" }));
    expect(await archiveAgentProfile(deps, scope, { profileId: existing.profileId })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await harness.test.db.agentProfile.count({ where: { name: "Sneaky" } })).toBe(0);
    expect((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: existing.profileId } })).archivedAt).toBeNull();
  });

  it("F-021: a name is unique in the organization, and a missing model, adapter or member is refused", async () => {
    const a = await admin();
    const first = await a.agentProfiles.save(base({ name: "Unique" }));
    await expect(a.agentProfiles.save(base({ name: "Unique" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(a.agentProfiles.save({ ...base({ name: "Unique" }), profileId: first.profileId })).resolves.toBeDefined();
    await expect(a.agentProfiles.save(base({ modelId: "no-such-model" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save(base({ adapter: "no-such-agent" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save(base({ access: { kind: "listed", members: ["not-a-member"] } }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A member of another organization can't be listed.
    await expect(a.agentProfiles.save(base({ access: { kind: "listed", members: [harness.fixture.b.admin.id] } }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save(base({ name: "   " }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("F-026: a rule whose match doesn't fit its tool is refused, and rules are stored as the protocol parses them", async () => {
    const a = await admin();
    await expect(
      a.agentProfiles.save(base({ approvalRules: [{ ruleId: crypto.randomUUID(), name: "Bad", tool: "edit", match: { kind: "command-prefix", prefixes: ["pnpm add"] } }] })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const good = rule({ name: "Dependencies", tool: "execute", match: { kind: "command-prefix", prefixes: ["pnpm add"] }, preset: "dependency" });
    const saved = await a.agentProfiles.save(base({ approvalRules: [good] }));
    const got = await a.agentProfiles.get({ profileId: saved.profileId });
    expect(got.rules).toEqual([{ ruleId: good.ruleId, name: "Dependencies", tool: "execute", preset: "dependency", match: good.match }]);
  });

  it("F-021: skills and MCP servers are validated, and a skill's files must be uploaded blobs of at most 1 MiB", async () => {
    const a = await admin();
    const small = await blob(10);
    const big = await blob(2 * 1024 * 1024);
    const ok = await a.agentProfiles.save(base({ skills: [{ name: "changelog", body: "# Changelog\nHow a line reads.", files: [{ path: "examples/one.md", blobId: small }] }] }));
    expect((await a.agentProfiles.get({ profileId: ok.profileId })).skills).toEqual([
      { name: "changelog", body: "# Changelog\nHow a line reads.", files: [{ path: "examples/one.md", blobId: small, size: 10 }] },
    ]);
    const refused = async (skills: unknown) => expect(a.agentProfiles.save(base({ skills }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await refused([{ name: "Bad Name", body: "x", files: [] }]);
    await refused([{ name: "dup", body: "x", files: [] }, { name: "dup", body: "y", files: [] }]);
    await refused([{ name: "outside", body: "x", files: [{ path: "../escape", blobId: small }] }]);
    await refused([{ name: "absolute", body: "x", files: [{ path: "/etc/passwd", blobId: small }] }]);
    await refused([{ name: "twice", body: "x", files: [{ path: "a", blobId: small }, { path: "a", blobId: small }] }]);
    await refused([{ name: "over", body: "x", files: [{ path: "big.bin", blobId: big }] }]);
    await refused([{ name: "ghost", body: "x", files: [{ path: "a", blobId: "no-such-blob" }] }]);
    await refused([{ name: "toomany", body: "x", files: Array.from({ length: 21 }, (_, i) => ({ path: `f${String(i)}`, blobId: small })) }]);
    // Another organization's blob is not an uploaded blob of this one.
    const foreign = await harness.test.db.blob.create({
      data: { organizationId: harness.fixture.b.organization.id, store: "postgres", key: `skill-${crypto.randomUUID()}`, purpose: "skill-file", contentType: "text/plain", size: 1, sha256: "0".repeat(64) },
      select: { id: true },
    });
    await refused([{ name: "foreign", body: "x", files: [{ path: "a", blobId: foreign.id }] }]);
    await expect(a.agentProfiles.save(base({ mcpServers: [{ transport: "http", name: "Bad Name", url: "https://mcp.example.com", headers: [] }] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save(base({ mcpServers: [{ transport: "http", name: "x", url: "ftp://nope", headers: [] }] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save(base({ mcpServers: [{ transport: "stdio", name: "x", command: "  ", args: [], env: {} }] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("F-021: an MCP header's value goes to the secret store and never comes back; only its name and that it is set do", async () => {
    const a = await admin();
    const secretValue = "Bearer sk-mcp-header-value-0123456789";
    const saved = await a.agentProfiles.save(
      base({ mcpServers: [{ transport: "http", name: "search", url: "https://mcp.example.com/mcp", readOnly: true, headers: [{ name: "Authorization", value: secretValue }] }] }),
    );
    const got = await a.agentProfiles.get({ profileId: saved.profileId });
    expect(got.mcpServers).toEqual([{ name: "search", transport: "http", url: "https://mcp.example.com/mcp", readOnly: true, headers: [{ name: "Authorization", set: true }] }]);

    // The row holds a reference, and the value is in the secret store only.
    const row = await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: saved.profileId } });
    const stored = JSON.stringify(row.mcpServers);
    expect(stored).not.toContain("sk-mcp-header-value");
    const ref = storedServers.parse(row.mcpServers)[0]?.headerSecretRefs["Authorization"];
    expect(ref).toMatch(/^[a-z][a-z0-9-]*:/);
    const fetched = await harness.fakes.secretStore.get(harness.fixture.a.organization.id, secretRefOf(ref));
    expect(fetched).toMatchObject({ ok: true, value: secretValue });

    // Nothing the API returns, audits or logs holds the value.
    const everything = JSON.stringify([got, await a.agentProfiles.list(), await harness.test.db.auditEntry.findMany(), harness.logs]);
    expect(everything).not.toContain("sk-mcp-header-value");
    expect(everything).not.toContain(ref ?? "never");

    // Saving with `null` keeps the stored value; a new value replaces it and deletes the old one.
    await a.agentProfiles.save({
      ...base({ name: got.name, mcpServers: [{ transport: "http", name: "search", url: "https://mcp.example.com/v2", readOnly: true, headers: [{ name: "Authorization", value: null }] }] }),
      profileId: saved.profileId,
    });
    const kept = storedServers.parse((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: saved.profileId } })).mcpServers);
    expect(kept[0]?.headerSecretRefs["Authorization"]).toBe(ref);
    await a.agentProfiles.save({
      ...base({ name: got.name, mcpServers: [{ transport: "http", name: "search", url: "https://mcp.example.com/v2", headers: [{ name: "Authorization", value: "Bearer rotated-0123456789" }] }] }),
      profileId: saved.profileId,
    });
    const rotated = storedServers.parse((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: saved.profileId } })).mcpServers);
    const newRef = rotated[0]?.headerSecretRefs["Authorization"];
    expect(newRef).not.toBe(ref);
    expect(await harness.fakes.secretStore.get(harness.fixture.a.organization.id, secretRefOf(ref))).toMatchObject({ ok: false });
    expect(await harness.fakes.secretStore.get(harness.fixture.a.organization.id, secretRefOf(newRef))).toMatchObject({ ok: true, value: "Bearer rotated-0123456789" });

    // A header with no stored value and none given is refused, and writes nothing.
    await expect(
      a.agentProfiles.save({ ...base({ name: got.name, mcpServers: [{ transport: "http", name: "other", url: "https://x.example.com", headers: [{ name: "X-Key", value: null }] }] }), profileId: saved.profileId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Dropping the server deletes its secret.
    await a.agentProfiles.save({ ...base({ name: got.name }), profileId: saved.profileId });
    expect(await harness.fakes.secretStore.get(harness.fixture.a.organization.id, secretRefOf(newRef))).toMatchObject({ ok: false });
  });
});

describe("an MCP header's value (F-021)", () => {
  const withHeader = (value: string) =>
    base({ mcpServers: [{ transport: "http", name: "search", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value }] }] });

  it("F-021: a header value holding a line break or another control character is refused on save, and a trailing newline is trimmed before it is stored", async () => {
    const a = await admin();
    const profilesBefore = await harness.test.db.agentProfile.count();
    for (const bad of [`Bearer abc\nx-injected: 1`, `Bearer abc\rx`, `Bearer ab\u0000c`, `Bearer ab\u007fc`]) {
      await expect(a.agentProfiles.save(withHeader(bad))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await harness.test.db.agentProfile.count()).toBe(profilesBefore);
    const saved = await a.agentProfiles.save(withHeader(`  Bearer pasted-token-0123\n`));
    const row = await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: saved.profileId } });
    const ref = storedServers.parse(row.mcpServers)[0]?.headerSecretRefs["Authorization"];
    expect(await harness.fakes.secretStore.get(harness.fixture.a.organization.id, secretRefOf(ref))).toMatchObject({ ok: true, value: "Bearer pasted-token-0123" });
  });
});

describe("who may use a profile (F-021)", () => {
  it("F-021: a listed profile is invisible to an unlisted member and refused to start a task, and works for a listed one", async () => {
    const a = await admin();
    const secret = await a.agentProfiles.save(base({ name: "Secret team", access: { kind: "listed", members: [harness.fixture.a.insider.id] } }));
    const got = await a.agentProfiles.get({ profileId: secret.profileId });
    expect(got.access).toMatchObject({ kind: "listed", members: [{ memberId: harness.fixture.a.insider.id }] });

    // The unlisted member neither lists nor gets it.
    expect((await (await member()).agentProfiles.list()).map((row) => row.id)).not.toContain(secret.profileId);
    await expect((await member()).agentProfiles.get({ profileId: secret.profileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await (await member()).agentProfiles.forStart({ projectId, kind: "code" })).map((row) => row.profileId)).not.toContain(secret.profileId);
    // ...and a task can't start with it: FORBIDDEN, naming the profile.
    const refusal = await (await member()).tasks.create({ projectId, prompt: "x", agentProfileId: secret.profileId }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: "FORBIDDEN" });
    expect(refusal instanceof Error ? refusal.message : "").toContain("Secret team");
    expect(await harness.test.db.task.count({ where: { agentProfileId: secret.profileId } })).toBe(0);

    // The listed member sees it and starts a task with it, which records it.
    expect((await (await insider()).agentProfiles.list()).map((row) => row.id)).toContain(secret.profileId);
    const started = await (await insider()).tasks.create({ projectId, prompt: "Do the thing", agentProfileId: secret.profileId });
    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId }, include: { sessions: true } });
    expect(task.agentProfileId).toBe(secret.profileId);
    expect(task.sessions[0]?.agentProfileId).toBe(secret.profileId);
    expect((await a.agentProfiles.get({ profileId: secret.profileId })).usedBy).toBe(1);
    // An organization admin uses any profile.
    await expect(a.tasks.create({ projectId, prompt: "Admin too", agentProfileId: secret.profileId })).resolves.toBeDefined();
  });

  it("F-021: the built-in profile is always open to everyone, and can't be archived or listed", async () => {
    const a = await admin();
    const builtIn = (await a.agentProfiles.list()).find((row) => row.builtIn);
    expect(builtIn).toBeDefined();
    const id = builtIn?.id;
    if (id === undefined) throw new Error("no built-in profile");
    await expect(a.agentProfiles.archive({ profileId: id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.agentProfiles.save({ ...base({ name: builtIn?.name, access: { kind: "listed", members: [harness.fixture.a.insider.id] } }), profileId: id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Editable: instructions and plan first save, and its model stays pickable.
    await a.agentProfiles.save({ ...base({ name: builtIn?.name, instructions: "House style." }), profileId: id });
    expect((await a.agentProfiles.get({ profileId: id })).instructions).toBe("House style.");
    expect((await (await member()).agentProfiles.get({ profileId: id })).canEdit).toBe(false);
  });

  it("F-021: another organization's profiles are invisible, and can't be edited, archived or started with", async () => {
    const b = await harness.as(harness.fixture.b.admin);
    await harness.test.db.agentProfile.create({ data: { organizationId: harness.fixture.b.organization.id, name: "Org B only", adapter: "opencode" }, select: { id: true } });
    const theirs = await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId: harness.fixture.b.organization.id, name: "Org B only" } });
    expect((await (await admin()).agentProfiles.list({ includeArchived: true })).map((row) => row.name)).not.toContain("Org B only");
    expect((await b.agentProfiles.list()).map((row) => row.name)).toEqual(["Org B only"]);
    await expect((await admin()).agentProfiles.get({ profileId: agentProfileIdSchema.parse(theirs.id) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await admin()).agentProfiles.save({ ...base(), profileId: agentProfileIdSchema.parse(theirs.id) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await admin()).agentProfiles.archive({ profileId: agentProfileIdSchema.parse(theirs.id) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await admin()).tasks.create({ projectId, prompt: "x", agentProfileId: agentProfileIdSchema.parse(theirs.id) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: theirs.id } })).archivedAt).toBeNull();
  });
});

describe("a project's default profile (F-021)", () => {
  it("F-021: a default must be open to the project's members, and only a project admin sets it", async () => {
    const a = await admin();
    const open = await a.agentProfiles.save(base({ name: "Open default" }));
    const listed = await a.agentProfiles.save(base({ name: "Listed", access: { kind: "listed", members: [harness.fixture.a.insider.id] } }));
    await expect(a.projects.setDefaultProfile({ projectId, kind: "code", profileId: listed.profileId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await member()).projects.setDefaultProfile({ projectId, kind: "code", profileId: open.profileId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await a.projects.setDefaultProfile({ projectId, kind: "code", profileId: open.profileId });
    await a.projects.setDefaultProfile({ projectId, kind: "review", profileId: open.profileId });
    const project = await a.projects.get({ projectId });
    expect(project.defaultCodeProfile).toMatchObject({ id: open.profileId, name: "Open default" });
    expect(project.defaultProfiles).toMatchObject({ refine: { name: "OpenCode" }, review: { id: open.profileId } });

    // The list says where it defaults, only to projects the viewer can open.
    const row = (await a.agentProfiles.list()).find((profile) => profile.id === open.profileId);
    expect(row?.defaults).toEqual(expect.arrayContaining([{ projectId, projectName: "calc", kind: "code" }, { projectId, projectName: "calc", kind: "review" }]));
    // A profile that a project defaults to can't be narrowed to a list.
    await expect(a.agentProfiles.save({ ...base({ name: "Open default", access: { kind: "listed", members: [harness.fixture.a.insider.id] } }), profileId: open.profileId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // A task started with no profile takes the default and records it.
    const started = await (await member()).tasks.create({ projectId, prompt: "Default please" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId } })).agentProfileId).toBe(open.profileId);
    // forStart puts the default first.
    const offered = await (await member()).agentProfiles.forStart({ projectId, kind: "code" });
    expect(offered[0]).toMatchObject({ profileId: open.profileId, isDefault: true });
    expect(offered.filter((profile) => profile.isDefault)).toHaveLength(1);
    // Another organization's project can't be touched.
    await expect((await harness.as(harness.fixture.b.admin)).projects.setDefaultProfile({ projectId, kind: "code", profileId: open.profileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-021, Q189: archiving a profile moves the defaults on it to the built-in profile, and tasks keep the profile they started with", async () => {
    const a = await admin();
    const mine = await a.agentProfiles.save(base({ name: "Soon archived" }));
    await a.projects.setDefaultProfile({ projectId, kind: "refine", profileId: mine.profileId });
    await a.projects.setDefaultProfile({ projectId, kind: "code", profileId: mine.profileId });
    const started = await (await member()).tasks.create({ projectId, prompt: "Started before the archive" });
    const builtIn = (await a.agentProfiles.list()).find((row) => row.builtIn);

    const archived = await a.agentProfiles.archive({ profileId: mine.profileId });
    expect(archived.movedDefaults).toEqual([projectId]);
    const project = await a.projects.get({ projectId });
    expect(project.defaultProfiles.refine?.id).toBe(builtIn?.id);
    expect(project.defaultCodeProfile?.id).toBe(builtIn?.id);
    // The task keeps the archived profile it started with.
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId } })).agentProfileId).toBe(mine.profileId);
    expect((await a.agentProfiles.get({ profileId: mine.profileId })).archivedBy).not.toBeNull();
    // The audit entry names the projects, and an archived profile can't become a default.
    expect((await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "agent-profile.archived", entityId: mine.profileId } })).data).toMatchObject({ movedDefaults: projectId });
    await expect(a.projects.setDefaultProfile({ projectId, kind: "code", profileId: mine.profileId })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("the editor's helpers (F-026)", () => {
  it("F-026: ruleCoverage says what a rule covers: asks for `pnpm add`, not for `pnpm test`", async () => {
    const m = await member();
    const dependency = rule({ name: "Dependencies", tool: "execute", match: { kind: "command-prefix", prefixes: ["pnpm add", "npm install"] } });
    const paths = rule({ name: "Manifests", tool: "edit", match: { kind: "path-glob", glob: "**/package.json" } });
    const mcp = rule({ name: "Writers", tool: "mcp", match: { kind: "mcp-not-read-only" } });
    const coverage = await m.agentProfiles.ruleCoverage({
      rules: [dependency, paths, mcp],
      mcpServers: [{ name: "docs", readOnly: true }, { name: "tickets", readOnly: false }],
    });
    const byRule = new Map(coverage.map((entry) => [entry.ruleId, entry]));
    expect(byRule.get(dependency.ruleId)?.matched.map((s) => s.value)).toEqual(expect.arrayContaining(["pnpm add zod", "npm install left-pad"]));
    expect(byRule.get(dependency.ruleId)?.unmatched.map((s) => s.value)).toEqual(expect.arrayContaining(["pnpm test", "git status"]));
    expect(byRule.get(dependency.ruleId)?.matched.map((s) => s.value)).not.toContain("pnpm test");
    expect(byRule.get(paths.ruleId)?.matched.map((s) => s.value)).toEqual(["package.json"]);
    expect(byRule.get(paths.ruleId)?.unmatched.map((s) => s.value)).toContain("src/index.ts");
    expect(byRule.get(mcp.ruleId)?.matched.map((s) => s.value)).toEqual(["tickets/call"]);
    expect(byRule.get(mcp.ruleId)?.unmatched.map((s) => s.value)).toEqual(["docs/call"]);
  });

  it("F-026: a path rule's coverage names a near miss first: asks for `config/settings.json`, not for `src/config.ts`", async () => {
    const config = rule({ name: "Config files", tool: "edit", match: { kind: "path-glob", glob: "config/**" } });
    const [coverage] = await (await member()).agentProfiles.ruleCoverage({ rules: [config] });
    expect(coverage?.matched.map((s) => s.value)).toEqual(["config/settings.json"]);
    expect(coverage?.unmatched[0]?.value).toBe("src/config.ts");
  });

  it("F-021: the start picker's options carry each profile's rule count, as the editor shows the rules", async () => {
    const a = await admin();
    // A rule's globs are stored one per rule; the editor shows them as one rule, and so does the count.
    const globs = ["**/migrations/**", "**/*.sql"].map((glob) => rule({ name: "One", tool: "edit", match: { kind: "path-glob", glob } }));
    const careful = await a.agentProfiles.save(base({ name: "Counted", approvalRules: [...globs, rule({ name: "Two", tool: "fetch", match: { kind: "any" } })] }));
    const offered = await a.agentProfiles.forStart({ projectId, kind: "code" });
    expect(offered.find((profile) => profile.profileId === careful.profileId)).toMatchObject({ ruleCount: 2 });
    expect(offered.find((profile) => profile.builtIn)).toMatchObject({ ruleCount: 0 });
  });

  it("F-026: the four presets come with valid rules, each marked with its preset", async () => {
    const presets = await (await member()).agentProfiles.presets();
    expect(presets.map((p) => p.preset)).toEqual(["dependency", "migration", "allowlist", "network"]);
    for (const preset of presets) {
      expect(preset.rules.length).toBeGreaterThan(0);
      expect(preset.rules.every((r) => r.preset === preset.preset)).toBe(true);
    }
    // A preset saves as it is.
    const dependency = presets.find((p) => p.preset === "dependency");
    const saved = await (await admin()).agentProfiles.save(base({ approvalRules: dependency?.rules ?? [] }));
    expect((await (await admin()).agentProfiles.get({ profileId: saved.profileId })).rules).toHaveLength(dependency?.rules.length ?? -1);
  });

  it("F-021: the agents on offer are the installed ones", async () => {
    expect(await (await member()).agentProfiles.agents()).toEqual([{ adapter: "opencode", name: "OpenCode" }]);
  });
});

const secretRefOf = (value: string | undefined) => secretRefSchema.parse(value ?? "none:none");

const storedServers = z.array(z.object({ headerSecretRefs: z.record(z.string(), z.string()) }));
