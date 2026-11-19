import {
  agentProfileIdSchema,
  approvalIdSchema,
  approvalRuleIdSchema,
  blobIdSchema,
  boxIdSchema,
  budgetIdSchema,
  checkIdSchema,
  clientMessageIdSchema,
  commandIdSchema,
  diffCommentIdSchema,
  effortChangeIdSchema,
  memberIdSchema,
  modelIdSchema,
  noteIdSchema,
  optionIdSchema,
  organizationIdSchema,
  projectIdSchema,
  proposalIdSchema,
  providerIdSchema,
  questionIdSchema,
  replicaIdSchema,
  repoIdSchema,
  runnerIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  taskApprovalRuleIdSchema,
  taskIdSchema,
  ticketKeySchema,
  toolCallIdSchema,
  turnIdSchema,
  uploadIdSchema,
} from "../ids.ts";
import type { EffortLevel, ReasoningControls } from "../agent/effort.ts";
import type { ApprovalRule, TaskRule } from "../agent/rules.ts";
import type { MemoryIndexEntry, MemoryNote, MemoryProposalInput } from "../memory/notes.ts";
import type { TaskEvent, TaskEventKind, TaskEventOf } from "../events/agent-events.ts";
import type { Command, CommandKind } from "../runner/commands.ts";
import type { Hello, RunnerCapabilities, Status } from "../runner/messages.ts";
import type {
  HttpSuperseded,
  InfoResponse,
  PullCredentialRequest,
  PushCredentialRequest,
  RegistryCredential,
  RegistryCredentialRefusal,
  MemoryNoteResponse,
  MemoryProposalRefusal,
  MemoryProposalRequest,
  MemoryProposalResponse,
  MemorySearchRequest,
  MemorySearchResponse,
} from "../runner/http.ts";
import { snapshotCredentialsSchema, taskCredentialsSchema } from "../task/credentials.ts";
import type { SnapshotCredentials, TaskCredentials } from "../task/credentials.ts";
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
  // Minor 2 (milestone 3).
  profileRule: approvalRuleIdSchema.parse("0196f1a0-0000-7000-8000-000000000013"),
  taskRule: taskApprovalRuleIdSchema.parse("0196f1a0-0000-7000-8000-000000000014"),
  check: checkIdSchema.parse("0196f1a0-0000-7000-8000-000000000015"),
  checkOutputBlob: blobIdSchema.parse("0196f1a0-0000-7000-8000-000000000016"),
  snapshot: snapshotIdSchema.parse("0196f1a0-0000-7000-8000-000000000017"),
  diffComment: diffCommentIdSchema.parse("0196f1a0-0000-7000-8000-000000000018"),
  skillBlob: blobIdSchema.parse("0196f1a0-0000-7000-8000-000000000019"),
  skillFileBlob: blobIdSchema.parse("0196f1a0-0000-7000-8000-00000000001a"),
  // Minor 3 (milestone 4).
  note: noteIdSchema.parse("0196f1a0-0000-7000-8000-00000000001b"),
  alwaysNote: noteIdSchema.parse("0196f1a0-0000-7000-8000-00000000001c"),
  proposal: proposalIdSchema.parse("0196f1a0-0000-7000-8000-00000000001d"),
  budget: budgetIdSchema.parse("0196f1a0-0000-7000-8000-00000000001e"),
  secondRepo: repoIdSchema.parse("0196f1a0-0000-7000-8000-00000000001f"),
  effortChange: effortChangeIdSchema.parse("0196f1a0-0000-7000-8000-000000000020"),
  // Minor 4 (milestone 5).
  secondBox: boxIdSchema.parse("0196f1a0-0000-7000-8000-000000000021"),
} as const;

const ids = fixtureIds;

/** A fake SHA-256 digest and two commits, valid by shape only. */
export const fixtureDigests = {
  sha256: "a".repeat(64),
  headSha: "0123456789abcdef0123456789abcdef01234567",
  hiddenRefSha: "89abcdef0123456789abcdef0123456789abcdef",
  baseSha: "fedcba9876543210fedcba9876543210fedcba98",
  imageDigest: `sha256:${"b".repeat(64)}`,
} as const;

/** A profile's rules, one per match kind (ADR 0049), as the presets and a custom rule make them. */
export const approvalRuleFixtures = {
  dependencyFiles: {
    ruleId: ids.profileRule,
    name: "Adding a dependency",
    tool: "edit",
    match: { kind: "path-glob", glob: "**/package.json" },
    preset: "dependency",
  },
  dependencyCommands: {
    ruleId: approvalRuleIdSchema.parse("rule-dependency-commands"),
    name: "Adding a dependency",
    tool: "execute",
    match: { kind: "command-prefix", prefixes: ["pnpm add", "npm install"] },
    preset: "dependency",
  },
  allowlist: {
    ruleId: approvalRuleIdSchema.parse("rule-allowlist"),
    name: "Commands outside an allowlist",
    tool: "execute",
    match: { kind: "command-outside", allowlist: ["git status", "pnpm test", "ls"] },
    preset: "allowlist",
  },
  network: {
    ruleId: approvalRuleIdSchema.parse("rule-network"),
    name: "Reaching the network",
    tool: "fetch",
    match: { kind: "any" },
    preset: "network",
  },
  mcp: {
    ruleId: approvalRuleIdSchema.parse("rule-mcp"),
    name: "Reaching the network",
    tool: "mcp",
    match: { kind: "mcp-not-read-only" },
    preset: "network",
  },
  custom: {
    ruleId: approvalRuleIdSchema.parse("rule-custom"),
    name: "Touching the CI",
    tool: "edit",
    match: { kind: "path-glob", glob: ".github/**" },
  },
} as const satisfies Readonly<Record<string, ApprovalRule>>;

/** A "for this task" rule, as "Approve for this task" on `pnpm add zod` writes it. */
export const taskRuleFixture: TaskRule = { ruleId: ids.taskRule, tool: "execute", pattern: "pnpm add" };

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
  "workspace.files_outside_repos": { kind: "workspace.files_outside_repos", paths: ["notes.md", "plan.txt"], more: 0 },
  // Minor 2 (milestone 3).
  "plan.proposed": {
    kind: "plan.proposed",
    turnId: ids.turn,
    entries: [
      { content: "Read the README and the docs folder", priority: "medium", status: "pending" },
      { content: "Add CONTRIBUTING.md", priority: "high", status: "pending" },
    ],
    message: "I'll add a short guide and link it from the README.",
  },
  "plan.answered": {
    kind: "plan.answered",
    decision: "revise",
    text: "Also mention the commit message format.",
    memberId: ids.member,
  },
  "check.started": { kind: "check.started", checkId: ids.check, repoId: ids.repo, name: "Tests" },
  "check.finished": {
    kind: "check.finished",
    checkId: ids.check,
    status: "failed",
    exitCode: 1,
    durationMs: 18_400,
    outputTail: "FAIL src/add.test.ts > adds\n",
    outputBlobId: ids.checkOutputBlob,
  },
  "snapshot.built": {
    kind: "snapshot.built",
    snapshotId: ids.snapshot,
    imageDigest: fixtureDigests.imageDigest,
    durationMs: 95_000,
  },
  "snapshot.failed": {
    kind: "snapshot.failed",
    snapshotId: ids.snapshot,
    reason: "secret-found",
    detail: "The image holds the value of NPM_TOKEN.",
  },
  "service.healthy": { kind: "service.healthy", name: "postgres", afterMs: 2_400 },
  "service.failed": { kind: "service.failed", name: "redis", reason: "The health check timed out after 60 s." },
  "diff.comments_sent": { kind: "diff.comments_sent", commentIds: [ids.diffComment], count: 1 },
  "ticket.closed": { kind: "ticket.closed", status: "Done", category: "done" },
  "pr.comment_received": {
    kind: "pr.comment_received",
    url: "https://github.com/ostra-test/test1/pull/1#discussion_r1",
    login: "ostra-test-member",
    path: "src/add.ts",
    line: 12,
  },
  // Minor 3 (milestone 4).
  "memory.used": { kind: "memory.used", noteIds: [ids.note, ids.alwaysNote], via: "index" },
  "memory.proposed": { kind: "memory.proposed", proposalId: ids.proposal, title: "Run the tests with pnpm test" },
  "turn.held": { kind: "turn.held", origin: "message", budgetId: ids.budget, scope: "project" },
  "turn.released": { kind: "turn.released", budgetId: ids.budget },
  "review.check_updated": {
    kind: "review.check_updated",
    repoId: ids.repo,
    prNumber: 7,
    headSha: fixtureDigests.headSha,
    status: "passed",
    approverMemberId: ids.otherMember,
    reason: "Approved by a member who isn't the task's driver",
  },
  "pr.related_updated": {
    kind: "pr.related_updated",
    repoId: ids.repo,
    prNumber: 7,
    related: [{ repoId: ids.secondRepo, prNumber: 3 }],
  },
  "effort.changed": { kind: "effort.changed", from: "default", to: "high", memberId: ids.member },
  // Minor 4 (milestone 5).
  "box.waiting": { kind: "box.waiting", boxId: ids.box, reason: "node", since: 1_700_000_000_000 },
  "box.scheduled": { kind: "box.scheduled", boxId: ids.box, afterMs: 40_000 },
  "task.cancelled": { kind: "task.cancelled", memberId: ids.member },
  "runner.drained": { kind: "runner.drained", memberId: ids.member },
  "runner.resumed": { kind: "runner.resumed", memberId: ids.member },
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

/**
 * Minor 2's optional fields, present: the events whose shape grew in minor 2, with every new
 * field set. `eventFixtures` holds the same kinds without them, as a minor-1 peer sends them.
 */
export const minor2FieldFixtures = {
  "user.message": {
    kind: "user.message",
    memberId: ids.member,
    clientMessageId: ids.clientMessage,
    text: "Please look at the comments below.",
    delivery: "queued",
    intent: "diff-comments",
  },
  "turn.started": { kind: "turn.started", turnId: ids.turn, mode: "plan" },
  "approval.requested": {
    kind: "approval.requested",
    turnId: ids.turn,
    approvalId: ids.approval,
    toolCallId: ids.toolCall,
    options: [
      { optionId: ids.option, label: "Allow once", kind: "allow-once", decision: "allow_once" },
      { optionId: optionIdSchema.parse("reject-once"), label: "Deny", kind: "reject-once", decision: "deny" },
    ],
    rule: { source: "profile", ruleId: ids.profileRule, name: "Adding a dependency" },
    subject: { kind: "command", value: "pnpm add zod" },
  },
  "approval.requested, asked by the agent": {
    kind: "approval.requested",
    turnId: ids.turn,
    approvalId: ids.approval,
    toolCallId: ids.toolCall,
    options: [{ optionId: ids.option, label: "Allow once", kind: "allow-once", decision: "allow_once" }],
    rule: null,
    subject: { kind: "path", value: "package.json" },
  },
  "approval.answered, for this task": {
    kind: "approval.answered",
    approvalId: ids.approval,
    optionId: ids.option,
    decision: "allow_task",
    memberId: ids.member,
    taskRule: { ruleId: ids.taskRule, tool: "execute", pattern: "pnpm add" },
  },
  "approval.answered, denied with a reason": {
    kind: "approval.answered",
    approvalId: ids.approval,
    optionId: optionIdSchema.parse("reject-once"),
    decision: "deny",
    memberId: ids.member,
    reason: "Use the date-fns we already have.",
    taskRule: null,
  },
  "session.saved": {
    kind: "session.saved",
    turnOrdinal: 1,
    repos: [
      { repoId: ids.repo, headSha: fixtureDigests.headSha, ahead: true, hiddenRefSha: fixtureDigests.hiddenRefSha },
    ],
    archive: { blobId: ids.blob, size: 48_213, sha256: fixtureDigests.sha256 },
    checks: [{ checkId: ids.check, status: "failed" }],
  },
  "session.restored": {
    kind: "session.restored",
    origin: "rebuilt",
    replayedUpdates: 0,
    hiddenRef: "applied",
    previousBox: "released",
    fallbackReason: "the archive didn't match its digest",
  },
  "ticket.files_ready": {
    kind: "ticket.files_ready",
    files: [{ path: "0196f1a0-0000-7000-8000-000000000011.png", blobId: ids.ticketFileBlob }],
    skipped: [{ blobId: ids.blob, reason: "download-failed" }],
  },
  "environment.setup_finished, from a warm cache": { kind: "environment.setup_finished", exitCode: 0, durationMs: 800, dependencyCache: "warm" },
  "environment.setup_finished, without the snapshot": { kind: "environment.setup_finished", exitCode: 0, durationMs: 41_000, snapshot: "fell-back" },
  "plan.answered, approved with edits": {
    kind: "plan.answered",
    decision: "approve",
    text: "1. Add CONTRIBUTING.md\n\nKeep it short.",
    memberId: ids.member,
    entries: [{ content: "Add CONTRIBUTING.md", priority: "high", status: "pending" }],
    message: "Keep it short.",
  },
} as const satisfies Readonly<Record<string, TaskEvent>>;

const commandEnvelope = { type: "command", id: ids.command, notAfter: 1_900_000_000_000 } as const;

/** One valid example of every command kind. A missing kind is a type error. */
export const commandFixtures: { readonly [K in CommandKind]: Extract<Command, { kind: K }> } = {
  dispatch: {
    ...commandEnvelope,
    seq: 1,
    kind: "dispatch",
    body: { taskId: ids.task, sessionId: ids.session, boxId: ids.box, leaseEpoch: 1 },
  },
  steer: {
    ...commandEnvelope,
    seq: 2,
    kind: "steer",
    body: { sessionId: ids.session, clientMessageId: ids.clientMessage, text: "also add a test", delivery: "queue" },
  },
  interrupt: { ...commandEnvelope, seq: 3, kind: "interrupt", body: { sessionId: ids.session } },
  stop: {
    ...commandEnvelope,
    seq: 4,
    kind: "stop",
    body: { taskId: ids.task, sessionId: ids.session, leaseEpoch: 1, reason: "requested" },
  },
  "approval-answer": {
    ...commandEnvelope,
    seq: 5,
    kind: "approval-answer",
    body: { sessionId: ids.session, approvalId: ids.approval, decision: "allow_once" },
  },
  drain: { ...commandEnvelope, seq: 6, kind: "drain", body: {} },
  "update-hint": { ...commandEnvelope, seq: 7, kind: "update-hint", body: { version: "0.2.0" } },
  release: { ...commandEnvelope, seq: 8, kind: "release", body: { taskId: ids.task, boxId: ids.box, reason: "prs-closed" } },
  // Minor 2 (milestone 3).
  "question-answer": {
    ...commandEnvelope,
    seq: 9,
    kind: "question-answer",
    body: { sessionId: ids.session, questionId: ids.question, answers: { runner: "vitest" } },
  },
  "plan-answer": {
    ...commandEnvelope,
    seq: 10,
    kind: "plan-answer",
    body: { sessionId: ids.session, decision: "approve", text: "1. Add CONTRIBUTING.md" },
  },
  "snapshot-build": {
    ...commandEnvelope,
    seq: 11,
    kind: "snapshot-build",
    body: {
      snapshotId: ids.snapshot,
      projectId: ids.project,
      environment: {
        baseImage: null,
        setupScript: "pnpm install",
        repos: [
          {
            repoId: ids.repo,
            fullName: "ostra-test/test1",
            cloneUrl: "https://github.com/ostra-test/test1.git",
            defaultBranch: "main",
            checkoutDir: "test1",
            variables: [{ name: "NODE_ENV", value: "test", availableDuringSetup: true }],
            files: [],
            envFile: ".env",
            setupSecrets: { variables: ["NPM_TOKEN"], files: [] },
          },
        ],
        inputsHash: fixtureDigests.sha256,
      },
    },
  },
  // Minor 3 (milestone 4).
  "set-effort": {
    ...commandEnvelope,
    seq: 15,
    kind: "set-effort",
    body: { sessionId: ids.session, level: "high", changeId: ids.effortChange },
  },
  // Minor 4 (milestone 5).
  resume: { ...commandEnvelope, seq: 20, kind: "resume", body: {} },
};

/** Minor 2's optional command fields, present. */
export const minor2CommandFixtures = {
  "steer, from diff comments": {
    ...commandEnvelope,
    seq: 12,
    kind: "steer",
    body: {
      sessionId: ids.session,
      clientMessageId: ids.clientMessage,
      text: "Please look at the comments below.",
      delivery: "queue",
      intent: "diff-comments",
    },
  },
  "approval-answer, for this task": {
    ...commandEnvelope,
    seq: 13,
    kind: "approval-answer",
    body: { sessionId: ids.session, approvalId: ids.approval, decision: "allow_task", taskRule: taskRuleFixture },
  },
  "approval-answer, denied with a reason": {
    ...commandEnvelope,
    seq: 14,
    kind: "approval-answer",
    body: { sessionId: ids.session, approvalId: ids.approval, decision: "deny", reason: "Use date-fns instead." },
  },
} as const satisfies Readonly<Record<string, Command>>;

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

/** A plan-first task's first session at minor 2: every minor-2 field set. */
export const taskSpecMinor2Fixture: TaskSpec = {
  ...taskSpecMinor1Fixture,
  agent: {
    ...taskSpecFixture.agent,
    skills: [
      { name: "release-notes", blobId: ids.skillBlob, files: [{ path: "templates/notes.md", blobId: ids.skillFileBlob }] },
    ],
    mcpServers: [
      { name: "linear", transport: "http", proxyPath: "/mcp/linear", readOnly: true },
      { name: "files", transport: "stdio", command: "mcp-files", args: ["--root", "."], env: { LOG_LEVEL: "warn" }, readOnly: false },
    ],
    approvalRules: [approvalRuleFixtures.dependencyFiles, approvalRuleFixtures.dependencyCommands, approvalRuleFixtures.mcp],
    taskRules: [taskRuleFixture],
    planFirst: true,
  },
  firstTurnMode: "plan",
  checks: [
    { checkId: ids.check, name: "Tests", command: "pnpm test", repoId: ids.repo, timeoutSeconds: 600 },
    { checkId: checkIdSchema.parse("check-lint"), name: "Lint", command: "pnpm lint", repoId: null, timeoutSeconds: 300 },
  ],
  services: [
    {
      name: "postgres",
      image: "postgres:17",
      port: 5432,
      variables: [{ name: "POSTGRES_PASSWORD", value: "postgres" }],
      healthCheck: "pg_isready -U postgres",
    },
  ],
  snapshot: {
    kind: "image",
    snapshotId: ids.snapshot,
    imageRef: "ostra-snapshot/0196f1a0:17",
    digest: fixtureDigests.imageDigest,
  },
  checksTotalMinutes: 30,
};

/** Task credentials at minor 2, with an HTTP MCP server's address and secret header. Every value is fake. */
export const taskCredentialsMinor2Fixture: TaskCredentials = taskCredentialsSchema.parse({
  ...taskCredentialsFixture,
  mcpServers: [
    { name: "linear", url: "https://mcp.linear.app/mcp", headers: { authorization: "Bearer fixture-mcp-secret" } },
  ],
});

/** A snapshot build's credentials. Every value is fake. */
export const snapshotCredentialsFixture: SnapshotCredentials = snapshotCredentialsSchema.parse({
  snapshotId: ids.snapshot,
  repos: [{ repoId: ids.repo, gitToken: "fixture-git-token", expiresAt: 1_900_000_000_000 }],
  secrets: [
    {
      repoId: ids.repo,
      entries: [{ kind: "variable", name: "NPM_TOKEN", value: "fixture-npm-token", availableDuringSetup: true }],
    },
  ],
});

// ---------- minor 3 (milestone 4) ----------

/** A spec at minor 3: memory with tools, the closing turn on, and two repos with their own bots. */
export const taskSpecMinor3Fixture: TaskSpec = {
  ...taskSpecMinor2Fixture,
  repos: [
    {
      repoId: ids.repo,
      fullName: "ostra-test/test1",
      cloneUrl: "https://github.com/ostra-test/test1.git",
      defaultBranch: "main",
      checkoutDir: "test1",
      lfsActionHosts: ["github-cloud.githubusercontent.com"],
      prTemplate: null,
      gitIdentity: taskSpecFixture.gitIdentity,
    },
    {
      repoId: ids.secondRepo,
      fullName: "client-org/api",
      cloneUrl: "https://github.com/client-org/api.git",
      defaultBranch: "main",
      checkoutDir: "api",
      lfsActionHosts: [],
      prTemplate: null,
      gitIdentity: { name: "client-app[bot]", email: "9911+client-app[bot]@users.noreply.github.com" },
    },
  ],
  agent: { ...taskSpecMinor2Fixture.agent, closingTurn: true },
  memory: {
    block: "## Project memory\n\nThese are the organization's and the project's approved notes.",
    indexNoteIds: [ids.note],
    alwaysNoteIds: [ids.alwaysNote],
    omitted: 2,
    tools: true,
  },
};

/** An approved note, as `memory_read` returns it. */
export const memoryNoteFixture: MemoryNote = {
  noteId: ids.note,
  title: "Run the tests with pnpm test",
  body: "Use `pnpm test` at the repo root; `npm test` skips the workspace packages.",
  kind: "command",
  scope: "project",
  version: 3,
};

/** One line of the index. */
export const memoryIndexEntryFixture: MemoryIndexEntry = {
  noteId: ids.note,
  title: "Run the tests with pnpm test",
  kind: "command",
  scope: "project",
};

/** A proposal that contradicts a note. */
export const memoryProposalInputFixture: MemoryProposalInput = {
  title: "Tests run with vitest directly",
  body: "`pnpm test` now runs `vitest run`; the old script is gone.",
  kind: "command",
  scope: "project",
  relatesTo: ids.note,
  relation: "contradicts",
};

/** The sidecar's memory endpoints, a request and an answer each (F-110, F-111). */
export const memoryHttpFixtures = {
  searchRequest: { query: "how do I run the tests", limit: 5 } satisfies MemorySearchRequest,
  searchResponse: {
    results: [{ noteId: ids.note, title: "Run the tests with pnpm test", line: "Use `pnpm test` at the repo root", kind: "command", scope: "project" }],
  } satisfies MemorySearchResponse,
  noteResponse: memoryNoteFixture satisfies MemoryNoteResponse,
  proposalRequest: memoryProposalInputFixture satisfies MemoryProposalRequest,
  proposalAccepted: { proposalId: ids.proposal } satisfies MemoryProposalResponse,
} as const;

/** Each refusal of a proposal. */
export const memoryProposalRefusalFixtures = {
  "secret-found": { code: "secret-found", found: ["a GitHub token", "a model-control token"] },
  "limit-reached": { code: "limit-reached" },
  invalid: { code: "invalid" },
} as const satisfies { readonly [K in MemoryProposalRefusal["code"]]: Extract<MemoryProposalRefusal, { code: K }> };

// ---------- reasoning effort (F-137, ADR 0066) ----------

/** Reasoning controls as the catalog lists them (research `opencode-reasoning-effort.md`, section 2.2). */
export const reasoningControlsFixtures = {
  none: { supported: false },
  noControl: { supported: true },
  toggle: { supported: true, toggle: true },
  budget: { supported: true, budget: { min: 1_024 } },
  /** `anthropic/claude-sonnet-5`. */
  toggleAndEffort: { supported: true, toggle: true, effort: ["low", "medium", "high", "xhigh", "max"] },
  /** `openai/gpt-5.5`. */
  effort: { supported: true, effort: ["none", "low", "medium", "high", "xhigh"] },
  /** `openai/gpt-5.2-pro`. */
  effortNoLow: { supported: true, effort: ["medium", "high", "xhigh"] },
} as const satisfies Readonly<Record<string, ReasoningControls>>;

/** The events whose shape grew in minor 3, with every new field set. */
export const minor3FieldFixtures = {
  "turn.started": {
    kind: "turn.started",
    turnId: ids.turn,
    mode: "build",
    effort: "high",
    adjustedFrom: "medium",
  },
  "usage.recorded": {
    kind: "usage.recorded",
    providerId: ids.provider,
    modelId: ids.model,
    inputTokens: 1_200,
    outputTokens: 800,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
    reasoningTokens: 500,
  },
} as const satisfies Readonly<Record<string, TaskEvent>>;

/** A level a task runs at, other than `default`, so the spec needs minor 3. */
export const effortFixtureLevel: EffortLevel = "high";

/** A spec at minor 3 with a reasoning level, the model's controls and its real limits. */
export const taskSpecEffortFixture: TaskSpec = {
  ...taskSpecMinor2Fixture,
  agent: {
    ...taskSpecMinor2Fixture.agent,
    effort: effortFixtureLevel,
    reasoning: reasoningControlsFixtures.effortNoLow,
    limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  },
};

// ---------- minor 4 (milestone 5) ----------

/** A snapshot image in the fixture registry, by digest. */
export const fixtureImage = {
  ref: `registry.ostra-test.dev/ostra-dev/${ids.project}:${ids.snapshot}`,
  digest: `sha256:${"b".repeat(64)}`,
} as const;

/** Minor 4's optional command fields, present. */
export const minor4CommandFixtures = {
  "dispatch, with a size and an image": {
    ...commandEnvelope,
    seq: 16,
    kind: "dispatch",
    body: {
      taskId: ids.task,
      sessionId: ids.session,
      boxId: ids.box,
      leaseEpoch: 1,
      box: { size: { name: "small", cpuMillis: 2000, memoryMiB: 4096 }, image: fixtureImage },
    },
  },
  "dispatch, slots only": {
    ...commandEnvelope,
    seq: 17,
    kind: "dispatch",
    body: { taskId: ids.task, sessionId: ids.session, boxId: ids.box, leaseEpoch: 1, box: { size: null, image: null } },
  },
  "snapshot-build, pushed by BuildKit": {
    ...commandFixtures["snapshot-build"],
    seq: 18,
    body: { ...commandFixtures["snapshot-build"].body, push: { ref: fixtureImage.ref }, builder: "buildkit" },
  },
  "snapshot-build, kept by Docker": {
    ...commandFixtures["snapshot-build"],
    seq: 19,
    body: { ...commandFixtures["snapshot-build"].body, push: null, builder: "docker" },
  },
} as const satisfies Readonly<Record<string, Command>>;

/** A `kubernetes` runner's capabilities, as its executor declares them (ADR 0060). */
export const kubernetesCapabilitiesFixture: RunnerCapabilities = {
  isolation: "container",
  services: true,
  boxSizes: true,
  snapshots: "image",
  registry: "required",
  nodeWait: true,
};

/** A `kubernetes` pool runner's status at minor 4, with every new field. */
export const minor4StatusFixture: Status = {
  type: "status",
  executor: "kubernetes",
  capacity: 20,
  freeSlots: 19,
  labels: ["tier:fast", "executor:kubernetes", "os:linux", "arch:x64", "gpu"],
  version: "0.5.0",
  running: [ids.session],
  spoolBytes: 0,
  processContainment: "container",
  resources: { slots: 20, cpuMillis: 30_000, memoryMiB: 61_440 },
  capabilities: kubernetesCapabilitiesFixture,
  install: "image",
};

/** A `host` runner's status at minor 4: no resources, since `host` counts slots. */
export const minor4HostStatusFixture: Status = {
  type: "status",
  executor: "host",
  capacity: 2,
  freeSlots: 2,
  labels: [],
  version: "0.5.0",
  running: [],
  spoolBytes: 0,
  processContainment: "job-object",
  resources: null,
  capabilities: { isolation: "none", services: false, boxSizes: false, snapshots: "host-cache", registry: "none", nodeWait: false },
  install: "npm",
};

/** A `kubernetes` runner's `hello` at minor 4. */
export const minor4HelloFixture: Hello = {
  type: "hello",
  protocolMajor: 1,
  protocolMinor: 4,
  runnerVersion: "0.5.0",
  peer: { kind: "runner", runnerId: ids.runner },
  carrier: "http",
  lastCommandSeq: 0,
  sessions: [],
  executor: "kubernetes",
  resources: { slots: 20, cpuMillis: 30_000, memoryMiB: 61_440 },
  capabilities: kubernetesCapabilitiesFixture,
  install: "image",
};

/** The runner endpoints minor 4 adds and grows, a request and an answer each. */
export const minor4HttpFixtures = {
  info: {
    protocolMajor: 1,
    serverMinor: 4,
    supported: { min: 3, max: 5 },
    serverVersion: "0.5.0",
    panelUrl: "https://ostra.example.test",
    deviceClientId: "ostra-runner",
    minorWindow: { min: 3, max: 5 },
    npm: { package: "ostra", registry: "https://registry.npmjs.org" },
  } satisfies InfoResponse,
  pullCredentialRequest: { leaseEpoch: 1 } satisfies PullCredentialRequest,
  pushCredentialRequest: {} satisfies PushCredentialRequest,
  credential: {
    registry: "registry.ostra-test.dev",
    username: "fixture-user",
    token: "fixture-registry-token-not-real",
    expiresAt: 1_900_000_000_000,
  } satisfies RegistryCredential,
  superseded: { code: "superseded" } satisfies HttpSuperseded,
} as const;

/** Each refusal of a registry credential. */
export const registryCredentialRefusalFixtures = {
  "no-image": { error: { code: "no-image", message: "this lease's dispatch named no registry image" } },
  "not-the-builder": { error: { code: "not-the-builder", message: "this snapshot's build went to another runner" } },
  "stale-lease": { error: { code: "stale-lease", message: "the lease epoch is not the task's current one", currentEpoch: 2 } },
} as const satisfies {
  readonly [K in RegistryCredentialRefusal["error"]["code"]]: RegistryCredentialRefusal & { readonly error: { readonly code: K } };
};
