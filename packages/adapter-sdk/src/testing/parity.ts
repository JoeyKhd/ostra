import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentCapabilities } from "../agent/capabilities.ts";

// Adapter parity (milestone 7, ticket 03; spec section 6; AGENTS.md, "Adapter parity"): every
// feature that touches agents, and for each shipped agent adapter and each scripted fake, the case
// that proves it on that adapter, or the capability the adapter lacks and the fallback case that
// proves the way around it. `checkParity` fails when an adapter has no entry for a row, when a
// case it names doesn't exist, when it names a fallback for a capability it declares, or when a
// capability it declares (or lacks) has no case among its entries that runs that way. A new
// feature that touches agents adds its row here, and a new agent its entry; a new capability adds
// its line to `capabilityCases`, which the compiler asks for.

/** A test by its file (from the repo's root) and its exact title. */
export type ParityCase = { readonly file: string; readonly title: string };

/**
 * How a feature is proved on one adapter: by cases that run on it; by the fallback cases for a
 * capability it lacks; or not yet, waiting for the ticket named (a feature still being built).
 */
export type ParityProof =
  | { readonly kind: "cases"; readonly cases: readonly ParityCase[] }
  | { readonly kind: "fallback"; readonly capability: keyof AgentCapabilities; readonly cases: readonly ParityCase[] }
  | { readonly kind: "waits"; readonly on: string };

/** Spec section 6's rows, and the launch row the milestone-7 cases add. */
export const parityFeatures = [
  "F-023 Live activity",
  "F-025 Stop",
  "F-089 Key proxy",
  "F-090 Git proxy",
  "F-016, F-098 Workspace, several repos",
  "F-030 Open the PR",
  "F-078 Repo conventions",
  "F-064 Ticket context",
  "F-032, F-033, F-096 Reopen anywhere",
  "F-047 Agent crashes",
  "F-021 Agent profiles",
  "F-024 Steer",
  "F-026 Approvals",
  "F-063 Plan first",
  "F-062 Questions",
  "F-084, F-037 Usage, budgets",
  "F-070, F-053, F-054, F-035, F-105 A new turn with a prompt",
  "F-068 Runaway protection",
  "F-110, F-111 Memory",
  "F-014, F-015, F-093 Runners, pools, kubernetes",
  "F-039 Three images",
  "F-116 Egress baseline",
  "F-099, F-100 Refine, review",
  "F-012 Start from Linear",
  "F-101 Automatic turns",
  "F-113 Onboarding",
  "F-019 The agent's launch",
] as const;
export type ParityFeature = (typeof parityFeatures)[number];

const SUITE = "packages/adapter-sdk/src/testing";
const suite = (file: string, title: string): ParityCase => ({ file: `${SUITE}/${file}`, title });

/** The agent contract suite's cases, by what they show: each runs on every adapter whose fixture has its probe. */
export const suiteCases = {
  turn: suite("agent-suite.ts", "F-023: a turn runs to end_turn, bracketed by turn.started and turn.ended, with the agent's message"),
  tools: suite("agent-suite.ts", "F-023: tool calls render by ACP kind, and a failing one is reported"),
  plan: suite("agent-suite.ts", "F-019: a plan reaches ostra as plan.updated when the agent declares nativePlan"),
  unknownUpdate: suite("agent-suite.ts", "ADR 0018: an unknown update becomes agent.unknown, and nothing around it is dropped"),
  cancel: suite("agent-suite.ts", "F-023: a cancel ends the turn with cancelled, in under 5 s"),
  leftover: suite("agent-suite.ts", "F-023: a cancel leaves no process of the agent's behind"),
  noCredential: suite("agent-suite.ts", "ADR 0030: launches with an allowlisted environment that holds no credential"),
  endpoint: suite("agent-suite.ts", "ADR 0030: the model base URL and the fake key are what reach the agent"),
  deny: suite("agent-suite.ts", "ADR 0032: a deny is followed by the runner's re-prompt, or by the agent carrying on when it declares rejectAndContinue"),
  question: suite("agent-suite.ts", "F-019: a question reaches ostra through elicitation.form, and the answer reaches the agent"),
  steerGuard: suite("agent-suite.ts", "ADR 0032: steering is used only when the adapter declares steerMidTurn and the agent advertised it"),
  steer: suite("agent-suite.ts", "ADR 0032: a steer during a turn reaches the agent, when steering is declared"),
  archive: suite("agent-suite.ts", "ADR 0039: exports a session, imports it into a fresh box's workspace, and loads it there with its history"),
  noLoad: suite("agent-suite.ts", "refuses to resume a session when it doesn't declare sessionLoad"),
  // Subagents (2026-11-20).
  subagentsWait: suite("agent-suite.ts", "F-023: a subagent that outlives its agent's prompt holds the turn until it reports and the agent answers, with subagents background"),
  subagentsNone: suite("agent-suite.ts", "F-023: an agent without background subagents ends its turn with its prompt's answer"),
  subagentsCancel: suite("agent-suite.ts", "F-025: a cancel while a subagent runs stops it with the turn, in under 5 s, and nothing of theirs comes after"),
  // F-138 (milestone 7, ticket 39).
  subagentsOwn: suite("agent-suite.ts", "F-138: a subagent's start, its state, its calls and its answer are named as its own, with subagents background"),
  subagentsFlat: suite("agent-suite.ts", "F-138: an agent without background subagents names no subagent: every call and message is its own"),
  ruleAsks: suite("agent-profile-cases.ts", "F-026: a request a rule covers asks a member, named by its subject; one no rule covers goes on without one"),
  taskRule: suite("agent-profile-cases.ts", "F-026: a task rule answers a matching request without a member, and only a matching one"),
  denyReason: suite("agent-profile-cases.ts", "F-026: a deny with a reason ends the request, and the re-prompt carries the reason as data"),
  planTurn: suite("agent-profile-cases.ts", "F-063: a plan turn changes no file: its write is refused, and only a read-only MCP server's tool runs"),
  buildMode: suite("agent-profile-cases.ts", "F-063: the session switches to build mode by its plan mode, and then works"),
  noPlanMode: suite("agent-profile-cases.ts", "F-063: an agent without a plan mode refuses to switch, and nothing is relaunched"),
  skillsMcp: suite("agent-profile-cases.ts", "F-021: the profile's skills and MCP servers reach the agent, each by the way it declares"),
  repoAllowsAll: suite("agent-profile-cases.ts", "F-021: a repo config that allows everything changes nothing: the rule still asks"),
  nextTurn: suite("agent-profile-cases.ts", "F-024: a message the agent can't take mid-turn waits, and reaches it as the next turn"),
  memoryBlock: suite("agent-memory-cases.ts", "F-110: the memory block reaches the agent with the profile's instructions, in its config folder and in no repo"),
  memoryTools: suite("agent-memory-cases.ts", "F-110: an agent with MCP is offered memory_search, memory_read and memory_propose, and each call round-trips through the fake core"),
  memoryIndex: suite("agent-memory-cases.ts", "F-110: an agent without MCP gets the index and no tools"),
  twoRepos: suite("agent-memory-cases.ts", "F-098: two repos side by side, the agent at the workspace's root, its instructions naming both"),
  effortLevels: suite("agent-effort-cases.ts", "F-137: setEffort sends each level the agent advertises, and each reaches the next request; default sends nothing"),
  noEffort: suite("agent-effort-cases.ts", "F-137: an agent that takes no level advertises none, and setEffort leaves it at default"),
  // Milestone 7 (ticket 03).
  unknownNotification: suite("agent-parity-cases.ts", "ADR 0018: a notification no client knows, sent after initialize, is tolerated: the session starts and its turn runs"),
  envAllowlist: suite("agent-parity-cases.ts", "ADR 0030: the launch's environment is exactly the adapter's allowlist, and no variable outside it reaches the process"),
  everyCall: suite("agent-parity-cases.ts", "F-089: every model call of a turn reaches the key proxy with the task's key, and nothing goes anywhere else"),
  usageMatch: suite("agent-parity-cases.ts", "F-089: the key proxy's count equals the agent's own reported usage for the calls it closed, within 2%"),
  repoConfigHidden: suite("agent-parity-cases.ts", "F-021: a repo's agent config in repoConfigPaths is hidden for the task, its hook never runs, and it comes back byte for byte"),
  allowForTask: suite("agent-parity-cases.ts", "F-026: allow for this task holds for the rest of the task, across a relaunch, and nothing of it reaches the commit"),
  slash: suite("agent-parity-cases.ts", "F-019: a ticket whose text starts with / is never run as a slash command: ostra's prompt never starts with ticket text"),
  checksum: suite("agent-parity-cases.ts", "F-019: an agent binary whose checksum doesn't match its pin refuses the launch"),
  // Milestone 6 (ticket 04).
  neutralReply: suite("agent-team-cases.ts", "F-101: in an automatic turn, the agent's question gets the fixed neutral reply, and the agent carries on"),
  declinedControl: suite("agent-team-cases.ts", "F-101: the control: the same question declined ends the turn cancelled, as OpenCode's did in spike 10"),
  readOnlyPush: suite("agent-team-cases.ts", "F-099: a read-only task's push is refused by its fetch-only remote, and nothing reaches the upstream"),
  reviewHeads: suite("agent-team-cases.ts", "F-100: a review task's repos are checked out at the given heads, one per repo"),
  toolsByKind: suite("agent-team-cases.ts", "F-099: ostra's tools are listed for the task kinds that have them, and absent for the others"),
  submitDraft: suite("agent-team-cases.ts", "F-099: the drafting agent's submit_draft reaches core as a draft, and a refusal reaches the agent in the protocol's words"),
  submitReview: suite("agent-team-cases.ts", "F-100: the reviewing agent's submit_review reaches core with its findings by repo ID, and not-in-review reaches the agent"),
  proposeEnvironment: suite("agent-team-cases.ts", "F-113: the proposing agent's propose_environment reaches core, and a secret found reaches the agent by kind, never by value"),
  commitPaths: suite("agent-team-cases.ts", "F-113: after a turn, a commit with commitPaths keeps only those; the agent's other changes stay uncommitted"),
} as const satisfies Record<string, ParityCase>;

/**
 * Tests outside the suite that hold for every agent the same way: the runner's and core's parts
 * of a feature (the git proxy, the sidecar's MCP tools, the runner's limits), which no adapter
 * changes. Each runs on the scripted fake agent, which drives the runner as any agent does.
 */
export const sharedCases = {
  gitProxy: { file: "apps/runner/src/task-host/task-host.test.ts", title: "F-090/c1,c2: the agent's own git clones, fetches and pushes through the proxy, which adds the repo's token; its push to main is refused" },
  crash: { file: "apps/runner/src/task-host/task-host.test.ts", title: "F-047/c1: a run whose agent crashes frees the runner's one slot, and the next dispatch is accepted and starts" },
  prText: { file: "apps/runner/src/sidecar/mcp-tools.test.ts", title: "F-030/c4: emits pr.text_set for a call naming one of the task's repos" },
  prTool: { file: "apps/runner/src/sidecar/mcp-tools.test.ts", title: "F-030/c4, F-078/c1: lists the tool, whose description carries the repo's PR template and the title rule" },
  trailer: { file: "packages/adapters/adapter-executor-host/src/host-executor.test.ts", title: "F-078/c2: puts the trailer on the agent's own commits too, and the bot authors them" },
  ticketFiles: { file: "apps/runner/src/task-host/ticket-files.test.ts", title: "writes images and PDFs under .ostra/ticket/ by blob and type, skips the rest, and starts the turn" },
  rebuild: { file: "apps/core/src/dispatch/reopen.test.ts", title: "rebuilds from the template when the archive is gone, or the runner can't restore" },
  spendCap: { file: "apps/runner/src/task-host/limits.test.ts", title: "ends the turn at the cap, saves its work, sends session.limit_reached once, and ends the session" },
  stall: { file: "apps/core/src/limits/limits.test.ts", title: "stops a silent session within one minute of the limit, and leaves a waiting one and a recent one alone" },
  killHard: { file: "packages/adapters/adapter-executor-host/src/host-containment.test.ts", title: "F-014/c6: a runner killed hard leaves no process of its task" },
  imagePin: {
    file: "packages/deploy-checks/src/image-checks.test.ts",
    title: "F-039/c1: the checksum comes from the repo's pin: each architecture's expected SHA-256 is pinnedChecksums', fed to sha256sum -c",
  },
  egressPlan: {
    file: "packages/adapter-sdk/src/testing/egress-probes.test.ts",
    title: "F-116/c6: the plan probes every routable range of the one list, the metadata address, the box network's gateway and another box's sidecar ports, each with its control",
  },
  openCodeQuestion: { file: "apps/runner/src/task-host/approvals.opencode.test.ts", title: "F-024: OpenCode's question is held, and the driver's answer reaches the model" },
  openCodeRepoAgents: {
    file: "packages/adapters/adapter-opencode/src/opencode-adapter.contract.test.ts",
    title: "F-021/c6: the repo's own AGENTS.md and skills reach OpenCode beside the profile's instructions and skill, with the repo's config off",
  },
  openCodeRepoSkills: {
    file: "packages/adapters/adapter-opencode/src/opencode-adapter.contract.test.ts",
    title: "F-021/c5,c8: a repo's skills in .agents, .claude and .opencode all reach OpenCode, the profile's skill wins over the repo's of its name, and the repo's opencode.json is still never read",
  },
  openCodeRepoSkillsOff: {
    file: "packages/adapters/adapter-opencode/src/opencode-adapter.contract.test.ts",
    title: "F-021/c9: with the project's repo skills off, OpenCode lists none of the repo's skills, in any of the three folders, and keeps the profile's",
  },
} as const satisfies Record<string, ParityCase>;

/**
 * The cases that run one way or the other of each capability: `on` when the adapter declares it
 * (`true`, `native`, `session-mode`, MCP over either transport, `mcp` memory, a reasoning control),
 * `off` when it doesn't, which is its fallback. An adapter's entries must name one of the cases
 * for the way it declares.
 */
export const capabilityCases: Readonly<Record<keyof AgentCapabilities, { readonly on: readonly ParityCase[]; readonly off: readonly ParityCase[] }>> = {
  steerMidTurn: { on: [suiteCases.steer], off: [suiteCases.steerGuard, suiteCases.nextTurn] },
  sessionLoad: { on: [suiteCases.archive], off: [suiteCases.noLoad] },
  nativePlan: { on: [suiteCases.plan], off: [suiteCases.plan] },
  rejectAndContinue: { on: [suiteCases.deny], off: [suiteCases.deny, suiteCases.denyReason] },
  elicitationForm: { on: [suiteCases.question, sharedCases.openCodeQuestion], off: [] },
  modelBaseUrlAndPlaceholderKey: { on: [suiteCases.everyCall, suiteCases.endpoint], off: [] },
  sessionArchive: { on: [suiteCases.archive], off: [sharedCases.rebuild] },
  permissionRules: { on: [suiteCases.ruleAsks], off: [suiteCases.ruleAsks] },
  planMode: { on: [suiteCases.buildMode], off: [suiteCases.buildMode, suiteCases.noPlanMode] },
  skills: { on: [suiteCases.skillsMcp], off: [suiteCases.skillsMcp] },
  mcp: { on: [suiteCases.skillsMcp], off: [suiteCases.skillsMcp] },
  projectConfigOverride: { on: [suiteCases.repoAllowsAll], off: [suiteCases.repoConfigHidden] },
  memory: { on: [suiteCases.memoryTools], off: [suiteCases.memoryIndex] },
  reasoningEffort: { on: [suiteCases.effortLevels], off: [suiteCases.noEffort] },
  subagents: { on: [suiteCases.subagentsWait, suiteCases.subagentsCancel, suiteCases.subagentsOwn], off: [suiteCases.subagentsNone, suiteCases.subagentsFlat] },
};

/** Whether an adapter declares a capability, read the way `capabilityCases` splits it. */
export const declares = (capabilities: AgentCapabilities, capability: keyof AgentCapabilities): boolean => {
  switch (capability) {
    case "permissionRules":
      return capabilities.permissionRules === "native";
    case "planMode":
      return capabilities.planMode === "session-mode";
    case "mcp":
      return capabilities.mcp.http || capabilities.mcp.stdio;
    case "memory":
      return capabilities.memory === "mcp";
    case "reasoningEffort":
      return capabilities.reasoningEffort !== "none";
    case "subagents":
      return capabilities.subagents === "background";
    case "steerMidTurn":
    case "sessionLoad":
    case "nativePlan":
    case "rejectAndContinue":
    case "elicitationForm":
    case "modelBaseUrlAndPlaceholderKey":
    case "sessionArchive":
    case "skills":
    case "projectConfigOverride":
      return capabilities[capability];
    default:
      return capability satisfies never;
  }
};

const cases = (...list: readonly ParityCase[]): ParityProof => ({ kind: "cases", cases: list });
const fallback = (capability: keyof AgentCapabilities, ...list: readonly ParityCase[]): ParityProof => ({ kind: "fallback", capability, cases: list });
const waits = (on: string): ParityProof => ({ kind: "waits", on });

/**
 * Milestone 6's rows on an agent with ostra's tools over MCP: every team case runs on it. The
 * scripted fakes since ticket 04; OpenCode since ticket 09, played by the stub model on its pinned
 * binary. Agent mode waits for tickets 13 and 38.
 */
const milestone6WithTools = {
  "F-099, F-100 Refine, review": cases(suiteCases.readOnlyPush, suiteCases.reviewHeads, suiteCases.toolsByKind, suiteCases.submitDraft, suiteCases.submitReview),
  "F-012 Start from Linear": waits("milestone 6, tickets 13 and 38: the agent-mode case"),
  "F-101 Automatic turns": cases(suiteCases.neutralReply, suiteCases.declinedControl),
  "F-113 Onboarding": cases(suiteCases.proposeEnvironment, suiteCases.commitPaths),
} as const;

/**
 * Milestone 6's rows on the fake without MCP: ostra's tools need it, so the tools cases skip, and
 * what holds without it is the read-only remote, the review's checkout and the commit's paths.
 */
const milestone6IndexOnly = {
  ...milestone6WithTools,
  "F-099, F-100 Refine, review": fallback("memory", suiteCases.readOnlyPush, suiteCases.reviewHeads),
  "F-113 Onboarding": fallback("memory", suiteCases.commitPaths),
} as const;

/** What every adapter shares: the runner's and core's parts, and the suite's cases every fixture runs. */
const common = {
  "F-090 Git proxy": cases(sharedCases.gitProxy),
  "F-030 Open the PR": cases(sharedCases.prText, sharedCases.prTool),
  "F-064 Ticket context": cases(sharedCases.ticketFiles),
  "F-047 Agent crashes": cases(sharedCases.crash),
  "F-068 Runaway protection": cases(sharedCases.spendCap, sharedCases.stall),
  "F-014, F-015, F-093 Runners, pools, kubernetes": cases(sharedCases.killHard),
  "F-084, F-037 Usage, budgets": cases(suiteCases.everyCall, suiteCases.usageMatch),
  "F-070, F-053, F-054, F-035, F-105 A new turn with a prompt": cases(suiteCases.turn, suiteCases.nextTurn),
  "F-016, F-098 Workspace, several repos": cases(suiteCases.twoRepos),
  "F-116 Egress baseline": cases(sharedCases.egressPlan, suiteCases.everyCall),
} as const;

/**
 * Each shipped agent adapter and each scripted fake, by its adapter's `name`, with how it proves
 * every row. OpenCode's fixture has no probe for a deny, a question, an unknown update, its own
 * environment or a leftover process, so its rows name the cases its fixture runs, and the
 * runner's OpenCode tests for questions.
 */
export const parityTable: Readonly<Record<string, Readonly<Record<string, ParityProof>>>> = {
  opencode: {
    ...common,
    ...milestone6WithTools,
    "F-023 Live activity": cases(suiteCases.turn, suiteCases.tools, suiteCases.plan, suiteCases.subagentsWait, suiteCases.subagentsOwn),
    "F-025 Stop": cases(suiteCases.cancel, suiteCases.subagentsCancel),
    "F-089 Key proxy": cases(suiteCases.everyCall, suiteCases.usageMatch),
    "F-078 Repo conventions": cases(sharedCases.openCodeRepoAgents, sharedCases.trailer),
    "F-032, F-033, F-096 Reopen anywhere": cases(suiteCases.archive),
    // 2026-11-21: a repo's own skills, the profile's winning a clash, and the project's switch off (ADR 0049 amended).
    "F-021 Agent profiles": cases(suiteCases.skillsMcp, suiteCases.repoAllowsAll, sharedCases.openCodeRepoSkills, sharedCases.openCodeRepoSkillsOff),
    "F-024 Steer": cases(suiteCases.steer, suiteCases.nextTurn),
    "F-026 Approvals": cases(suiteCases.ruleAsks, suiteCases.taskRule, suiteCases.allowForTask, suiteCases.denyReason),
    "F-063 Plan first": cases(suiteCases.planTurn, suiteCases.buildMode),
    "F-062 Questions": cases(sharedCases.openCodeQuestion),
    "F-110, F-111 Memory": cases(suiteCases.memoryBlock, suiteCases.memoryTools),
    "F-039 Three images": cases(sharedCases.imagePin, suiteCases.checksum),
    "F-019 The agent's launch": cases(suiteCases.noCredential, suiteCases.envAllowlist, suiteCases.unknownNotification, suiteCases.slash, suiteCases.checksum, suiteCases.effortLevels),
  },
  "fake-acp-agent-rich": {
    ...common,
    ...milestone6WithTools,
    "F-023 Live activity": cases(suiteCases.turn, suiteCases.tools, suiteCases.plan, suiteCases.unknownUpdate, suiteCases.subagentsWait, suiteCases.subagentsOwn),
    "F-025 Stop": cases(suiteCases.cancel, suiteCases.leftover, suiteCases.subagentsCancel),
    "F-089 Key proxy": cases(suiteCases.everyCall, suiteCases.usageMatch, suiteCases.endpoint),
    "F-078 Repo conventions": cases(suiteCases.twoRepos, sharedCases.trailer),
    "F-032, F-033, F-096 Reopen anywhere": cases(suiteCases.archive),
    "F-021 Agent profiles": cases(suiteCases.skillsMcp, suiteCases.repoAllowsAll),
    "F-024 Steer": cases(suiteCases.steer, suiteCases.nextTurn),
    "F-026 Approvals": cases(suiteCases.ruleAsks, suiteCases.taskRule, suiteCases.allowForTask, suiteCases.deny),
    "F-063 Plan first": cases(suiteCases.planTurn, suiteCases.buildMode),
    "F-062 Questions": cases(suiteCases.question),
    "F-110, F-111 Memory": cases(suiteCases.memoryBlock, suiteCases.memoryTools),
    "F-039 Three images": cases(suiteCases.checksum),
    "F-019 The agent's launch": cases(suiteCases.noCredential, suiteCases.envAllowlist, suiteCases.unknownNotification, suiteCases.slash, suiteCases.checksum, suiteCases.noEffort),
  },
  "fake-acp-agent-plain": {
    ...common,
    ...milestone6WithTools,
    "F-023 Live activity": cases(suiteCases.turn, suiteCases.tools, suiteCases.plan, suiteCases.unknownUpdate, suiteCases.subagentsNone, suiteCases.subagentsFlat),
    "F-025 Stop": cases(suiteCases.cancel, suiteCases.leftover),
    "F-089 Key proxy": cases(suiteCases.everyCall, suiteCases.usageMatch, suiteCases.endpoint),
    "F-078 Repo conventions": cases(suiteCases.twoRepos, sharedCases.trailer),
    "F-032, F-033, F-096 Reopen anywhere": cases(suiteCases.archive),
    "F-021 Agent profiles": fallback("projectConfigOverride", suiteCases.repoConfigHidden, suiteCases.repoAllowsAll, suiteCases.skillsMcp),
    "F-024 Steer": fallback("steerMidTurn", suiteCases.steerGuard, suiteCases.nextTurn),
    "F-026 Approvals": fallback("rejectAndContinue", suiteCases.deny, suiteCases.denyReason, suiteCases.ruleAsks, suiteCases.taskRule, suiteCases.allowForTask),
    "F-063 Plan first": fallback("planMode", suiteCases.buildMode, suiteCases.planTurn),
    "F-062 Questions": cases(suiteCases.question),
    "F-110, F-111 Memory": cases(suiteCases.memoryBlock, suiteCases.memoryTools),
    "F-039 Three images": cases(suiteCases.checksum),
    "F-019 The agent's launch": cases(suiteCases.noCredential, suiteCases.envAllowlist, suiteCases.unknownNotification, suiteCases.slash, suiteCases.checksum, suiteCases.noEffort),
  },
  "fake-acp-agent-plain-index-only-unknown-notification": {
    ...common,
    ...milestone6IndexOnly,
    "F-023 Live activity": cases(suiteCases.turn, suiteCases.tools, suiteCases.plan, suiteCases.unknownUpdate, suiteCases.subagentsNone, suiteCases.subagentsFlat),
    "F-025 Stop": cases(suiteCases.cancel, suiteCases.leftover),
    "F-089 Key proxy": cases(suiteCases.everyCall, suiteCases.usageMatch, suiteCases.endpoint),
    "F-078 Repo conventions": cases(suiteCases.twoRepos, sharedCases.trailer),
    "F-032, F-033, F-096 Reopen anywhere": cases(suiteCases.archive),
    "F-021 Agent profiles": fallback("projectConfigOverride", suiteCases.repoConfigHidden, suiteCases.repoAllowsAll, suiteCases.skillsMcp),
    "F-024 Steer": fallback("steerMidTurn", suiteCases.steerGuard, suiteCases.nextTurn),
    "F-026 Approvals": fallback("rejectAndContinue", suiteCases.deny, suiteCases.denyReason, suiteCases.ruleAsks, suiteCases.taskRule, suiteCases.allowForTask),
    "F-063 Plan first": fallback("planMode", suiteCases.buildMode, suiteCases.planTurn),
    "F-062 Questions": cases(suiteCases.question),
    "F-110, F-111 Memory": fallback("memory", suiteCases.memoryBlock, suiteCases.memoryIndex),
    "F-039 Three images": cases(suiteCases.checksum),
    "F-019 The agent's launch": cases(suiteCases.noCredential, suiteCases.envAllowlist, suiteCases.unknownNotification, suiteCases.slash, suiteCases.checksum, suiteCases.noEffort),
  },
  "fake-acp-agent-rich-effort": {
    ...common,
    ...milestone6WithTools,
    "F-023 Live activity": cases(suiteCases.turn, suiteCases.tools, suiteCases.plan, suiteCases.unknownUpdate, suiteCases.subagentsWait, suiteCases.subagentsOwn),
    "F-025 Stop": cases(suiteCases.cancel, suiteCases.leftover, suiteCases.subagentsCancel),
    "F-089 Key proxy": cases(suiteCases.everyCall, suiteCases.usageMatch, suiteCases.endpoint),
    "F-078 Repo conventions": cases(suiteCases.twoRepos, sharedCases.trailer),
    "F-032, F-033, F-096 Reopen anywhere": cases(suiteCases.archive),
    "F-021 Agent profiles": cases(suiteCases.skillsMcp, suiteCases.repoAllowsAll),
    "F-024 Steer": cases(suiteCases.steer, suiteCases.nextTurn),
    "F-026 Approvals": cases(suiteCases.ruleAsks, suiteCases.taskRule, suiteCases.allowForTask, suiteCases.deny),
    "F-063 Plan first": cases(suiteCases.planTurn, suiteCases.buildMode),
    "F-062 Questions": cases(suiteCases.question),
    "F-110, F-111 Memory": cases(suiteCases.memoryBlock, suiteCases.memoryTools),
    "F-039 Three images": cases(suiteCases.checksum),
    "F-019 The agent's launch": cases(suiteCases.noCredential, suiteCases.envAllowlist, suiteCases.unknownNotification, suiteCases.slash, suiteCases.checksum, suiteCases.effortLevels),
  },
};

/** The repo's root, from this file's place in it. */
export const parityRepoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `file` holds a test titled exactly `title`: `it("…"` or `test("…"`, the title as its source quotes it. */
export const holdsTest = (source: string, title: string): boolean =>
  new RegExp(`\\b(?:it|test)(?:\\.each\\([^)]*\\))?\\(\\s*${escapeRegExp(JSON.stringify(title))}`).test(source);

/** One adapter as the check reads it: its name and what it declares. */
export type ParitySubject = { readonly name: string; readonly capabilities: AgentCapabilities };

const proofCases = (proof: ParityProof): readonly ParityCase[] => (proof.kind === "waits" ? [] : proof.cases);

/**
 * What is wrong with the table for these adapters, in words for a test's failure. Empty when every
 * adapter has an entry for every row, every case it names exists, no fallback names a capability
 * the adapter declares, and every capability has a case among its entries that runs the way the
 * adapter declares it.
 */
export const checkParity = async (
  subjects: readonly ParitySubject[],
  table: Readonly<Record<string, Readonly<Record<string, ParityProof>>>> = parityTable,
  readSource: (file: string) => Promise<string> = (file) => readFile(path.join(parityRepoRoot, file), "utf8"),
): Promise<readonly string[]> => {
  const problems: string[] = [];
  const sources = new Map<string, Promise<string | null>>();
  const sourceOf = (file: string): Promise<string | null> => {
    let found = sources.get(file);
    if (found === undefined) {
      found = readSource(file).catch(() => null);
      sources.set(file, found);
    }
    return found;
  };
  for (const subject of subjects) {
    const entries = table[subject.name];
    if (entries === undefined) {
      problems.push(`${subject.name}: no entry in the parity table`);
      continue;
    }
    for (const feature of parityFeatures) {
      const proof = entries[feature];
      if (proof === undefined) {
        problems.push(`${subject.name}: no entry for ${feature}`);
        continue;
      }
      if (proof.kind !== "waits" && proof.cases.length === 0) {
        problems.push(`${subject.name}: ${feature} names no case`);
      }
      if (proof.kind === "fallback" && declares(subject.capabilities, proof.capability)) {
        problems.push(`${subject.name}: ${feature} names a fallback for ${proof.capability}, which it declares: it must prove the capability itself`);
      }
    }
    for (const feature of Object.keys(entries)) {
      if (!parityFeatures.some((known) => known === feature)) {
        problems.push(`${subject.name}: ${feature} is no row of the table`);
      }
    }
    const named = Object.values(entries).flatMap(proofCases);
    for (const parityCase of named) {
      const source = await sourceOf(parityCase.file);
      if (source === null) {
        problems.push(`${subject.name}: ${parityCase.file} doesn't exist`);
      } else if (!holdsTest(source, parityCase.title)) {
        problems.push(`${subject.name}: ${parityCase.file} has no case "${parityCase.title}"`);
      }
    }
    const capabilities = Object.keys(capabilityCases).filter((key): key is keyof AgentCapabilities => Object.hasOwn(capabilityCases, key));
    for (const capability of capabilities) {
      const on = declares(subject.capabilities, capability);
      const wanted = on ? capabilityCases[capability].on : capabilityCases[capability].off;
      const covered = wanted.some((candidate) => named.some((parityCase) => parityCase.file === candidate.file && parityCase.title === candidate.title));
      if (!covered) {
        problems.push(`${subject.name}: declares ${capability} ${on ? "on" : "off"}, and no case among its entries runs that way`);
      }
    }
  }
  return problems;
};

/** The rows still waiting for the cases of a ticket being built, per adapter: what the proof file lists as not yet proved. */
export const pendingParity = (table: Readonly<Record<string, Readonly<Record<string, ParityProof>>>> = parityTable): readonly string[] =>
  Object.entries(table).flatMap(([name, entries]) =>
    Object.entries(entries).flatMap(([feature, proof]) => (proof.kind === "waits" ? [`${name}: ${feature} waits for ${proof.on}`] : [])),
  );
