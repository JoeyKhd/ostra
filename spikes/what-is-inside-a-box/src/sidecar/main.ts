// The sidecar mode of the runner image (ADR 0029, ADR 0046): one per box.
// It holds the task's credentials in memory, runs the key proxy and the git
// proxy, drives the agent over ACP through the bridge to the agent's
// container, and (in this spike) serves a small control API on the uplink
// side that stands in for the server connection.
//
// Order at start:
//   1. handoff: wait for the credentials, from outside the box
//   2. key proxy, git proxy (and the stub model / stub git upstream if asked)
//   3. bridge port: wait for the init's one connection, then close the port
//   4. prepare the task's directories and config in the agent's container,
//      spawn `opencode acp` as the agent's user, initialize, open a session
//   5. control API: turns, approvals, cancel, stop, status, and the attack
//      checklist run in the agent's container (POST /attack)
//
// The handoff and the control API listen on TCP on Docker (published to the
// host loopback only), and on Unix sockets in a sidecar-only volume in a
// Kubernetes pod, where loopback is shared with the agent (handoff.ts).
//
// Logs carry IDs and counts only.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { checklistReportSchema } from "../attack/checklist.ts";
import { listenForInit, type Bridge } from "../bridge/bridge-server.ts";
import { BoxIdSchema, type BoxId } from "../bridge/protocol.ts";
import { startAcpDriver, textPrompt, type AcpDriver } from "../lib/acp-driver.ts";
import { declineQuestions } from "../lib/deciders.ts";
import { ApprovalIdSchema, approvalId as toApprovalId, type ApprovalId, type SessionId, type TaskId } from "../lib/ids.ts";
import { startKeyProxy, type KeyProxy } from "../lib/key-proxy.ts";
import { buildAgentEnv, buildOpenCodeConfig, taskDirsAt, type PermissionRule, type TaskDirs } from "../lib/opencode.ts";
import { createScenarioBrain } from "../lib/stub-models/scenario.ts";
import { startStubModelServer, type StubServer } from "../lib/stub-models/server.ts";
import { boxAuxiliary, boxScenarios } from "./box-scenarios.ts";
import { isInsideBox, type BoxNetwork } from "./box-network.ts";
import { approvalModeSchema, attackRequestSchema, type AttackResponse, type ControlStatus, type Phase, type StopResult, type TurnState } from "./control-schema.ts";
import { startGitProxy, startGitStubUpstream, type GitProxy, type GitStubUpstream } from "./git-proxy.ts";
import { listenForHandoff, type Handoff } from "./handoff.ts";

const run = promisify(execFile);

const port = z.coerce.number().int().min(0).max(65_535);
const flag = z.enum(["0", "1"]).transform((v) => v === "1");

export const sidecarEnvSchema = z.object({
  OSTRA_BOX_ID: BoxIdSchema,
  OSTRA_HANDOFF_NONCE: z.string().min(32).max(128),
  OSTRA_SIDECAR_LISTEN: z.string().default("0.0.0.0"),
  OSTRA_HANDOFF_PORT: port.default(7100),
  OSTRA_BRIDGE_PORT: port.default(7101),
  OSTRA_CONTROL_PORT: port.default(7102),
  OSTRA_KEY_PROXY_PORT: port.default(7200),
  OSTRA_GIT_PROXY_PORT: port.default(7201),
  /** Comma-separated CIDRs of the box network (Docker). */
  OSTRA_BOX_CIDRS: z.string().default(""),
  /** 1 in a Kubernetes pod: the agent shares this network namespace. */
  OSTRA_SHARED_NETNS: flag.default(false),
  /** How the agent's container reaches the sidecar: `sidecar` on Docker, `127.0.0.1` in a pod. */
  OSTRA_SIDECAR_HOST_FOR_AGENT: z.string().regex(/^[A-Za-z0-9.-]+$/).default("127.0.0.1"),
  OSTRA_AGENT_TASK_ROOT: z.string().default("/task"),
  OSTRA_AGENT_PATH: z.string().default("/opt/ostra/bin:/usr/local/bin:/usr/bin:/bin"),
  OSTRA_OPENCODE_COMMAND: z.string().default("/opt/ostra/bin/opencode"),
  /** Paths inside the agent's container are POSIX, except in the loopback rehearsal on Windows. */
  OSTRA_AGENT_PATH_STYLE: z.enum(["posix", "native"]).default("posix"),
  /** Node in the agent's container, and the attack checklist there (POST /attack). */
  OSTRA_AGENT_NODE: z.string().min(1).default("/usr/local/bin/node"),
  OSTRA_ATTACK_CLI: z.string().min(1).default("/opt/ostra/attack/cli.ts"),
  /** Kubernetes: listen for the handoff and the control API on these Unix sockets instead of TCP. */
  OSTRA_HANDOFF_SOCKET: z.string().min(1).optional(),
  OSTRA_CONTROL_SOCKET: z.string().min(1).optional(),
});
export type SidecarEnv = z.infer<typeof sidecarEnvSchema>;

type LogLine = Readonly<Record<string, string | number | boolean | null>>;

const log = (line: LogLine): void => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: "sidecar", ...line })}\n`);
};

const STUB_MODEL = "stub-coder";
const KEY_ENV = "OSTRA_MODEL_KEY";
const PERMISSIONS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
];
const ATTACK_TIMEOUT_MS = 120_000;
const MAX_ATTACK_OUTPUT = 1024 * 1024;

type PendingApproval = {
  readonly id: ApprovalId;
  readonly toolCallId: string;
  readonly title: string;
  readonly since: number;
  readonly resolve: (response: acp.RequestPermissionResponse) => void;
  readonly options: readonly acp.PermissionOption[];
};

type ApprovalMode = z.infer<typeof approvalModeSchema>;

const turnSchema = z.strictObject({ text: z.string().min(1).max(100_000) });
const decisionSchema = z.strictObject({ decision: z.enum(["allow_once", "reject_once"]) });
const configSchema = z.strictObject({ approvals: approvalModeSchema });

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("body too large");
    chunks.push(buffer);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const reply = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const sameToken = (header: string | undefined, token: string): boolean => {
  const presented = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && a.equals(b);
};

const listenOn = async (server: ReturnType<typeof createServer>, options: { readonly socketPath: string | undefined; readonly port: number; readonly host: string }): Promise<void> => {
  const socketPath = options.socketPath;
  // A stale socket file from an earlier sidecar would make listen fail.
  if (socketPath !== undefined && process.platform !== "win32") await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.off("error", reject);
      resolve();
    };
    if (socketPath === undefined) server.listen(options.port, options.host, onListening);
    else server.listen(socketPath, onListening);
  });
};

export const runSidecar = async (env: SidecarEnv): Promise<void> => {
  const boxId: BoxId = env.OSTRA_BOX_ID;
  const network: BoxNetwork = {
    boxCidrs: env.OSTRA_BOX_CIDRS.split(",").map((c) => c.trim()).filter((c) => c !== ""),
    sharedNetns: env.OSTRA_SHARED_NETNS,
  };
  const timings: Record<string, number> = { startedAt: Date.now() };
  let phase: Phase = "waiting_handoff";
  const currentPhase = (): Phase => phase;

  // 1. Handoff.
  const handoffListener = await listenForHandoff({ boxId, nonce: env.OSTRA_HANDOFF_NONCE, host: env.OSTRA_SIDECAR_LISTEN, port: env.OSTRA_HANDOFF_PORT, socketPath: env.OSTRA_HANDOFF_SOCKET, network, log });
  log({ event: "sidecar_started", boxId, handoffPort: handoffListener.port, handoffOnSocket: env.OSTRA_HANDOFF_SOCKET !== undefined });
  const handoff: Handoff = await handoffListener.received;
  timings["handoffAt"] = Date.now();
  const taskId: TaskId = handoff.taskId;

  // Everything from here holds a resource (a port, a temp dir, a child). The
  // finally block releases them however the box ends.
  const closers: (() => Promise<void>)[] = [];
  let gitStubRoot: string | undefined;
  try {
    // 2. Proxies, and the stubs when the handoff asks for them.
    let stub: StubServer | undefined;
    let upstreamBaseUrl: string;
    let modelId: string;
    if (handoff.model.kind === "stub") {
      stub = await startStubModelServer({
        format: handoff.model.format,
        realKey: handoff.model.apiKey,
        models: [STUB_MODEL],
        brain: createScenarioBrain(boxScenarios, { auxiliary: boxAuxiliary }),
      });
      closers.push(stub.close);
      upstreamBaseUrl = stub.baseUrl;
      modelId = STUB_MODEL;
    } else {
      upstreamBaseUrl = handoff.model.baseUrl;
      modelId = handoff.model.modelId;
    }
    const proxy: KeyProxy = await startKeyProxy({
      upstreamBaseUrl,
      realKey: handoff.model.apiKey,
      upstreamAuth: handoff.model.format === "anthropic" ? "x-api-key" : "bearer",
      taskId,
      host: env.OSTRA_SIDECAR_LISTEN,
      port: env.OSTRA_KEY_PROXY_PORT,
      log,
    });
    closers.push(proxy.close);

    let gitStub: GitStubUpstream | undefined;
    let gitUpstream = handoff.git.upstream;
    if (gitUpstream === "stub") {
      gitStubRoot = await mkdtemp(path.join(tmpdir(), "ostra-git-stub-"));
      const bare = path.join(gitStubRoot, `${handoff.git.repo}.git`);
      await run("git", ["init", "--bare", "--initial-branch=main", bare]);
      await run("git", ["-C", bare, "config", "http.receivepack", "true"]);
      gitStub = await startGitStubUpstream({ projectRoot: gitStubRoot, token: handoff.git.token });
      closers.push(gitStub.close);
      gitUpstream = gitStub.origin;
    }
    const gitProxy: GitProxy = await startGitProxy({
      host: env.OSTRA_SIDECAR_LISTEN,
      port: env.OSTRA_GIT_PROXY_PORT,
      pathToken: randomBytes(16).toString("hex"),
      repo: handoff.git.repo,
      taskBranch: handoff.git.taskBranch,
      hiddenRef: `refs/ostra/wip/${handoff.taskId}`,
      upstream: gitUpstream,
      token: handoff.git.token,
      log,
    });
    closers.push(gitProxy.close);

    // 3. Bridge.
    phase = "waiting_bridge";
    const bridgeListener = await listenForInit({ boxId, nonce: handoff.bridgeNonce, host: env.OSTRA_SIDECAR_LISTEN, port: env.OSTRA_BRIDGE_PORT, log });
    closers.push(bridgeListener.close);

    // 5 (early). Control API, so the harness can watch the start.
    let driver: AcpDriver | undefined;
    let bridge: Bridge | undefined;
    let sessionId: SessionId | undefined;
    let approvalMode: ApprovalMode = "hold";
    let nextApproval = 1;
    const pending = new Map<ApprovalId, PendingApproval>();
    let approvalsSeen = 0;
    let turnCount = 0;
    let turn: TurnState = { state: "idle" };
    let failure: string | undefined;
    /** Where and how the agent runs, once it does: the attack checklist runs the same way. */
    let agentContext: { readonly dirs: TaskDirs; readonly env: Readonly<Record<string, string>> } | undefined;

    const choose = (options: readonly acp.PermissionOption[], kind: "allow_once" | "reject_once"): acp.RequestPermissionResponse => {
      const option = options.find((o) => o.kind === kind);
      return option === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } };
    };

    const decidePermission = async (request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> => {
      approvalsSeen += 1;
      if (approvalMode === "allow") return choose(request.options, "allow_once");
      if (approvalMode === "reject") return choose(request.options, "reject_once");
      const id = toApprovalId(nextApproval);
      nextApproval += 1;
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        pending.set(id, { id, toolCallId: request.toolCall.toolCallId, title: request.toolCall.title ?? "", since: Date.now(), resolve, options: request.options });
        log({ event: "approval_pending", boxId, approvalId: id });
        signal.addEventListener("abort", () => {
          pending.delete(id);
          resolve({ outcome: { outcome: "cancelled" } });
        });
      });
    };

    const status = (): ControlStatus => {
      const events = driver?.events ?? [];
      const kinds: Record<string, number> = {};
      for (const event of events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      const memory = process.memoryUsage();
      return {
        boxId,
        taskId: handoff.taskId,
        phase: currentPhase(),
        failure: failure ?? null,
        timings,
        handoff: { refused: handoffListener.refused() },
        bridge: { connected: bridge !== undefined, listening: bridgeListener.listening(), refused: bridgeListener.refused(), initPid: bridge?.initPid ?? null, agentUid: bridge?.agentUid ?? null },
        agent: { pid: driver?.pid ?? null, running: driver?.isRunning() ?? false, sessionId: sessionId ?? null, wire: driver?.wire() ?? null },
        turn,
        approvals: { mode: approvalMode, seen: approvalsSeen, pending: [...pending.values()].map((p) => ({ id: p.id, toolCallId: p.toolCallId, title: p.title, since: p.since })) },
        events: { count: events.length, lastSeq: events.at(-1)?.seq ?? 0, kinds },
        keyProxy: {
          calls: proxy.calls.length,
          swapped: proxy.calls.filter((c) => c.keySwapped).length,
          rejected: proxy.calls.filter((c) => !c.keySwapped).length,
          tokens: proxy.calls.reduce((sum, c) => sum + (c.usage === undefined ? 0 : c.usage.input + c.usage.output), 0),
        },
        gitProxy: gitProxy.stats(),
        gitUpstream: gitStub?.stats() ?? null,
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      };
    };

    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });

    const stopTask = async (): Promise<StopResult> => {
      phase = "stopping";
      for (const p of pending.values()) p.resolve({ outcome: { outcome: "cancelled" } });
      pending.clear();
      if (driver !== undefined) await driver.stop(3000);
      const leftover = bridge === undefined ? [] : await bridge.reapAll();
      proxy.revoke();
      phase = "stopped";
      log({ event: "task_stopped", boxId, leftover: leftover.length });
      return { leftover: leftover.map((p) => ({ pid: p.pid, name: p.name })) };
    };

    // The attack checklist as the init's child: the agent's user, the agent's
    // environment and working directory, exactly as `opencode acp` was
    // started. The config (with the secret markers) goes on stdin, never in
    // env or argv.
    const runAttack = async (activeBridge: Bridge, context: NonNullable<typeof agentContext>, body: unknown): Promise<AttackResponse> => {
      const request = attackRequestSchema.parse(body);
      const planted: Record<string, string> = request.plantEnv === undefined ? {} : { [request.plantEnv.name]: request.plantEnv.value };
      const proc = await activeBridge.host.spawn({
        command: env.OSTRA_AGENT_NODE,
        args: [env.OSTRA_ATTACK_CLI, "--json", "--config-stdin"],
        cwd: context.dirs.workspace,
        env: { ...context.env, ...planted },
      });
      log({ event: "attack_started", boxId, pid: proc.pid, planted: request.plantEnv !== undefined });
      proc.stderr.resume();
      const chunks: Buffer[] = [];
      let size = 0;
      const collected = (async (): Promise<void> => {
        for await (const chunk of proc.stdout) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size += buffer.length;
          if (size <= MAX_ATTACK_OUTPUT) chunks.push(buffer);
        }
      })();
      proc.stdin.end(JSON.stringify(request.config));
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, ATTACK_TIMEOUT_MS);
      });
      const exit = await Promise.race([proc.exited, timedOut]);
      clearTimeout(timer);
      if (exit === "timeout") {
        await activeBridge.host.killTree(proc.pid);
        throw new Error("attack checklist timed out");
      }
      await collected;
      if (size > MAX_ATTACK_OUTPUT) throw new Error("attack output too large");
      // The output comes from the agent's container: untrusted until parsed.
      const report = checklistReportSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      log({ event: "attack_finished", boxId, exitCode: exit.code, exposed: report.results.filter((r) => r.outcome === "EXPOSED").length });
      return { exitCode: exit.code, report };
    };

    const control = createServer((req, res) => {
      const handle = async (): Promise<void> => {
        // TCP only: a Unix socket has no remote address, and only the sidecar's container reaches its path.
        if (env.OSTRA_CONTROL_SOCKET === undefined && isInsideBox(req.socket.remoteAddress ?? "", network)) {
          log({ event: "control_refused", boxId, reason: "from inside the box" });
          req.socket.destroy();
          return;
        }
        if (!sameToken(req.headers.authorization, handoff.controlToken)) {
          reply(res, 401, { error: "unauthorized" });
          return;
        }
        const url = new URL(req.url ?? "/", "http://control.local");
        const route = `${req.method ?? "GET"} ${url.pathname}`;
        if (route === "GET /status") {
          reply(res, 200, status());
          return;
        }
        if (route === "POST /config") {
          approvalMode = configSchema.parse(await readJson(req)).approvals;
          reply(res, 200, { approvals: approvalMode });
          return;
        }
        if (route === "POST /turn") {
          const body = turnSchema.parse(await readJson(req));
          if (driver === undefined || sessionId === undefined || currentPhase() !== "ready") {
            reply(res, 409, { error: `not ready (${currentPhase()})` });
            return;
          }
          if (turn.state === "running") {
            reply(res, 409, { error: "a turn is running" });
            return;
          }
          turnCount += 1;
          const startedAt = Date.now();
          const current = turnCount;
          turn = { state: "running", turn: current, startedAt };
          const activeDriver = driver;
          const activeSession = sessionId;
          void activeDriver.prompt(activeSession, textPrompt(body.text)).then(
            (response) => {
              turn = { state: "finished", turn: current, startedAt, endedAt: Date.now(), stopReason: response.stopReason };
            },
            (error: unknown) => {
              turn = { state: "failed", turn: current, startedAt, endedAt: Date.now(), error: error instanceof Error ? error.name : "error" };
            },
          );
          reply(res, 202, { turn: current });
          return;
        }
        if (route === "POST /attack") {
          if (bridge === undefined || agentContext === undefined || currentPhase() !== "ready") {
            reply(res, 409, { error: `not ready (${currentPhase()})` });
            return;
          }
          reply(res, 200, await runAttack(bridge, agentContext, await readJson(req)));
          return;
        }
        const approval = /^POST \/approvals\/(\d+)$/.exec(route);
        if (approval !== null) {
          const parsedId = ApprovalIdSchema.safeParse(Number(approval[1]));
          const entry = parsedId.success ? pending.get(parsedId.data) : undefined;
          if (!parsedId.success || entry === undefined) {
            reply(res, 404, { error: "no such approval" });
            return;
          }
          const id = parsedId.data;
          const { decision } = decisionSchema.parse(await readJson(req));
          pending.delete(id);
          entry.resolve(choose(entry.options, decision));
          log({ event: "approval_answered", boxId, approvalId: id, decision });
          reply(res, 200, { id, decision });
          return;
        }
        if (route === "POST /cancel") {
          if (driver !== undefined && sessionId !== undefined) await driver.cancel(sessionId);
          reply(res, 200, { cancelled: true });
          return;
        }
        if (route === "POST /stop") {
          const result = await stopTask();
          reply(res, 200, result);
          resolveStopped();
          return;
        }
        reply(res, 404, { error: "unknown route" });
      };
      handle().catch((error: unknown) => {
        if (!res.headersSent) reply(res, 400, { error: error instanceof Error ? error.name : "error" });
      });
    });
    await listenOn(control, { socketPath: env.OSTRA_CONTROL_SOCKET, port: env.OSTRA_CONTROL_PORT, host: env.OSTRA_SIDECAR_LISTEN });
    closers.push(
      async () =>
        new Promise<void>((resolve) => {
          control.closeAllConnections();
          control.close(() => {
            resolve();
          });
        }),
    );

    // 3 (wait) and 4. The init connects; prepare and start the agent.
    try {
      bridge = await bridgeListener.connected;
      timings["bridgeAt"] = Date.now();
      phase = "starting_agent";
      const join = env.OSTRA_AGENT_PATH_STYLE === "posix" ? (...parts: string[]) => path.posix.join(...parts) : (...parts: string[]) => path.join(...parts);
      const dirs = taskDirsAt(env.OSTRA_AGENT_TASK_ROOT, join);
      const agentBase = new URL(proxy.agentBaseUrl);
      agentBase.hostname = env.OSTRA_SIDECAR_HOST_FOR_AGENT;
      const providerId = `ostra-${handoff.model.format}`;
      const config = buildOpenCodeConfig({
        providers: [
          {
            kind: "custom",
            id: providerId,
            format: handoff.model.format,
            baseUrl: agentBase.toString().replace(/\/$/, ""),
            keyEnv: KEY_ENV,
            models: [{ id: modelId }],
            ...(handoff.model.kind === "stub" && handoff.model.format === "openai" ? { streamUsage: true } : {}),
          },
        ],
        model: `${providerId}/${modelId}`,
        permissions: PERMISSIONS,
      });
      const gitConfig = [
        "[user]",
        "\tname = ostra agent",
        "\temail = agent@ostra.invalid",
        `[url "${gitProxy.agentPrefix(env.OSTRA_SIDECAR_HOST_FOR_AGENT)}"]`,
        "\tinsteadOf = https://github.com/",
        "[credential]",
        "\thelper =",
        "",
      ].join("\n");
      // dirs plus the one nested dir that holds opencode.json.
      await bridge.prepare([...Object.values(dirs), join(dirs.xdgConfig, "opencode")], [
        { path: join(dirs.xdgConfig, "opencode", "opencode.json"), content: Buffer.from(JSON.stringify(config, null, 2)), mode: 0o600 },
        { path: join(dirs.home, ".gitconfig"), content: Buffer.from(gitConfig), mode: 0o600 },
        { path: join(dirs.workspace, "README.md"), content: Buffer.from("hello from the box fixture\n"), mode: 0o644 },
        { path: join(dirs.workspace, "notes.txt"), content: Buffer.from("notes\n"), mode: 0o644 },
      ]);
      const base = env.OSTRA_AGENT_PATH_STYLE === "posix" ? { PATH: env.OSTRA_AGENT_PATH, LANG: "C.UTF-8" } : undefined;
      const agentEnv = buildAgentEnv({ dirs, fakeKeys: { [KEY_ENV]: proxy.fakeKey }, ...(base === undefined ? {} : { base }) });
      agentContext = { dirs, env: agentEnv };
      driver = await startAcpDriver({
        taskId,
        host: bridge.host,
        launch: { command: env.OSTRA_OPENCODE_COMMAND, args: ["acp"], cwd: dirs.workspace, env: agentEnv },
        decidePermission,
        answerElicitation: declineQuestions,
      });
      const session = await driver.newSession({ cwd: dirs.workspace, mcpServers: [] });
      sessionId = session.sessionId;
      timings["agentReadyAt"] = Date.now();
      phase = "ready";
      log({ event: "box_ready", boxId, readyMs: timings["agentReadyAt"] - (timings["startedAt"] ?? 0) });
    } catch (error) {
      phase = "failed";
      failure = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "error";
      log({ event: "box_failed", boxId, error: error instanceof Error ? error.name : "error" });
    }

    // Run until stopped, or until the bridge drops.
    await Promise.race([stopped, bridge?.closed ?? stopped]);
    if (currentPhase() !== "stopped") await stopTask().catch(() => undefined);
    bridge?.close();
  } finally {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    if (gitStubRoot !== undefined) {
      await rm(gitStubRoot, { recursive: true, force: true }).catch(() => {
        log({ event: "cleanup_failed", boxId });
      });
    }
    log({ event: "sidecar_exit", boxId });
  }
};
