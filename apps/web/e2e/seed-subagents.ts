// What the subagents spec needs (F-138, milestone 7's ticket 39): three tasks on OpenCode whose
// agent's turn started four subagents, one nested in another, as a minor-6 runner stores them
// (`subagent.started`, `subagent.status`, the subagent on each call and answer). In `running` the
// general subagent still works; in `failed` it failed with an error; in `approval` its command waits
// on an approval, with the approval's row, so the thread's card is answerable. The throwaway e2e
// database only. Run as `node e2e/seed-subagents.ts '<json>'`; prints one JSON line: the tasks.

import { randomUUID } from "node:crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { taskEventSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string() });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;

// A provider row only: no endpoint is called, and the token ref names no stored secret.
const provider = await db.modelProvider.upsert({
  where: { organizationId_name: { organizationId, name: "e2e-subagents" } },
  create: { organizationId, name: "e2e-subagents", baseUrl: "http://127.0.0.1:9/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:e2e-subagents" },
  update: {},
});
const model = await db.model.upsert({
  where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-5-5" } },
  create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  update: {},
});
const profile =
  (await db.agentProfile.findFirst({ where: { organizationId, name: "Subagents" } })) ??
  (await db.agentProfile.create({ data: { organizationId, name: "Subagents", adapter: "opencode", modelId: model.id, providerId: provider.id } }));
const project =
  (await db.project.findFirst({ where: { organizationId, slug: "calculator" } })) ??
  (await db.project.create({ data: { organizationId, name: "calculator", slug: "calculator", access: "open" } }));

type Scenario = "running" | "failed" | "approval";

const MINUTE = 60_000;

/** The turn, as the runner stores it: each event with its time, from six minutes ago. */
const turnOf = (scenario: Scenario, approvalId: string): { readonly events: readonly { readonly at: number; readonly event: TaskEvent }[] } => {
  const t0 = Date.now() - 6 * MINUTE;
  const turnId = randomUUID();
  const out: { at: number; event: TaskEvent }[] = [];
  const at = (seconds: number, event: Record<string, unknown>): void => {
    out.push({ at: t0 + seconds * 1000, event: taskEventSchema.parse(event) });
  };
  let segment = 0;
  const say = (seconds: number, text: string, subagentId?: string): void => {
    segment += 1;
    at(seconds, { kind: "agent.message", turnId, segmentId: `seg-${String(segment)}`, text, ...(subagentId === undefined ? {} : { subagentId }) });
  };
  let callN = 0;
  const call = (seconds: number, toolKind: string, title: string, input: Record<string, unknown>, output: Record<string, unknown> | null, subagentId?: string): string => {
    callN += 1;
    const toolCallId = `${subagentId ?? "main"}:call-${String(callN)}`;
    at(seconds, { kind: "tool.called", turnId, toolCallId, toolKind, title, input, ...(subagentId === undefined ? {} : { subagentId }) });
    if (output !== null) at(seconds + 1, { kind: "tool.completed", toolCallId, output });
    return toolCallId;
  };
  const start = (seconds: number, owner: string | undefined, subagentId: string, type: string, description: string, prompt: string, depth: number): void => {
    const toolCallId = call(seconds, "think", owner === undefined ? "subagent" : `${description}: subagent`, { agent: type, description, prompt }, { metadata: { sessionID: subagentId, status: "running", truncated: false } }, owner);
    at(seconds + 1, { kind: "subagent.started", toolCallId, subagentId, depth, type, description, prompt, ...(owner === undefined ? {} : { parentSubagentId: owner }) });
    at(seconds + 1, { kind: "subagent.status", subagentId, status: "running" });
  };
  const reads = (from: number, subagentId: string, paths: readonly string[]): void => {
    paths.forEach((path, index) => {
      call(from + index * 2, index % 3 === 2 ? "search" : "read", index % 3 === 2 ? "grep" : "read", index % 3 === 2 ? { pattern: path } : { path }, index % 3 === 2 ? { metadata: { matches: 3 } } : { lineCount: 40 }, subagentId);
    });
  };
  const versionSource = "ses_version_source";
  const settingsTests = "ses_settings_tests";
  const versionRow = "ses_version_row";
  const testHelpers = "ses_test_helpers";

  at(0, { kind: "turn.started", turnId });
  say(2, "I'll have subagents find where the build info is read and how the settings tests are set up, then add the version row.");
  call(4, "read", "read", { path: "src/settings/page.tsx" }, { lineCount: 64 });
  start(10, undefined, versionSource, "explore", "Find the version source", "Find where the app's version is read at build time, and how Settings could show it.", 1);
  start(12, undefined, settingsTests, "explore", "List settings tests", "List the tests of `src/settings/` and the helpers they render with.", 1);
  reads(14, versionSource, ["package.json", "next.config.ts", "version", "src/lib/build-info.ts", "src/settings/page.tsx", "BUILD_VERSION", "src/app/layout.tsx", "scripts/build.ts", "process.env", "src/lib/env.ts", "src/settings/rows.tsx", "version-row", "README.md", "CHANGELOG.md"]);
  reads(15, settingsTests, ["src/settings", "src/settings/theme.test.tsx", "describe(", "src/settings/account.test.tsx", "test/render.tsx", "renderWithProviders"]);
  say(43, "Six settings tests live in `src/settings/`; each renders with `renderWithProviders` from `test/render.tsx`.", settingsTests);
  at(44, { kind: "subagent.status", subagentId: settingsTests, status: "completed" });
  say(82, "The version comes from `package.json`, read at build time in `src/lib/build-info.ts` and exposed as `BUILD_VERSION`.", versionSource);
  at(83, { kind: "subagent.status", subagentId: versionSource, status: "completed" });
  start(130, undefined, versionRow, "general", "Write version row test", "Add a test for the version row in `src/settings/version-row.test.tsx`. Use the render helpers the other settings tests use. Run `pnpm test settings` and report what fails.", 1);
  call(140, "read", "read", { path: "test/render.tsx" }, { lineCount: 31 }, versionRow);
  call(144, "search", "grep", { pattern: "renderWithProviders" }, { metadata: { matches: 4 } }, versionRow);
  start(150, versionRow, testHelpers, "explore", "Find test helpers", "Find the render helpers the settings tests use, and what each wraps.", 2);
  reads(151, testHelpers, ["test/render.tsx", "test/setup.ts", "renderWithProviders", "src/settings/theme.test.tsx", "test/fixtures.ts"]);
  say(172, "`renderWithProviders`, in `test/render.tsx`, wraps a page in the theme and the router.", testHelpers);
  at(173, { kind: "subagent.status", subagentId: testHelpers, status: "completed" });
  call(180, "edit", "edit", { paths: ["src/settings/version-row.test.tsx"] }, { files: [{ path: "src/settings/version-row.test.tsx", added: 38, removed: 0 }] }, versionRow);
  call(200, "edit", "edit", { paths: ["src/settings/page.tsx"] }, { files: [{ path: "src/settings/page.tsx", added: 24, removed: 3 }] });
  call(206, "edit", "edit", { paths: ["src/lib/build-info.ts"] }, { files: [{ path: "src/lib/build-info.ts", added: 9, removed: 0 }] });
  const run = call(250, "execute", "pnpm test settings", { command: "pnpm test settings" }, null, versionRow);
  switch (scenario) {
    case "running":
      break;
    case "failed":
      at(262, { kind: "tool.failed", toolCallId: run, error: "the turn's model call failed" });
      at(263, { kind: "subagent.status", subagentId: versionRow, status: "failed", error: "The model endpoint returned 500 after 3 retries." });
      break;
    case "approval":
      at(251, {
        kind: "approval.requested",
        turnId,
        approvalId,
        toolCallId: run,
        options: [
          { optionId: "allow-once", label: "Allow once", kind: "allow-once", decision: "allow_once" },
          { optionId: "reject-once", label: "Reject", kind: "reject-once", decision: "deny" },
        ],
        rule: null,
        subject: { kind: "command", value: "pnpm test settings" },
        subagentId: versionRow,
      });
      break;
    default:
      scenario satisfies never;
  }
  return { events: out.sort((a, b) => a.at - b.at) };
};

const seed = async (scenario: Scenario, title: string): Promise<string> => {
  const approvalId = randomUUID();
  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title,
      prompt: "Show the app version and the commit in Settings, read at build time.",
      branchName: `ostra/${randomUUID().slice(0, 8)}-app-version`,
      state: scenario === "approval" ? "needs_you" : "running",
      ...(scenario === "approval" ? { needsYouReason: "approval" as const } : {}),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
      agentProfileId: profile.id,
    },
  });
  const session = await db.session.create({
    data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "running", agentProfileId: profile.id, providerId: provider.id, modelId: model.id },
  });
  const { events } = turnOf(scenario, approvalId);
  const prompt = { at: (events[0]?.at ?? Date.now()) - 1000, event: taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: "Show the app version and the commit in Settings, read at build time.", delivery: "immediate" }) };
  const all = [prompt, ...events];
  await db.event.createMany({
    data: all.map((item, i) => ({
      organizationId,
      projectId: project.id,
      taskId: task.id,
      seq: i + 1,
      sessionId: session.id,
      sessionSeq: item.event.kind === "user.message" ? null : i,
      leaseEpoch: null,
      kind: item.event.kind,
      payload: item.event,
      occurredAt: new Date(item.at),
    })),
  });
  await db.turn.create({ data: { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, startSeq: 2, ordinal: 1 } });
  if (scenario === "approval") {
    const run = events.find((item) => item.event.kind === "approval.requested")?.event;
    await db.approval.create({
      data: {
        id: approvalId,
        organizationId,
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        toolCallId: run?.kind === "approval.requested" ? run.toolCallId : "",
        options: run?.kind === "approval.requested" ? run.options : [],
        subjectKind: "command",
        subjectValue: "pnpm test settings",
      },
    });
  }
  await db.task.update({ where: { id: task.id }, data: { eventSeq: all.length } });
  await db.session.update({ where: { id: session.id }, data: { ingestedSeq: all.length - 1 } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: all.length })})`;
  return task.id;
};

const running = await seed("running", "Show the app version in Settings");
const failed = await seed("failed", "Show the app version in Settings (a subagent fails)");
const approval = await seed("approval", "Show the app version in Settings (a subagent asks)");
process.stdout.write(`${JSON.stringify({ running, failed, approval })}\n`);
await db.$disconnect();
