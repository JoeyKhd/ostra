import { createHash, randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import { computedHash, skillDiff } from "@ostra/domain";

// Milestone 8 (F-145, ticket 31): a library in its fullest state, written straight into the e2e
// database, for the every-route checks (`seed-routes-world.ts`, the a11y walk) and the library's
// screenshots. Skills with their files as the organization's blobs (the built-in store's rows),
// one with an update waiting and its diff, one on every profile, MCP servers with their remote and
// inputs, a member's open suggestion, and the sources they come from. Names are fixed, so a second
// seed on the same stack reuses what the first wrote. Demo data: nothing here is fetched.

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);

type Skill = { readonly name: string; readonly owner: string; readonly repo: string; readonly path: string; readonly description: string; readonly files: Readonly<Record<string, string>> };

const skillMd = (name: string, description: string, body: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const WEBAPP_BEFORE: Readonly<Record<string, string>> = {
  "SKILL.md": skillMd("webapp-testing", "Test local web apps with Playwright.", "## Starting the app\n\nRun the dev server yourself, then open it.\n\n## Screenshots\n\nWait for the network to be idle before each one."),
  "scripts/with_server.py": "#!/usr/bin/env python3\nimport subprocess\nprint('start the server')\n",
  "examples/console.py": "print('console')\n",
};
const WEBAPP_AFTER: Readonly<Record<string, string>> = {
  "SKILL.md": skillMd(
    "webapp-testing",
    "Start a local web app with Playwright, wait for its port, then click and screenshot.",
    "## Starting the app\n\nUse scripts/with_server.py: it starts each server and waits until its port answers before the test begins.\n\n## Screenshots\n\nTake one per viewport you check: 1280, 768 and 390 wide.\nName each after the route and the width.\nWait for the network to be idle before each one.",
  ),
  "scripts/with_server.py": "#!/usr/bin/env python3\nimport socket\nimport subprocess\nprint('start each server, then wait for its port')\n",
  "examples/console.py": "print('console')\nprint('errors')\n",
};

const SKILLS: readonly Skill[] = [
  { name: "webapp-testing", owner: "anthropics", repo: "skills", path: "skills/webapp-testing", description: "Test local web apps with Playwright.", files: WEBAPP_BEFORE },
  { name: "frontend-design", owner: "anthropics", repo: "skills", path: "skills/frontend-design", description: "Production-grade frontend work.", files: { "SKILL.md": skillMd("frontend-design", "Production-grade frontend work.", "Use the design system's tokens.") } },
  { name: "prisma-migrations", owner: "acme", repo: "agent-skills", path: "skills/prisma-migrations", description: "Plan, write and check a Prisma migration.", files: { "SKILL.md": skillMd("prisma-migrations", "Plan, write and check a Prisma migration.", "Add first; drop in a later release.") } },
];

/** Writes each file as one of the organization's blobs in the built-in store: its row and one chunk. */
const putFiles = async (db: Db, organizationId: string, files: Readonly<Record<string, string>>) => {
  const out: { path: string; blobId: string; size: number; sha256: string; executable: boolean }[] = [];
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = text(content);
    const id = randomUUID();
    await db.blob.create({ data: { id, organizationId, store: "postgres", key: `postgres:${id}`, purpose: "library-file", contentType: "text/plain", size: bytes.length, sha256: sha256(bytes) } });
    await db.blobChunk.create({ data: { organizationId, blobId: id, ordinal: 0, offset: 0, bytes } });
    out.push({ path, blobId: id, size: bytes.length, sha256: sha256(bytes), executable: content.startsWith("#!") });
  }
  return out;
};

const skillFilesOf = (files: Readonly<Record<string, string>>) => Object.entries(files).map(([path, content]) => ({ path, bytes: text(content) }));

/** A fake 40-character commit for a skill's pin. */
const commitOf = (seed: string): string => createHash("sha1").update(seed).digest("hex");

export type LibraryWorld = { readonly itemId: string; readonly serverItemId: string; readonly suggestionId: string | null };

export const seedLibrary = async (
  db: Db,
  input: { readonly organizationId: string; readonly adminMemberId: string; readonly memberId: string; readonly profileId: string },
): Promise<LibraryWorld> => {
  const { organizationId, adminMemberId } = input;
  const sources = [
    { kind: "github_owner" as const, value: "anthropics", namespace: null },
    { kind: "github_repo" as const, value: "acme/agent-skills", namespace: null },
    { kind: "registry" as const, value: "https://api.mcp.github.com", namespace: null },
  ];
  for (const source of sources) {
    const found = await db.librarySource.findFirst({ where: { organizationId, kind: source.kind, value: source.value } });
    if (found === null) await db.librarySource.create({ data: { organizationId, ...source, addedByMemberId: adminMemberId } });
  }

  let webappId: string | null = null;
  for (const skill of SKILLS) {
    const existing = await db.libraryItem.findFirst({ where: { organizationId, kind: "skill", name: skill.name, removedAt: null } });
    if (existing !== null) {
      if (skill.name === "webapp-testing") webappId = existing.id;
      continue;
    }
    const itemId = randomUUID();
    const files = await putFiles(db, organizationId, skill.files);
    await db.libraryItem.create({
      data: {
        id: itemId,
        organizationId,
        kind: "skill",
        name: skill.name,
        sourceKind: "github",
        source: { kind: "github", owner: skill.owner, repo: skill.repo, path: skill.path, ref: null },
        everyProfile: skill.name === "frontend-design",
        installedByMemberId: adminMemberId,
      },
    });
    const versionId = randomUUID();
    await db.libraryItemVersion.create({
      data: { id: versionId, organizationId, itemId, number: 1, state: "current", ref: null, commitSha: commitOf(`${skill.name}-1`), computedHash: computedHash(skillFilesOf(skill.files)), files },
    });
    await db.libraryItem.update({ where: { id: itemId }, data: { currentVersionId: versionId } });
    if (skill.name !== "frontend-design") {
      await db.agentProfileLibraryItem.create({ data: { organizationId, profileId: input.profileId, itemId, attachedByMemberId: adminMemberId } });
    }
    if (skill.name === "webapp-testing") {
      webappId = itemId;
      // An update waiting: main moved on, three files changed, with the diff core's check writes.
      const after = await putFiles(db, organizationId, WEBAPP_AFTER);
      await db.libraryItemVersion.create({
        data: {
          organizationId,
          itemId,
          number: 2,
          state: "available",
          ref: null,
          commitSha: commitOf(`${skill.name}-2`),
          computedHash: computedHash(skillFilesOf(WEBAPP_AFTER)),
          files: after,
          diff: { kind: "skill", diff: skillDiff(skillFilesOf(WEBAPP_BEFORE), skillFilesOf(WEBAPP_AFTER)) },
          fetchedAt: new Date(Date.now() - 2 * 86_400_000),
        },
      });
    }
  }

  let serverId: string | null = null;
  const servers = [
    { name: "sentry", registryName: "io.sentry/sentry-mcp", version: "0.21.0", description: "Issues and traces", url: "https://mcp.sentry.dev/mcp", tools: ["find_issues", "get_issue", "search_events"] },
    { name: "linear", registryName: "app.linear/linear", version: "1.4.2", description: "Issues, comments and projects", url: "https://mcp.linear.app/mcp", tools: ["list_issues", "create_issue"] },
  ];
  for (const server of servers) {
    const existing = await db.libraryItem.findFirst({ where: { organizationId, kind: "mcp_server", name: server.name, removedAt: null } });
    if (existing !== null) {
      serverId ??= existing.id;
      continue;
    }
    const itemId = randomUUID();
    serverId ??= itemId;
    await db.libraryItem.create({
      data: { id: itemId, organizationId, kind: "mcp_server", name: server.name, sourceKind: "registry", source: { kind: "registry", registryUrl: "https://api.mcp.github.com", name: server.registryName }, installedByMemberId: adminMemberId },
    });
    const versionId = randomUUID();
    await db.libraryItemVersion.create({
      data: {
        id: versionId,
        organizationId,
        itemId,
        number: 1,
        state: "current",
        registryVersion: server.version,
        serverEntry: { transport: "streamable-http", remoteUrl: server.url, description: server.description, variables: [], headers: [{ name: "X-Team", isSecret: false, isRequired: false, description: null }], fixedHeaders: {} },
        serverInputs: { variables: {}, headers: { "X-Team": { kind: "plain", value: "platform" } } },
        toolNames: server.tools,
      },
    });
    await db.libraryItem.update({ where: { id: itemId }, data: { currentVersionId: versionId } });
    await db.agentProfileLibraryItem.create({ data: { organizationId, profileId: input.profileId, itemId, attachedByMemberId: adminMemberId } });
  }

  const open = await db.librarySuggestion.findFirst({ where: { organizationId, memberId: input.memberId, state: "open" } });
  const suggestion =
    open ??
    (await db.librarySuggestion.create({
      data: { organizationId, memberId: input.memberId, reference: "anthropics/skills@pdf", note: "We fill in vendor forms every week, and this reads and fills PDF forms." },
    }));

  if (webappId === null || serverId === null) throw new Error("the library seed wrote no items");
  return { itemId: webappId, serverItemId: serverId, suggestionId: suggestion.id };
};

/** Every word the library seed writes as an organization's own data (names, sources, files, the note): the pseudo-locale pass leaves them out. */
export const libraryWords = (): readonly string[] => [
  ...SKILLS.flatMap((skill) => [skill.name, skill.owner, skill.repo, skill.path, `${skill.owner}/${skill.repo}`, skill.description, ...Object.keys(skill.files), ...Object.values(skill.files).flatMap((file) => file.split("\n"))]),
  ...Object.keys(WEBAPP_AFTER),
  ...Object.values(WEBAPP_AFTER).flatMap((file) => file.split("\n")),
  "sentry", "io.sentry/sentry-mcp", "Issues and traces", "linear", "app.linear/linear", "Issues, comments and projects", "X-Team", "platform",
  "find_issues", "get_issue", "search_events", "list_issues", "create_issue", "https://mcp.sentry.dev/mcp", "https://mcp.linear.app/mcp",
  "anthropics/skills@pdf", "We fill in vendor forms every week, and this reads and fills PDF forms.",
].filter((word) => word.trim() !== "");
