import {
  agentProfileIdSchema,
  approvalIdSchema,
  blobIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  commandIdSchema,
  memberIdSchema,
  modelIdSchema,
  optionIdSchema,
  organizationIdSchema,
  projectIdSchema,
  providerIdSchema,
  questionIdSchema,
  replicaIdSchema,
  repoIdSchema,
  runnerIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketKeySchema,
  toolCallIdSchema,
  turnIdSchema,
  uploadIdSchema,
} from "../ids.ts";
import type { TaskEvent, TaskEventKind, TaskEventOf } from "../events/agent-events.ts";
import { taskCredentialsSchema } from "../task/credentials.ts";
import type { TaskCredentials } from "../task/credentials.ts";
import type { TaskSpec } from "../task/spec.ts";

// Fixed test data: one valid example of every event kind, a task spec and its credentials. The
// fold's tests (ticket 36) and the contract suites read these, so every consumer agrees on what a
// valid value looks like. Values are fake: no token here works anywhere.

/** Fixed IDs, parsed with their schemas. */
export const fixtureIds = {
  organization: organizationIdSchema.parse("0196f1a0-0000-7000-8000-000000000001"),
  project: projectIdSchema.parse("0196f1a0-0000-7000-8000-000000000002"),
  repo: repoIdSchema.parse("0196f1a0-0000-7000-8000-000000000003"),
  task: taskIdSchema.parse("0196f1a0-0000-7000-8000-000000000004"),
  session: sessionIdSchema.parse("0196f1a0-0000-7000-8000-000000000005"),
  turn: turnIdSchema.parse("0196f1a0-0000-7000-8000-000000000006"),
  member: memberIdSchema.parse("0196f1a0-0000-7000-8000-000000000007"),
  otherMember: memberIdSchema.parse("0196f1a0-0000-7000-8000-000000000008"),
  runner: runnerIdSchema.parse("0196f1a0-0000-7000-8000-000000000009"),
  box: boxIdSchema.parse("0196f1a0-0000-7000-8000-00000000000a"),
  provider: providerIdSchema.parse("0196f1a0-0000-7000-8000-00000000000b"),
  model: modelIdSchema.parse("0196f1a0-0000-7000-8000-00000000000c"),
  profile: agentProfileIdSchema.parse("0196f1a0-0000-7000-8000-00000000000d"),
  approval: approvalIdSchema.parse("0196f1a0-0000-7000-8000-00000000000e"),
  command: commandIdSchema.parse("0196f1a0-0000-7000-8000-00000000000f"),
  segment: segmentIdSchema.parse("seg-1"),
  toolCall: toolCallIdSchema.parse("call-1"),
  question: questionIdSchema.parse("question-1"),
  clientMessage: clientMessageIdSchema.parse("client-msg-1"),
  option: optionIdSchema.parse("allow-once"),
  replica: replicaIdSchema.parse("replica-1"),
  // Minor 1 (milestone 2).
  blob: blobIdSchema.parse("0196f1a0-0000-7000-8000-000000000010"),
  ticketFileBlob: blobIdSchema.parse("0196f1a0-0000-7000-8000-000000000011"),
  upload: uploadIdSchema.parse("0196f1a0-0000-7000-8000-000000000012"),
  ticketKey: ticketKeySchema.parse("OST-12"),
  replayedMessage: clientMessageIdSchema.parse("client-msg-2"),
} as const;

const ids = fixtureIds;

/** A fake SHA-256 digest and two commits, valid by shape only. */
export const fixtureDigests = {
  sha256: "a".repeat(64),
  headSha: "0123456789abcdef0123456789abcdef01234567",
  hiddenRefSha: "89abcdef0123456789abcdef0123456789abcdef",
  baseSha: "fedcba9876543210fedcba9876543210fedcba98",
} as const;

/** One valid example of every event kind. A missing kind is a type error. */
export const eventFixtures: { readonly [K in TaskEventKind]: TaskEventOf<K> } = {
  "user.message": {
    kind: "user.message",
    memberId: ids.member,
    clientMessageId: ids.clientMessage,
    text: "Add a CONTRIBUTING.md",
    delivery: "immediate",
  },
  "turn.started": { kind: "turn.started", turnId: ids.turn },
  "turn.ended": { kind: "turn.ended", turnId: ids.turn, stopReason: "end_turn" },
  "turn.failed": { kind: "turn.failed", turnId: ids.turn, error: "the model endpoint returned 500" },
  "turn.cancel_requested": { kind: "turn.cancel_requested", memberId: ids.member },
  "agent.message": { kind: "agent.message", turnId: ids.turn, segmentId: ids.segment, text: "Done." },
  "agent.thought": { kind: "agent.thought", turnId: ids.turn, segmentId: ids.segment, text: "Reading the README first." },
  "agent.content": {
    kind: "agent.content",
    turnId: ids.turn,
    block: { type: "resource_link", uri: "file:///workspace/test1/README.md", title: "README.md" },
  },
  "tool.called": {
    kind: "tool.called",
    turnId: ids.turn,
    toolCallId: ids.toolCall,
    toolKind: "edit",
    title: "Edit CONTRIBUTING.md",
    input: { paths: ["CONTRIBUTING.md"] },
  },
  "tool.progress": { kind: "tool.progress", toolCallId: ids.toolCall, output: { lines: 3 } },
  "tool.completed": {
    kind: "tool.completed",
    toolCallId: ids.toolCall,
    output: { files: [{ path: "CONTRIBUTING.md", added: 12, removed: 0 }] },
  },
  "tool.failed": { kind: "tool.failed", toolCallId: ids.toolCall, error: "permission denied" },
  "approval.requested": {
    kind: "approval.requested",
    turnId: ids.turn,
    approvalId: ids.approval,
    toolCallId: ids.toolCall,
    options: [
      { optionId: ids.option, label: "Allow once", kind: "allow-once", decision: "allow_once" },
      { optionId: optionIdSchema.parse("reject-once"), label: "Deny", kind: "reject-once", decision: "deny" },
    ],
  },
  "approval.answered": {
    kind: "approval.answered",
    approvalId: ids.approval,
    optionId: ids.option,
    decision: "allow_once",
    memberId: ids.member,
  },
  "approval.auto_answered": { kind: "approval.auto_answered", approvalId: ids.approval, ruleId: "rule-1" },
  "approval.closed": { kind: "approval.closed", approvalId: ids.approval, reason: "cancelled" },
  "question.asked": {
    kind: "question.asked",
    turnId: ids.turn,
    questionId: ids.question,
    message: "Which test runner?",
    fields: [{ id: "runner", label: "Runner", type: "select", options: ["vitest", "jest"] }],
  },
  "question.answered": {
    kind: "question.answered",
    questionId: ids.question,
    answers: { runner: "vitest" },
    memberId: ids.member,
  },
  "question.closed": { kind: "question.closed", questionId: ids.question, reason: "expired" },
  "plan.updated": {
    kind: "plan.updated",
    turnId: ids.turn,
    entries: [{ content: "Write CONTRIBUTING.md", priority: "high", status: "in_progress" }],
  },
  "compaction.updated": { kind: "compaction.updated", turnId: ids.turn, status: "done", summary: "Summary." },
  "session.config_changed": { kind: "session.config_changed", key: "mode", value: "build" },
  "driver.changed": { kind: "driver.changed", memberId: ids.otherMember, byMemberId: ids.member },
  "runner.connected": { kind: "runner.connected", runnerId: ids.runner },
  "runner.lost": { kind: "runner.lost", runnerId: ids.runner },
  "session.restored": { kind: "session.restored" },
  "session.crashed": { kind: "session.crashed", error: "the agent exited with code 1" },
  "pr.opened": { kind: "pr.opened", repoId: ids.repo, url: "https://github.com/ostra-test/test1/pull/1", number: 1 },
  "agent.unknown": { kind: "agent.unknown", acpKind: "usage_update", raw: "{}" },
  "environment.setup_started": { kind: "environment.setup_started" },
  "environment.setup_output": { kind: "environment.setup_output", stream: "stdout", text: "Installing...\n" },
  "environment.setup_finished": { kind: "environment.setup_finished", exitCode: 0, durationMs: 1200 },
  "git.pushed": {
    kind: "git.pushed",
    repoId: ids.repo,
    branch: "ostra/0196f1a0-add-contributing",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    ref: "refs/heads/ostra/0196f1a0-add-contributing",
  },
  "pr.text_set": { kind: "pr.text_set", repoId: ids.repo, title: "Add CONTRIBUTING.md", body: "Adds a short guide." },
  "session.ended": { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: ids.repo, ahead: true }] },
  "usage.recorded": {
    kind: "usage.recorded",
    providerId: ids.provider,
    modelId: ids.model,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  },
  "session.usage": { kind: "session.usage", contextUsed: 12_000, contextSize: 200_000 },
  "provider.rate_limited": { kind: "provider.rate_limited", providerId: ids.provider, retryAfterSeconds: 30 },
  // Minor 1 (milestone 2).
  "session.saved": {
    kind: "session.saved",
    turnOrdinal: 1,
    repos: [
      { repoId: ids.repo, headSha: fixtureDigests.headSha, ahead: true, hiddenRefSha: fixtureDigests.hiddenRefSha },
    ],
    archive: { blobId: ids.blob, size: 48_213, sha256: fixtureDigests.sha256 },
  },
  "session.limit_reached": { kind: "session.limit_reached", limit: "spend-cap", observed: 25_000_000 },
  "ticket.files_ready": { kind: "ticket.files_ready", files: [{ path: "screenshot-1.png", blobId: ids.ticketFileBlob }] },
};

/**
 * Minor 1's optional fields, present: the events whose shape grew in minor 1, with every new
 * field set. `eventFixtures` holds the same kinds without them, as a minor-0 peer sends them.
 */
export const minor1FieldFixtures = {
  "user.message": {
    kind: "user.message",
    memberId: ids.member,
    clientMessageId: ids.replayedMessage,
    text: "Also add today's date at the top.",
    delivery: "immediate",
    replayed: true,
    reopen: true,
  },
  "session.restored": {
    kind: "session.restored",
    origin: "restored",
    replayedUpdates: 42,
    hiddenRef: "applied",
    previousBox: "lost",
  },
  "session.crashed": { kind: "session.crashed", error: "the box went away", cause: "box_lost" },
  "session.saved, nothing saved": {
    kind: "session.saved",
    turnOrdinal: 2,
    repos: [{ repoId: ids.repo, headSha: null, ahead: false, hiddenRefSha: null }],
    archive: null,
  },
} as const satisfies Readonly<Record<string, TaskEvent>>;

/** A full task spec for `ostra-test/test1`. */
export const taskSpecFixture: TaskSpec = {
  taskId: ids.task,
  sessionId: ids.session,
  projectId: ids.project,
  organizationId: ids.organization,
  kind: "code",
  title: "Add CONTRIBUTING.md",
  prompt: "Add a short CONTRIBUTING.md that explains how to run the tests",
  branchName: "ostra/0196f1a0-add-contributing",
  leaseEpoch: 1,
  repos: [
    {
      repoId: ids.repo,
      fullName: "ostra-test/test1",
      cloneUrl: "https://github.com/ostra-test/test1.git",
      defaultBranch: "main",
      checkoutDir: "test1",
      lfsActionHosts: ["github-cloud.githubusercontent.com"],
      prTemplate: null,
    },
  ],
  agent: {
    profileId: ids.profile,
    adapter: "opencode",
    providerId: ids.provider,
    modelId: ids.model,
    endpointModelId: "test-model",
    apiFormat: "anthropic-messages",
    instructions: null,
  },
  environment: {
    setupScript: "pnpm install",
    baseImage: null,
    repos: [
      {
        repoId: ids.repo,
        variables: [{ name: "NODE_ENV", value: "test", availableDuringSetup: true }],
        files: [],
        envFile: ".env",
      },
    ],
  },
  gitIdentity: { name: "ostra-test-app[bot]", email: "5821041+ostra-test-app[bot]@users.noreply.github.com" },
  coAuthors: [{ name: "Admin", email: "admin@example.com" }],
  limits: { turnMaxMinutes: 60 },
};

/** A ticket task's spec at minor 1, reopened on a fresh box: every minor-1 field set. */
export const taskSpecMinor1Fixture: TaskSpec = {
  ...taskSpecFixture,
  title: "OST-12: Add today's date to the README",
  prompt: "<ticket>\nAdd today's date to the README\n</ticket>",
  branchName: "ostra/ost-12-00000004-add-todays-date",
  leaseEpoch: 2,
  limits: {
    turnMaxMinutes: 60,
    idleMinutes: 15,
    spendCap: {
      capMicroUsd: 25_000_000,
      spentMicroUsd: 1_250_000,
      prices: { inputPerMTok: 3_000_000, outputPerMTok: 15_000_000, cacheReadPerMTok: 300_000, cacheWritePerMTok: 3_750_000 },
    },
  },
  ticket: { key: ids.ticketKey, title: "Add today's date to the README", url: "https://linear.app/ostra-test/issue/OST-12" },
  contextFiles: [{ blobId: ids.ticketFileBlob, path: "screenshot-1.png", contentType: "image/png", size: 20_480 }],
  restore: {
    origin: "restored",
    archive: { blobId: ids.blob, size: 48_213, sha256: fixtureDigests.sha256 },
    hiddenRefs: [{ repoId: ids.repo, sha: fixtureDigests.hiddenRefSha, baseSha: fixtureDigests.baseSha }],
    pendingMessages: [{ clientMessageId: ids.replayedMessage, text: "Also add today's date at the top." }],
  },
};

/** A full set of task credentials. Every value is fake. */
export const taskCredentialsFixture: TaskCredentials = taskCredentialsSchema.parse({
  taskId: ids.task,
  leaseEpoch: 1,
  model: {
    baseUrl: "http://127.0.0.1:9/v1",
    apiFormat: "anthropic-messages",
    authScheme: "x-api-key",
    token: "fixture-model-token",
  },
  repos: [{ repoId: ids.repo, gitToken: "fixture-git-token", expiresAt: 1_900_000_000_000 }],
  secrets: [
    {
      repoId: ids.repo,
      entries: [{ kind: "variable", name: "API_KEY", value: "fixture-secret", availableDuringSetup: false }],
    },
  ],
  mcpToken: "fixture-mcp-token",
});
