// What the step-in spec (`21-step-in.spec.ts`, milestone 3's ticket 47) needs that no page makes on
// this stack, written as core and ingest write it. The throwaway e2e database only. Run as
// `node e2e/seed-step-in.ts '<json>'`; prints one JSON line.
//
// - `checks`: in a project the spec made through New project on the fake GitHub's `test1`, two
//   checks in the environment, and a task in review whose turn pushed a branch and ran them: `lint`
//   passed, `unit-tests` failed with its output's end in the `check.finished` event (F-054, F-028).
// - `github-link`: the GitHub connection's OAuth client secret, kept in the built-in secret store as
//   the App's manifest flow keeps it, so the install can link a member's GitHub account (F-119).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb, notifyChannels } from "@ostra/db";
import { recordChecksRunInTx } from "@ostra/domain";
import { checkIdSchema, gitShaSchema, organizationIdSchema, sessionIdSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("part", [
  z.strictObject({ part: z.literal("checks"), databaseUrl: z.string(), projectId: z.string() }),
  z.strictObject({ part: z.literal("github-link"), databaseUrl: z.string(), dataDir: z.string(), clientSecret: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

/** The failing check's output: what the Checks tab shows and "Ask the agent to fix" sends. */
const failingTail = ["FAIL src/calc.test.ts > adds two numbers", "AssertionError: expected 5 to be 4", "Tests  1 failed | 11 passed (12)"].join("\n");

/** A runner's events, numbered per task as ingest numbers them, then one wake-up NOTIFY. */
const appendRunnerEvents = async (taskId: string, sessionId: string, events: readonly TaskEvent[]): Promise<void> => {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
  await db.event.createMany({
    data: events.map((event, i) => ({
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId,
      seq: task.eventSeq + i + 1,
      sessionId,
      sessionSeq: session.ingestedSeq + i + 1,
      leaseEpoch: null,
      kind: event.kind,
      payload: event,
      occurredAt: new Date(Date.now() - (events.length - i) * 50),
    })),
  });
  await db.task.update({ where: { id: taskId }, data: { eventSeq: task.eventSeq + events.length } });
  await db.session.update({ where: { id: sessionId }, data: { ingestedSeq: session.ingestedSeq + events.length } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq: task.eventSeq + events.length })})`;
};

const seedChecks = async (projectId: string): Promise<void> => {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { repos: { orderBy: { position: "asc" } }, environment: true } });
  const organizationId = project.organizationId;
  const repo = project.repos[0];
  const environment = project.environment;
  if (repo === undefined || environment === null) throw new Error("the project has no repo or no environment");
  const admin = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });

  const lint = await db.check.create({ data: { organizationId, projectId, environmentId: environment.id, name: "lint", command: "pnpm lint", repoId: null, position: 0 } });
  const unit = await db.check.create({ data: { organizationId, projectId, environmentId: environment.id, name: "unit-tests", command: "pnpm test", repoId: repo.id, position: 1 } });

  const title = "Make the calculator add";
  const task = await db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-calc-add`,
      state: "in_review",
      subState: "waiting_for_reviewer",
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  const session = await db.session.create({ data: { organizationId, projectId, taskId: task.id, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date() } });
  const head = gitShaSchema.parse("c".repeat(40));
  const prUrl = `https://github.com/${repo.fullName}/pull/21`;
  const taskRepo = await db.taskRepo.create({
    data: { organizationId, projectId, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main", state: "pr_open", headSha: head, prNumber: 21, prUrl, prTitle: title },
  });
  // A failing check made the PR a draft (ostra's own, so it marks it ready once the checks pass).
  await db.taskPullRequest.create({ data: { organizationId, projectId, taskRepoId: taskRepo.id, number: 21, url: prUrl, branchName: task.branchName, draft: true, draftByOstra: true } });

  // Turn 1's checks, as ingest stores them: the run rows, each `check.finished` with its output's end, then the push.
  const results = [
    { checkId: checkIdSchema.parse(lint.id), status: "passed", exitCode: 0, durationMs: 2_100, outputTail: "All files pass linting." },
    { checkId: checkIdSchema.parse(unit.id), status: "failed", exitCode: 1, durationMs: 4_800, outputTail: failingTail },
  ] as const;
  const recorded = await db.$transaction((tx) =>
    recordChecksRunInTx(tx, {
      taskId: taskIdSchema.parse(task.id),
      sessionId: sessionIdSchema.parse(session.id),
      turnOrdinal: 1,
      checks: results.map((result) => ({ checkId: result.checkId, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs, outputBlobId: null })),
    }),
  );
  if (!recorded.ok) throw new Error(`the checks weren't recorded: ${recorded.message}`);
  await appendRunnerEvents(task.id, session.id, [
    ...results.map((result) => taskEventSchema.parse({ kind: "check.finished", ...result, outputBlobId: null })),
    taskEventSchema.parse({ kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo.id, headSha: head, ahead: true, hiddenRefSha: null }], archive: null }),
  ]);
  process.stdout.write(`${JSON.stringify({ taskId: task.id, failingCheckId: unit.id, failingTail })}\n`);
};

const seedGitHubLink = async (dataDir: string, clientSecret: string): Promise<void> => {
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
  const connection = await db.connection.findFirstOrThrow({ where: { kind: "github", state: "active" }, orderBy: { createdAt: "asc" } });
  if (connection.clientSecretSecretRef === null) {
    const key = parseSecretsKey((await readFile(path.join(dataDir, "secrets-key"), "utf8")).trim());
    if (!key.ok) throw new Error("the stack's secrets key didn't parse");
    const store = new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: adapterClock });
    const kept = await store.put({ organizationId: organizationIdSchema.parse(connection.organizationId), purpose: "github-app.client-secret" }, clientSecret);
    if (!kept.ok) throw new Error("the secret store refused the client secret");
    await db.connection.update({ where: { id: connection.id }, data: { clientSecretSecretRef: kept.value } });
  }
  process.stdout.write(`${JSON.stringify({ connectionId: connection.id })}\n`);
};

switch (args.part) {
  case "checks":
    await seedChecks(args.projectId);
    break;
  case "github-link":
    await seedGitHubLink(args.dataDir, args.clientSecret);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
