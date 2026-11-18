// One run: a ticket worked by OpenCode, in its own task (workspace, key proxy,
// config, explicit environment, ACP driver), from the prompt to the diff and
// the checks. Everything a run records comes from the driver's events and the
// key proxy, never from what the agent says about itself.
//
// Logs carry IDs, counts and sizes. A run's folder holds its artifacts (diff,
// the agent's summary, a type-only event log): that is run data, kept out of
// git, and the only place content lives.
//
// The task's own folders (workspace, home, XDG and temp) are not in the run's
// folder: they are in the OS temp folder (sandbox.ts), so the agent's workspace
// has no parent that leads to this spike's hidden tests, its reference
// solutions or the other runs' diffs. They are deleted when the run ends.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentText, isAgentExitedError, startAcpDriver, textPrompt, type AcpDriver, type DriverEvent, type PermissionDecider } from "../lib/acp-driver.ts";
import { allowOnce } from "../lib/deciders.ts";
import { taskId } from "../lib/ids.ts";
import { startKeyProxy, type KeyProxy, type ProxyCallRecord } from "../lib/key-proxy.ts";
import {
  buildAgentEnv,
  buildOpenCodeConfig,
  createTaskDirs,
  openCodeAcpLaunch,
  writeOpenCodeConfig,
  type OpenCodeBinary,
  type PermissionRule,
  type ProviderSpec,
} from "../lib/opencode.ts";
import { startStubModelServer, type StubServer } from "../lib/stub-models/server.ts";
import type { StubFormat } from "../lib/stub-models/types.ts";
import { addUsage, totalTokens, zeroUsage, type TokenUsage } from "../lib/usage.ts";
import type { ModelEndpoint, ModelLimits } from "../harness/inputs.ts";
import { buildSolution } from "../tickets/solutions.ts";
import type { Ticket, Variant } from "../tickets/schema.ts";
import { checkResult } from "./checks.ts";
import { CONTROL_POLICY_NAME, PERMISSION_RULES, POLICY_NAME } from "./policy.ts";
import { STUB_PRICING, usdOf, type Pricing } from "./pricing.ts";
import { trackPid, untrackPid } from "./processes.ts";
import { buildPrompt } from "./prompt.ts";
import { WORK_ROOT } from "./sandbox.ts";
import { RunRecordSchema, runId, type Outcome, type RunRecord } from "./schemas.ts";
import { createSolveBrain } from "./stub-brain.ts";
import { answerUnattended } from "./unattended.ts";
import { collectDiff, initWorkspace, removeDir } from "./workspace.ts";

export const KEY_ENV = "OSTRA_MODEL_API_KEY";
export const STUB_MODEL = "stub-coder";

export type ModelTarget =
  | { readonly kind: "stub"; readonly format: StubFormat; readonly variant: Variant; readonly stepDelayMs?: number }
  | { readonly kind: "endpoint"; readonly endpoint: ModelEndpoint; readonly format: StubFormat; readonly pricing: Pricing | undefined; readonly limits: ModelLimits };

export type RunLimits = {
  readonly timeoutMs: number;
  /** All the proxy's tokens in the run, input and output. A runaway stops here. */
  readonly maxTokens: number;
  readonly maxUsd: number | undefined;
  /** How often the caps are checked. Default 1 s. */
  readonly watchMs?: number;
};

export type RunPlan = {
  readonly runsDir: string;
  readonly label: string;
  readonly ticket: Ticket;
  /** 1 to 3. */
  readonly index: number;
  readonly model: ModelTarget;
  readonly limits: RunLimits;
  readonly binary: OpenCodeBinary;
  /** Replaces the policy's permission rules. Only for a control run that must show what the rules prevent: the record then carries another policy name. */
  readonly permissions?: readonly PermissionRule[];
};

export type RunLogger = (line: Readonly<Record<string, string | number | boolean | null>>) => void;

const sumUsage = (calls: readonly ProxyCallRecord[]): TokenUsage => calls.reduce((sum, call) => addUsage(sum, call.usage ?? zeroUsage), zeroUsage);

const bump = (table: Record<string, number>, key: string): void => {
  table[key] = (table[key] ?? 0) + 1;
};

const truncate = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, chars)}...`);

/** The type-only view of an event: what happened, never what was said or run. */
const eventLine = (event: DriverEvent): Record<string, string | number | null> => {
  const base = { seq: event.seq, at: event.at, kind: event.kind };
  switch (event.kind) {
    case "session_update": {
      const update = event.update;
      return {
        ...base,
        update: update.sessionUpdate,
        toolCallId: "toolCallId" in update && typeof update.toolCallId === "string" ? update.toolCallId : null,
        toolKind: "kind" in update && typeof update.kind === "string" ? update.kind : null,
        status: "status" in update && typeof update.status === "string" ? update.status : null,
      };
    }
    case "prompt_finished":
      return { ...base, stopReason: event.response.stopReason };
    case "cancel_reaped":
      return { ...base, reaped: event.pids.length };
    case "permission_requested":
    case "permission_resolved":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "prompt_failed":
    case "agent_exited":
      return base;
    default:
      return event satisfies never;
  }
};

/** What a run has opened, so that whatever it opened is closed however it ends. */
type Resources = { stub?: StubServer; proxy?: KeyProxy; driver?: AcpDriver; taskRoot?: string };

type ModelSide = {
  readonly realKey: string;
  readonly upstreamBaseUrl: string;
  readonly modelId: string;
  readonly pricing: Pricing | undefined;
  readonly limits: ModelLimits;
};

const startModelSide = async (plan: RunPlan, resources: Resources): Promise<ModelSide> => {
  const { model, ticket } = plan;
  if (model.kind === "endpoint") {
    return { realKey: model.endpoint.apiKey, upstreamBaseUrl: model.endpoint.baseUrl, modelId: model.endpoint.modelId, pricing: model.pricing, limits: model.limits };
  }
  const solution = await buildSolution(ticket.id, model.variant);
  if (solution === undefined) throw new Error(`no ${model.variant} script for ${ticket.id}`);
  const realKey = `stub-real-${randomBytes(16).toString("hex")}`;
  const stub = await startStubModelServer({ format: model.format, realKey, models: [STUB_MODEL], brain: createSolveBrain(solution, model.stepDelayMs === undefined ? {} : { stepDelayMs: model.stepDelayMs }) });
  resources.stub = stub;
  return { realKey, upstreamBaseUrl: stub.baseUrl, modelId: STUB_MODEL, pricing: STUB_PRICING, limits: { context: 128_000, output: 16_000 } };
};

/** Runs one ticket once, and returns its record (also written to the run's folder). */
export const executeRun = async (plan: RunPlan, log: RunLogger): Promise<RunRecord> => {
  const id = runId(`${plan.ticket.id}-r${String(plan.index)}`);
  const dir = path.join(plan.runsDir, id);
  await removeDir(dir);
  await mkdir(dir, { recursive: true });
  const resources: Resources = {};
  try {
    return await runInside(plan, log, id, dir, resources);
  } finally {
    // Nothing of a run may stay behind: the agent, the proxy, the stub, the task's folders.
    // A folder a lingering helper still holds (a handle on Windows) must not turn a recorded run into a failed one.
    const cleanupFailed = (): void => {
      log({ event: "run.cleanup_failed", runId: id });
    };
    if (resources.driver !== undefined) await resources.driver.stop(1000).catch(() => undefined);
    await resources.proxy?.close().catch(() => undefined);
    await resources.stub?.close().catch(() => undefined);
    if (resources.taskRoot !== undefined) await removeDir(resources.taskRoot).catch(cleanupFailed);
    await removeDir(path.join(dir, "verify")).catch(cleanupFailed);
  }
};

const runInside = async (plan: RunPlan, log: RunLogger, id: ReturnType<typeof runId>, dir: string, resources: Resources): Promise<RunRecord> => {
  const { ticket, index, model } = plan;
  const startedAt = new Date();
  const suffix = randomBytes(3).toString("hex");
  const tid = taskId(`${id}-${suffix}`);
  const branch = `ostra/${ticket.id}`;
  const taskRoot = path.join(WORK_ROOT, `${id}-${suffix}`);
  resources.taskRoot = taskRoot;
  const dirs = await createTaskDirs(taskRoot);
  await initWorkspace(dirs.workspace, branch);

  const side = await startModelSide(plan, resources);
  const { pricing } = side;
  const format = model.format;

  const proxyLog: Record<string, string | number | boolean | null>[] = [];
  const proxy = await startKeyProxy({
    upstreamBaseUrl: side.upstreamBaseUrl,
    realKey: side.realKey,
    upstreamAuth: format === "anthropic" ? "x-api-key" : "bearer",
    taskId: tid,
    log: (line) => {
      proxyLog.push(line);
    },
  });
  resources.proxy = proxy;

  const spec: ProviderSpec = {
    kind: "custom",
    id: `ostra-${format}`,
    format,
    baseUrl: proxy.agentBaseUrl,
    keyEnv: KEY_ENV,
    models: [
      {
        id: side.modelId,
        context: side.limits.context,
        output: side.limits.output,
        ...(pricing === undefined ? {} : { cost: { input: pricing.inputPerMTok, output: pricing.outputPerMTok } }),
      },
    ],
  };
  await writeOpenCodeConfig(dirs, buildOpenCodeConfig({ providers: [spec], model: `${spec.id}/${side.modelId}`, permissions: plan.permissions ?? PERMISSION_RULES }));
  const env = buildAgentEnv({ dirs, fakeKeys: { [KEY_ENV]: proxy.fakeKey } });

  const byKind: Record<string, number> = {};
  const approvals = { requested: 0, allowed: 0, rejected: 0, byKind };
  const decidePermission: PermissionDecider = async (request, signal) => {
    approvals.requested += 1;
    bump(byKind, request.toolCall.kind ?? "other");
    const answer = await allowOnce(request, signal);
    if (answer.outcome.outcome === "selected") approvals.allowed += 1;
    else approvals.rejected += 1;
    return answer;
  };

  const spawnStarted = Date.now();
  const agent = await startAcpDriver({
    taskId: tid,
    launch: openCodeAcpLaunch(plan.binary, dirs, env),
    decidePermission,
    answerElicitation: answerUnattended,
    onSpawn: (pid) => {
      trackPid(pid);
    },
  });
  resources.driver = agent;
  void agent.exited.then(() => {
    untrackPid(agent.pid);
  });
  const session = await agent.newSession({ cwd: dirs.workspace, mcpServers: [] });
  const startupMs = Date.now() - spawnStarted;

  // The turn, with its three ways out: it ends, the time runs out, a cap is hit.
  const stop: { cap: "token-cap" | "spend-cap" | undefined; timedOut: boolean } = { cap: undefined, timedOut: false };
  let forceTimer: NodeJS.Timeout | undefined;
  const cancelTurn = (): void => {
    void agent.cancel(session.sessionId);
    // A cancel the agent ignores must not hold the run: stop the agent itself after a grace.
    forceTimer ??= setTimeout(() => {
      void agent.stop(1000);
    }, 30_000);
  };
  const watch = setInterval(() => {
    if (stop.cap !== undefined) return;
    const usage = sumUsage(proxy.calls);
    if (totalTokens(usage) > plan.limits.maxTokens) stop.cap = "token-cap";
    else if (plan.limits.maxUsd !== undefined && pricing !== undefined && usdOf(usage, pricing) > plan.limits.maxUsd) stop.cap = "spend-cap";
    if (stop.cap !== undefined) cancelTurn();
  }, plan.limits.watchMs ?? 1000);
  const deadline = setTimeout(() => {
    stop.timedOut = true;
    cancelTurn();
  }, plan.limits.timeoutMs);

  const promptStarted = Date.now();
  let stopReason: string | null = null;
  let agentReported: number | null = null;
  let outcome: Outcome = "completed";
  let error: string | null = null;
  try {
    const response = await agent.prompt(session.sessionId, textPrompt(buildPrompt(ticket, branch)));
    stopReason = response.stopReason;
    agentReported = response.usage?.totalTokens ?? null;
    if (stop.cap !== undefined) outcome = stop.cap;
    else if (stop.timedOut) outcome = "timeout";
    else if (response.stopReason !== "end_turn") {
      outcome = "error";
      error = `the turn ended with stop reason ${response.stopReason}`;
    }
  } catch (caught) {
    outcome = isAgentExitedError(caught) ? "agent-crashed" : "error";
    error = truncate(caught instanceof Error ? caught.message : "the turn failed", 300);
    // A cancel that had to be forced shows as a crash: say why the run was stopped.
    if (stop.cap !== undefined && outcome === "agent-crashed") outcome = stop.cap;
    else if (stop.timedOut && outcome === "agent-crashed") outcome = "timeout";
  } finally {
    clearInterval(watch);
    clearTimeout(deadline);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }
  const wallMs = Date.now() - promptStarted;

  const events = [...agent.events];
  const wire = agent.wire();
  await agent.stop(3000);
  const summary = agentText(events, session.sessionId);
  const stderrTail = agent.stderrTail();

  // What the agent left behind, and what the harness thinks of it.
  const verifyRoot = path.join(dir, "verify");
  const diff = await collectDiff(dirs.workspace, verifyRoot);
  const checked = await checkResult(ticket, dirs.workspace, verifyRoot);

  // The meter: every call through the proxy, the turn's own and the title calls.
  const calls = proxy.calls;
  const usage = sumUsage(calls);
  const byUpdate: Record<string, number> = {};
  for (const event of events) bump(byUpdate, event.kind === "session_update" ? event.update.sessionUpdate : event.kind);
  const perMinute = wallMs > 0 ? Math.round((events.length / (wallMs / 60_000)) * 10) / 10 : 0;

  const record: RunRecord = RunRecordSchema.parse({
    schema: 1,
    runId: id,
    ticketId: ticket.id,
    kind: ticket.kind,
    index,
    label: plan.label,
    mode: model.kind === "stub" ? "dry" : "real",
    ...(model.kind === "stub" ? { variant: model.variant } : {}),
    model: { id: side.modelId, format },
    agent: { name: "opencode", version: plan.binary.packageVersion, sha256: plan.binary.sha256 },
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    outcome,
    stopReason,
    error,
    time: { wallMs, startupMs },
    turns: {
      prompts: 1,
      modelCalls: calls.filter((call) => call.hasTools).length,
      auxiliaryCalls: calls.filter((call) => !call.hasTools).length,
      toolCalls: byUpdate["tool_call"] ?? 0,
      questions: byUpdate["elicitation_requested"] ?? 0,
    },
    approvals: { policy: plan.permissions === undefined ? POLICY_NAME : CONTROL_POLICY_NAME, ...approvals },
    events: { total: events.length, perMinute, byUpdate, wireMessages: wire.inbound, wireBytes: wire.inboundBytes },
    spend: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: totalTokens(usage),
      turnTokens: totalTokens(sumUsage(calls.filter((call) => call.hasTools))),
      usd: pricing === undefined ? null : usdOf(usage, pricing),
      pricing: pricing === undefined ? "none" : pricing.source,
      callsWithoutUsage: calls.filter((call) => call.status === 200 && call.usage === undefined).length,
      agentReportedTokens: agentReported,
    },
    modelErrors: {
      rateLimited: calls.filter((call) => call.rateLimited).length,
      serverErrors: calls.filter((call) => call.status >= 500).length,
      clientErrors: calls.filter((call) => call.status >= 400 && call.status < 500 && !call.rateLimited).length,
    },
    diff: { files: [...diff.files], insertions: diff.insertions, deletions: diff.deletions },
    checks: { ci: checked.ci, acceptance: checked.acceptance, touchedSource: diff.touchedSource },
  });

  // Artifacts: the diff, the agent's own summary, a type-only event log, the proxy's call table.
  await writeFile(path.join(dir, "diff.patch"), diff.patch);
  await writeFile(path.join(dir, "summary.txt"), summary);
  await writeFile(path.join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(eventLine(event))).join("\n")}\n`);
  await writeFile(
    path.join(dir, "proxy-calls.json"),
    JSON.stringify(
      calls.map((call) => ({
        startedAt: call.startedAt,
        ms: call.endedAt - call.startedAt,
        status: call.status,
        hasTools: call.hasTools,
        streamed: call.streamed,
        keySwapped: call.keySwapped,
        usage: call.usage ?? null,
      })),
      null,
      1,
    ),
  );
  await writeFile(path.join(dir, "proxy-log.jsonl"), `${proxyLog.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (outcome !== "completed" || stderrTail.trim() !== "") await writeFile(path.join(dir, "agent-stderr.txt"), stderrTail);
  if (checked.log !== "") await writeFile(path.join(dir, "checks.txt"), checked.log);
  await writeFile(path.join(dir, "run.json"), JSON.stringify(record, null, 2));

  log({
    event: "run.done",
    runId: id,
    outcome,
    wallMs,
    modelCalls: record.turns.modelCalls,
    approvals: approvals.requested,
    events: events.length,
    totalTokens: record.spend.totalTokens,
    ci: checked.ci.green,
    acceptance: checked.acceptance.passed,
  });
  return record;
};
