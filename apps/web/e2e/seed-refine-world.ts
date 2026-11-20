// What the refine draft's spec needs (F-099, milestone 6's ticket 34): the stack's fake Linear
// connected with its admin's API key (stored in the server's own secret store), a "calculator"
// project with the fake's team `OST` as its board, whose mapping names `Todo` as its ready status,
// a ticket made on the fake Linear and cached, and a refine task on it in "Needs you · draft ready"
// with the two versions its agent handed in: the drafting fake's `sampleDraft` (adapter-sdk), then
// a second one, stored as core's `submit_draft` endpoint stores them (the domain's `saveDraft`).
// The throwaway e2e database only. Run as `node e2e/seed-refine-world.ts '<json>'`; prints one JSON line.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { sampleDraft } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { ensureBuiltInKindProfilesInTx, postgresChangeNotices, saveDraft, systemClock } from "@ostra/domain";
import { organizationIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RefineDraft } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .strictObject({
    databaseUrl: z.string(),
    dataDir: z.string(),
    linear: z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() }),
    /** `prompt`: a refine task started from a prompt, with no ticket ("Create ticket"). */
    source: z.enum(["ticket", "prompt"]).default("ticket"),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const PROJECT = "calculator";

/** The agent's second version: the target's (`app-targets/m6/refine-draft.md`). */
const secondDraft: RefineDraft = {
  description: "Show the app's version in the footer and in the About dialog, read from package.json at build time.\nAdd a /version endpoint so support can check a deploy.",
  acceptanceCriteria: ["The footer shows v1.8.2 on every page", "GET /version returns the version", "The About dialog shows the same version as the footer"],
  edgeCases: ["A build without a git SHA shows the version alone"],
  openQuestions: ["Semver only, or the SHA as well in the UI?"],
  subTickets: [
    { title: "Show the version in the footer", description: "Read it from package.json at build time.\nShow it in the footer's right corner.\nLink it to the changelog." },
    { title: "Add a /version endpoint", description: "Answer the version and the git SHA as JSON.\nNo authentication.\nCache it for a minute." },
  ],
};

/** The `Secret` table as the built-in store's rows (as the panel's `deps.ts` keeps them). */
const secretRows: SecretRowStore = {
  insert: async (row) => {
    await db.secret.create({
      data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    return row === null ? undefined : { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => (await db.secret.deleteMany({ where: { id } })).count > 0,
};

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = organizationIdSchema.parse(admin.organizationId);
const linear = new LinearAdapter({ apiUrl: args.linear.apiUrl, auth: { kind: "api-key", token: args.linear.apiKey } });
const board = { externalId: args.linear.teamId };

// The connection: the organization's Linear, on the fake, with the admin's API key.
const connection =
  (await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } })) ??
  (await (async () => {
    const key = parseSecretsKey((await readFile(path.join(args.dataDir, "secrets-key"), "utf8")).trim());
    if (!key.ok) throw new Error("the stack's secrets key didn't parse");
    const store = new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: adapterClock });
    const token = await store.put({ organizationId, purpose: "linear-access-token" }, args.linear.apiKey);
    if (!token.ok) throw new Error("the secret store refused the token");
    return db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: "e2e-linear",
        state: "active",
        credentialKind: "api_key",
        accessTokenSecretRef: token.value,
        externalWorkspaceId: "e2e-workspace",
        externalWorkspaceKey: "ostra-test",
        externalWorkspaceName: "ostra-test",
        activatedAt: new Date(),
      },
    });
  })());

const statuses = await linear.listStatuses(board);
if (!statuses.ok) throw new Error(`the fake Linear listed no statuses: ${statuses.error.message}`);
const status = (name: string): string => {
  const found = statuses.value.find((one) => one.name === name);
  if (found === undefined) throw new Error(`the fake Linear has no ${name} status`);
  return found.id;
};

// The project and its board, found again on a re-run.
const project =
  (await db.project.findFirst({ where: { organizationId, slug: PROJECT } })) ?? (await db.project.create({ data: { organizationId, name: PROJECT, slug: PROJECT, access: "open" } }));
const boardRow =
  (await db.board.findFirst({ where: { organizationId, projectId: project.id, externalId: args.linear.teamId } })) ??
  (await db.board.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: connection.id,
      externalId: args.linear.teamId,
      name: "Calculator",
      key: args.linear.teamKey,
      statusMap: { open: [status("Backlog"), status("Todo")], started: status("In Progress"), inReview: status("In Review"), done: status("Done"), ready: status("Todo"), doneBy: "ostra", magicWord: "Closes" },
    },
  }));
const profiles = await db.$transaction((tx) => ensureBuiltInKindProfilesInTx(tx, organizationId));

const title = "Users want to see the version somewhere";
const ticket =
  args.source === "prompt"
    ? null
    : await (async () => {
        const made = await linear.createTicket(board, { title, description: "Somewhere in the app." });
        if (!made.ok) throw new Error(`the fake Linear made no ticket: ${made.error.message}`);
        const row = await db.ticket.create({
          data: {
            organizationId,
            projectId: project.id,
            boardId: boardRow.id,
            connectionId: connection.id,
            externalId: made.value.externalId,
            key: made.value.key,
            title,
            description: "Somewhere in the app.",
            statusId: made.value.status.id,
            statusName: made.value.status.name,
            statusCategory: made.value.status.category,
            open: true,
            labels: ["frontend"],
            url: made.value.url,
            trackerUpdatedAt: new Date(),
          },
        });
        return { id: row.id, key: made.value.key, externalId: made.value.externalId };
      })();

const task = await db.task.create({
  data: {
    organizationId,
    projectId: project.id,
    kind: "refine",
    source: args.source,
    title,
    prompt: args.source === "prompt" ? title : null,
    branchName: `ostra/${randomUUID().slice(0, 8)}-refine`,
    state: "needs_you",
    needsYouReason: "draft_ready",
    driverMemberId: admin.id,
    creatorMemberId: admin.id,
    agentProfileId: profiles.refine,
    ...(ticket === null ? {} : { ticketId: ticket.id, ticketKey: ticket.key, boardId: boardRow.id }),
  },
});
const taskId = taskIdSchema.parse(task.id);
// The session the agent's turns ran in, now idle: `draft.apply` records what it wrote on it.
await db.session.create({ data: { organizationId, projectId: project.id, taskId, agentProfileId: profiles.refine, origin: "new", state: "idle" } });
const jobs = { enqueueInTx: () => Promise.resolve() };
for (const draft of [sampleDraft, secondDraft]) {
  const saved = await db.$transaction((tx) => saveDraft({ tx, notices: postgresChangeNotices, clock: systemClock, jobs, audit: { recordInTx: () => Promise.resolve() } }, { organizationId, taskId, draft }));
  if (!saved.ok) throw new Error(`the draft wasn't saved: ${saved.message}`);
}
await db.needsYouItem.create({ data: { organizationId, projectId: project.id, taskId, reason: "draft_ready", audience: "driver" } });

process.stdout.write(`${JSON.stringify({ projectId: project.id, taskId, ticketKey: ticket?.key ?? null, externalId: ticket?.externalId ?? null, boardId: boardRow.id })}\n`);
await db.$disconnect();
