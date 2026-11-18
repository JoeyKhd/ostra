// Drives one box through a full lifecycle and records what the pass bar asks.
// The same steps run against the loopback rehearsal and against a real box on
// Docker or Kubernetes (real-box.ts); only how the harness reaches the box
// differs (`BoxUnderTest`).
//
//   1. the box reaches "ready" through the bridge, and the bridge port then
//      refuses a new connection
//   2. a turn that needs an approval; the approval is held
//   3. the attack checklist runs in the agent's container AS the agent (the
//      sidecar's POST /attack spawns it through the bridge with the agent's
//      exact environment), plus a negative control that must be EXPOSED
//   4. the held approval is still pending (the box couldn't answer it); the
//      member answers it and the turn completes; the key proxy swapped the key
//   5. a long turn over the bridge
//   6. a process tree (background server, detached grandchild, long sleep),
//      then stop; the processes are counted independently of the sidecar
//
// Each check is filed under the pass-bar bullet it belongs to when it is
// made, so no check can be produced and then dropped.

import { tryConnect, type AttackConfigInput, type ChecklistReport, type Probe } from "../attack/checklist.ts";
import { attackResponseSchema, controlStatusSchema, errorBodySchema, stopResultSchema, type AttackRequest, type ControlStatus } from "../sidecar/control-schema.ts";
import { descendantsOf, isAlive, listProcesses, type ProcessInfo } from "../lib/process-tree.ts";
import { startLoopbackBox } from "./box-fixture.ts";
import { check, fail, pass, skip, type Check } from "./report.ts";

export type BarId = "P1" | "P2" | "P3" | "P4" | "P5";
export const BAR_IDS: readonly BarId[] = ["P1", "P2", "P3", "P4", "P5"];

export type Recorded = Record<string, string | number | boolean | null>;

export type BoxRunResult = {
  readonly kind: BoxKind;
  readonly byBar: Readonly<Record<BarId, readonly Check[]>>;
  readonly recorded: Readonly<Recorded>;
};

export type BoxKind = "loopback" | "docker" | "kubernetes";

export type ControlReply = { readonly status: number; readonly body: unknown };
export type ControlClient = (method: string, pathname: string, body?: unknown) => Promise<ControlReply>;

/** How the harness reaches one box. */
export type BoxUnderTest = {
  readonly kind: BoxKind;
  readonly control: ControlClient;
  /** The attack checklist's config, as seen from inside the agent's container. */
  readonly attackConfig: AttackConfigInput;
  /** A model-marker string for the negative control (never a real key). */
  readonly modelMarker: string;
  /** Every process where the agent runs (here, or in the agent's container). */
  readonly listAgentProcesses: () => Promise<ProcessInfo[]>;
  /** Probes the bridge address from the harness, when the harness can reach it (loopback). */
  readonly probeBridge?: () => Promise<Probe>;
  /** An extra attack run, by the real shell path (`docker exec` / `kubectl exec`), when there is one. */
  readonly execAttack?: (config: AttackConfigInput) => Promise<{ readonly exitCode: number | null; readonly report: ChecklistReport }>;
  /** Wall-clock ms of this box's start: processes older than this are not this box's. */
  readonly startedAt: number;
};

export const emptyBar = (): Record<BarId, Check[]> => ({ P1: [], P2: [], P3: [], P4: [], P5: [] });

const TREE_MARKERS = ["ostra-box-sleep", "ostra-box-orphan", "ostra-box-server"] as const;

const statusOf = async (control: ControlClient): Promise<ControlStatus> => {
  const reply = await control("GET", "/status");
  if (reply.status !== 200) throw new Error(`GET /status answered ${String(reply.status)}`);
  return controlStatusSchema.parse(reply.body);
};

export const waitForStatus = async (control: ControlClient, predicate: (status: ControlStatus) => boolean, timeoutMs: number): Promise<ControlStatus> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const status = await statusOf(control);
      if (predicate(status)) return status;
      if (status.phase === "failed") throw new Error(`box failed: ${String(status.failure)}`);
      lastError = undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("box failed")) throw error;
      lastError = error;
    }
    if (Date.now() > deadline) throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
};

const expectOk = (reply: ControlReply, what: string): void => {
  if (reply.status >= 200 && reply.status < 300) return;
  const error = errorBodySchema.safeParse(reply.body);
  throw new Error(`${what} answered ${String(reply.status)}${error.success ? ` (${error.data.error})` : ""}`);
};

/** The checklist's results as checks: BLOCKED passes, EXPOSED fails, SKIPPED stays SKIPPED. */
export const attackChecks = (prefix: string, report: ChecklistReport): Check[] =>
  report.results.map((r) => {
    const name = `${prefix}: ${r.id}`;
    switch (r.outcome) {
      case "BLOCKED":
        return pass(name, r.detail);
      case "EXPOSED":
        return fail(name, `${r.title}: ${r.detail}`);
      case "SKIPPED":
        return skip(name, r.detail);
      default:
        return r.outcome satisfies never;
    }
  });

export const serviceChecks = (prefix: string, report: ChecklistReport): Check[] =>
  report.services.map((s) => {
    const name = `${prefix}: ${s.title}`;
    switch (s.outcome) {
      case "REACHABLE":
        return pass(name, s.detail);
      case "UNREACHABLE":
        return fail(name, s.detail);
      case "SKIPPED":
        return skip(name, s.detail);
      default:
        return s.outcome satisfies never;
    }
  });

const runAttack = async (box: BoxUnderTest, request: AttackRequest): Promise<ChecklistReport> => {
  const reply = await box.control("POST", "/attack", request);
  expectOk(reply, "POST /attack");
  return attackResponseSchema.parse(reply.body).report;
};

const waitForProcess = async (box: BoxUnderTest, marker: string, since: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await box.listAgentProcesses()).some((p) => p.commandLine.includes(marker) && (p.startedAt === 0 || p.startedAt >= since));
    if (found) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

/** Processes of this box still alive: the tree's markers, and anything below the init. */
const survivorsOf = async (box: BoxUnderTest, initPid: number | null, since: number): Promise<ProcessInfo[]> => {
  const all = await box.listAgentProcesses();
  const marked = all.filter((p) => TREE_MARKERS.some((m) => p.commandLine.includes(m)) && (p.startedAt === 0 || p.startedAt >= since));
  const below = initPid === null ? [] : descendantsOf(initPid, all);
  const local = box.kind === "loopback";
  const byPid = new Map<number, ProcessInfo>();
  // Loopback: confirm each is still alive after the listing (the listing races exits).
  for (const p of [...marked, ...below]) if (!local || isAlive(p.pid)) byPid.set(p.pid, p);
  return [...byPid.values()];
};

/** The lifecycle and the pass-bar checks for one box. */
export const driveBox = async (box: BoxUnderTest, options: { readonly longSeconds: number }): Promise<BoxRunResult> => {
  const bar = emptyBar();
  const recorded: Recorded = {};
  const realBox = box.kind !== "loopback";

  // 1. Ready through the bridge, then the bridge port is shut.
  const ready = await waitForStatus(box.control, (status) => status.phase === "ready", 120_000);
  const readyMs = (ready.timings["agentReadyAt"] ?? 0) - (ready.timings["startedAt"] ?? 0);
  recorded["sidecarReadyMs"] = readyMs;
  bar.P2.push(pass("box ready through the bridge", `phase=ready, init pid ${String(ready.bridge.initPid)} connected, ${String(readyMs)} ms from sidecar start to session (${box.kind})`));
  if (box.probeBridge !== undefined) {
    const probe = await box.probeBridge();
    bar.P1.push(check("the bridge port refuses a connection once the init is in (probed)", !probe.connected, probe.connected ? "a new connection was accepted" : `connect failed (${probe.detail})`));
  }

  // 2. A turn that needs an approval, held.
  expectOk(await box.control("POST", "/config", { approvals: "hold" }), "POST /config");
  const turn = await box.control("POST", "/turn", { text: "Edit the file. [[stub:approval]]" });
  if (turn.status !== 202) throw new Error(`turn not accepted: ${String(turn.status)}`);
  const pendingStatus = await waitForStatus(box.control, (status) => status.approvals.pending.length > 0, 60_000);
  const approvalId = pendingStatus.approvals.pending[0]?.id;
  if (approvalId === undefined) throw new Error("no approval was held");

  // 3. The attack checklist, as the agent, while the approval is held.
  const report = await runAttack(box, { config: box.attackConfig });
  bar.P1.push(...attackChecks("attack (as the agent, via the bridge)", report));
  if (realBox) bar.P4.push(...serviceChecks("from the agent's container", report));
  // The negative control: the same run with a planted key must find it.
  const planted = await runAttack(box, { config: box.attackConfig, plantEnv: { name: "OSTRA_MODEL_KEY", value: box.modelMarker } });
  const plantedEnv = planted.results.find((r) => r.id === "env")?.outcome;
  bar.P1.push(check("negative control: a key planted in the agent's env is found", plantedEnv === "EXPOSED", `env check answered ${String(plantedEnv)} with OSTRA_MODEL_KEY=<model marker> planted`));
  if (box.execAttack !== undefined) {
    const shell = await box.execAttack(box.attackConfig);
    bar.P1.push(...attackChecks("attack (shell in the agent's container)", shell.report));
  }

  // 4. The box could not answer the approval: still pending. The member answers.
  const afterAttack = await statusOf(box.control);
  bar.P1.push(check("the held approval is still pending after the attack", afterAttack.approvals.pending.some((p) => p.id === approvalId), `pending ids: ${afterAttack.approvals.pending.map((p) => String(p.id)).join(",") || "none"}`));
  expectOk(await box.control("POST", `/approvals/${String(approvalId)}`, { decision: "allow_once" }), "POST /approvals");
  const finished = await waitForStatus(box.control, (status) => status.turn.state === "finished" || status.turn.state === "failed", 60_000);
  bar.P2.push(finished.turn.state === "finished" ? pass("a turn completes over the bridge", `stopReason=${finished.turn.stopReason}`) : fail("a turn completes over the bridge", `turn ${finished.turn.state}`));
  recorded["keyProxyCalls"] = finished.keyProxy.calls;
  recorded["keyProxySwapped"] = finished.keyProxy.swapped;
  bar.P1.push(check("the key proxy swapped the fake key (the agent never held the real one)", finished.keyProxy.swapped > 0 && finished.keyProxy.rejected === 0, `swapped ${String(finished.keyProxy.swapped)}, rejected ${String(finished.keyProxy.rejected)}`));

  // 5. A long turn over the bridge.
  const longStarted = Date.now();
  expectOk(await box.control("POST", "/turn", { text: `Wait. [[stub:long ${String(options.longSeconds)}]]` }), "POST /turn (long)");
  const longDone = await waitForStatus(box.control, (status) => status.turn.state !== "running" && status.turn.state !== "idle" && status.turn.turn >= 2, (options.longSeconds + 120) * 1000);
  const turnSeconds = Math.round((Date.now() - longStarted) / 1000);
  recorded["bridgeTurnSeconds"] = turnSeconds;
  const longOk = longDone.turn.state === "finished" && turnSeconds >= options.longSeconds;
  bar.P2.push(check(`the bridge carries a ${String(options.longSeconds)} s turn`, longOk, longOk ? `${String(turnSeconds)} s turn finished cleanly` : `turn ${longDone.turn.state} after ${String(turnSeconds)} s`));
  if (!realBox) bar.P2.push(skip("the full 20-minute turn in a real box", "a real box: `pnpm spike --real=docker --long=1200` (or --real=k8s)"));
  else if (options.longSeconds >= 1200) bar.P2.push(check("the full 20-minute turn in a real box", longOk, `${String(turnSeconds)} s on ${box.kind}`));
  else bar.P2.push(skip("the full 20-minute turn in a real box", `--long=1200 (this run: ${String(options.longSeconds)} s on ${box.kind})`));

  // The sidecar's memory while it holds a live task. Loopback: the harness
  // process, which also holds the stubs, the driver and the sidecar.
  if (realBox) recorded["sidecarProcessRssMb"] = Math.round(longDone.memory.rssBytes / (1024 * 1024));
  else recorded["harnessProcessRssMb"] = Math.round(longDone.memory.rssBytes / (1024 * 1024));

  // 6. A process tree, then stop. Counted from the process list, not from
  //    the sidecar's own report.
  const treeSince = Date.now() - 2000;
  expectOk(await box.control("POST", "/turn", { text: "Start helpers. [[stub:tree]]" }), "POST /turn (tree)");
  const treeUp = await waitForProcess(box, "ostra-box-sleep", treeSince, 90_000);
  const before = await box.listAgentProcesses();
  const treeCount = before.filter((p) => TREE_MARKERS.some((m) => p.commandLine.includes(m)) && (p.startedAt === 0 || p.startedAt >= treeSince)).length;
  recorded["treeProcessesBeforeStop"] = treeCount;
  bar.P2.push(check("the process tree is running before the stop", treeUp, `${String(treeCount)} marked process(es) (server, orphan, sleep)`));
  const initPid = finished.bridge.initPid;
  const stopReply = await box.control("POST", "/stop");
  if (stopReply.status !== 200) throw new Error(`POST /stop answered ${String(stopReply.status)}`);
  const stop = stopResultSchema.parse(stopReply.body);
  recorded["leftoverReportedBySidecar"] = stop.leftover.length;
  // Give the kills a moment to land, then look.
  let survivors: ProcessInfo[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    survivors = await survivorsOf(box, initPid, treeSince);
    if (survivors.length === 0) break;
  }
  recorded["leftoverAfterStop"] = survivors.length;
  bar.P2.push(
    check(
      "stopping leaves no process (counted from the process list)",
      treeUp && survivors.length === 0 && stop.leftover.length === 0,
      `${String(survivors.length)} alive by marker or below the init; the sidecar reported ${String(stop.leftover.length)}${survivors.length > 0 ? `: ${survivors.map((p) => p.name).join(", ")}` : ""}`,
    ),
  );

  return { kind: box.kind, byBar: bar, recorded };
};

/** The loopback rehearsal: the box on this machine, without containers. */
export const runLoopbackBox = async (options: { readonly longSeconds: number }): Promise<BoxRunResult> => {
  const box = await startLoopbackBox();
  try {
    return await driveBox(
      {
        kind: "loopback",
        control: box.control,
        attackConfig: {
          modelMarker: box.modelMarker,
          gitMarker: box.gitMarker,
          controlAddr: box.controlAddr,
          handoffAddr: box.handoffAddr,
          bridgeAddr: box.bridgeAddr,
          roots: [box.taskRoot],
          // No egress policy on one host: the destination checks are SKIPPED.
          skipEgress: true,
        },
        modelMarker: box.modelMarker,
        listAgentProcesses: listProcesses,
        probeBridge: async () => tryConnect(box.bridgeAddr),
        startedAt: box.startedAt,
      },
      options,
    );
  } finally {
    await box.dispose();
  }
};

/**
 * One real turn against the model endpoint from model.env, through the key
 * proxy: the agent holds only the fake key and the proxy swaps in the real
 * one. Loopback, so it runs wherever the endpoint inputs are present.
 */
export const runEndpointSmoke = async (endpoint: { readonly baseUrl: string; readonly apiKey: string; readonly modelId: string; readonly format: "openai" | "anthropic" }): Promise<Check[]> => {
  const box = await startLoopbackBox({ endpoint });
  try {
    await waitForStatus(box.control, (status) => status.phase === "ready", 120_000);
    expectOk(await box.control("POST", "/config", { approvals: "allow" }), "POST /config");
    expectOk(await box.control("POST", "/turn", { text: "Reply with the single word OK. Do not use any tool." }), "POST /turn");
    const done = await waitForStatus(box.control, (status) => status.turn.state === "finished" || status.turn.state === "failed", 180_000);
    return [
      check("a real turn through the key proxy (model.env endpoint)", done.turn.state === "finished", done.turn.state === "finished" ? `stopReason=${done.turn.stopReason}` : `turn ${done.turn.state}`),
      check("the key proxy swapped the fake key for the real one (model.env endpoint)", done.keyProxy.swapped > 0 && done.keyProxy.rejected === 0, `${String(done.keyProxy.calls)} calls, swapped ${String(done.keyProxy.swapped)}, rejected ${String(done.keyProxy.rejected)}`),
    ];
  } finally {
    await box.dispose();
  }
};
