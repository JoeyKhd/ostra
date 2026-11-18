import { randomUUID } from "node:crypto";
import { toApprovalOptions } from "@ostra/adapter-sdk";
import type {
  AgentAdapter,
  AgentProcess,
  AgentSession,
  BoxRef,
  ExecutorAdapter,
  Logger,
  PermissionAnswer,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  RepoPushResult,
} from "@ostra/adapter-sdk";
import { approvalIdSchema, questionIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { CommandBody, StopReason, TaskCredentials, TaskEvent, TaskSpec, TurnId } from "@ostra/protocol";
import type { CommandOutcome, SessionChannel } from "../connection/peer.ts";
import { startGitProxy } from "../sidecar/git-proxy/git-proxy.ts";
import type { GitProxy } from "../sidecar/git-proxy/git-proxy.ts";
import { hiddenRefFor } from "../sidecar/git-proxy/policy.ts";
import { startKeyProxy } from "../sidecar/key-proxy.ts";
import type { KeyProxy, UpstreamRefusal } from "../sidecar/key-proxy.ts";
import { startMcpTools } from "../sidecar/mcp-tools.ts";
import type { McpTools } from "../sidecar/mcp-tools.ts";
import type { AgentRegistry } from "./agents.ts";
import { checkLaunchEnvironment } from "./environment-check.ts";
import type { ServerLink } from "./server-link.ts";

// One task, from its dispatch to its last event (ticket 21, ADR 0029): the same code on every
// executor. The order:
//
//   accept → spec → credentials (memory only) → key proxy, git proxy, MCP tools → create, prepare
//   (setup events) → the agent's launch, checked for credentials → start → session → the turn
//   → commit and push → git.pushed, session.ended → close the agent, revoke the fake key, stop the
//   proxies, release the workspace
//
// Stop cancels the turn, pushes the hidden ref, and ends without `session.ended` (core opens no PR
// for a stopped task). A crash pushes the hidden ref and ends with `session.crashed`. Milestone 1
// has no approval rules: a permission request is answered "once" and recorded as auto-answered.

/** Why milestone 1 answers every permission itself (F-026 brings rules and the panel's answer). */
export const NO_RULES_YET = "no rules until F-026";

/** How much of the push work a stop waits for before it acks anyway. */
const STOP_DEADLINE_MS = 120_000;

export type TaskRunDeps = {
  readonly link: ServerLink;
  readonly executor: ExecutorAdapter;
  readonly agents: AgentRegistry;
  readonly logger: Logger;
  /** Where the proxies and the MCP tools listen: loopback on `host`. */
  readonly listenHost: string;
  readonly advertiseHost?: string;
  /** How long a stopping agent has to exit before its tree is killed. */
  readonly stopGraceMs: number;
  /**
   * The upstream a repo's git proxy forwards to. Default: the repo's clone URL. Tests point it at
   * the git upstream stub.
   */
  readonly gitUpstreamUrl?: (cloneUrl: string) => string;
};

export type DispatchBody = CommandBody<"dispatch">;

export type TaskRun = {
  readonly dispatch: DispatchBody;
  /** Resolves once the run has ended and cleaned up. */
  readonly done: Promise<void>;
  readonly stop: (reason: CommandBody<"stop">["reason"]) => Promise<CommandOutcome>;
  readonly interrupt: () => Promise<CommandOutcome>;
  readonly steer: (body: CommandBody<"steer">) => Promise<CommandOutcome>;
  /** The self-fence: end the agent, keep the workspace, send nothing more. */
  readonly fence: () => Promise<void>;
  /** The server refused the lease: end the agent and release, without pushing. */
  readonly abandon: () => Promise<void>;
};

type Ending =
  | { readonly kind: "finished" }
  | { readonly kind: "stopped" }
  | { readonly kind: "crashed"; readonly error: string }
  | { readonly kind: "fenced" }
  | { readonly kind: "abandoned" };

/** The longest error text an event carries. */
const ERROR_MAX = 4000;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const deferred = <T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** The agent's environment for the task: each repo's non-secret variables (secrets stay in the env files). */
const agentVariables = (spec: TaskSpec): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const repo of spec.environment.repos) {
    for (const variable of repo.variables) {
      out[variable.name] = variable.value;
    }
  }
  // The agent's own commits are the App's bot's too (F-078). These outrank any user.name an agent
  // passes with `git -c`. The checkout's commit-msg hook adds the member's Co-authored-by trailer.
  out["GIT_AUTHOR_NAME"] = spec.gitIdentity.name;
  out["GIT_AUTHOR_EMAIL"] = spec.gitIdentity.email;
  out["GIT_COMMITTER_NAME"] = spec.gitIdentity.name;
  out["GIT_COMMITTER_EMAIL"] = spec.gitIdentity.email;
  return out;
};

export const startTaskRun = (deps: TaskRunDeps, dispatch: DispatchBody): TaskRun => {
  const log = deps.logger.child({ taskId: dispatch.taskId, sessionId: dispatch.sessionId, leaseEpoch: dispatch.leaseEpoch });
  const box: BoxRef = { taskId: dispatch.taskId, boxId: dispatch.boxId };
  let channel: SessionChannel | undefined;
  let emitChain: Promise<void> = Promise.resolve();
  let agent: AgentAdapter | undefined;
  let session: AgentSession | undefined;
  let agentProcess: AgentProcess | undefined;
  let turn: TurnId | undefined;
  let boxCreated = false;
  let dirsCache: { readonly workspaceDir: string; readonly agentDir: string } | undefined;
  let boxPrepared = false;
  let keyProxy: KeyProxy | undefined;
  let gitProxy: GitProxy | undefined;
  let mcp: McpTools | undefined;
  let spec: TaskSpec | undefined;
  /** The task's credentials: in this closure only, never in a variable, argument or file of the runner. */
  let credentials: TaskCredentials | undefined;
  let ending: Ending | undefined;
  const endingSignal = new AbortController();
  const steers: string[] = [];
  const stopDone = deferred<CommandOutcome>();
  const turnAbort = new AbortController();

  const emit = (event: TaskEvent): Promise<void> => {
    const target = channel;
    if (target === undefined || ending?.kind === "abandoned" || ending?.kind === "fenced") {
      return emitChain;
    }
    emitChain = emitChain.then(async () => {
      try {
        await target.emit(event);
      } catch (error) {
        if (error instanceof RangeError) {
          // A payload over the frame cap: keep its place in the log, without the payload.
          await target.emit({ kind: "agent.unknown", acpKind: event.kind, raw: "(over the frame cap: not kept)" });
        } else {
          log.warn("an event couldn't be spooled", { kind: event.kind, error: errorName(error) });
        }
      }
      if (event.kind === "agent.message" || event.kind === "agent.thought") {
        target.endLiveText(event.segmentId);
      }
    });
    return emitChain;
  };

  const end = (value: Ending): void => {
    if (ending === undefined) {
      ending = value;
      endingSignal.abort();
    }
  };

  // ---------- the agent's requests ----------

  const onPermission = (agentSessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> => {
    const options = toApprovalOptions(request);
    const chosen =
      options.find((option) => option.kind === "allow-once") ?? options.find((option) => option.decision !== "deny");
    const toolCallId = toolCallIdSchema.safeParse(request.toolCallId);
    const currentTurn = turn;
    if (chosen === undefined || currentTurn === undefined || signal.aborted || options[0] === undefined) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    const approvalId = approvalIdSchema.parse(randomUUID());
    void emit({
      kind: "approval.requested",
      turnId: currentTurn,
      approvalId,
      toolCallId: toolCallId.success ? toolCallId.data : toolCallIdSchema.parse(`tool-${randomUUID()}`),
      options: [options[0], ...options.slice(1)],
    });
    void emit({ kind: "approval.auto_answered", approvalId, ruleId: NO_RULES_YET });
    log.info("permission answered once", { agentSessionId, decision: chosen.decision });
    return Promise.resolve({ outcome: "selected", optionId: chosen.optionId });
  };

  const onQuestion = async (_agentSessionId: string, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> => {
    const currentTurn = turn;
    if (currentTurn === undefined) {
      return { outcome: "cancelled" };
    }
    const questionId = questionIdSchema.parse(randomUUID());
    void emit({ kind: "question.asked", turnId: currentTurn, questionId, message: request.message, fields: [...request.fields] });
    // Milestone 1's panel shows the question read-only (F-026 answers it): it waits until the turn's
    // time runs out or the turn is cancelled.
    await new Promise<void>((resolve) => {
      if (signal.aborted || turnAbort.signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        resolve();
      }, { once: true });
      turnAbort.signal.addEventListener("abort", () => {
        resolve();
      }, { once: true });
    });
    void emit({ kind: "question.closed", questionId, reason: turnAbort.signal.aborted ? "expired" : "cancelled" });
    return { outcome: "cancelled" };
  };

  // ---------- one turn ----------

  const runTurn = async (text: string, currentSpec: TaskSpec): Promise<{ readonly crashed: string | null }> => {
    if (agent === undefined || session === undefined || agentProcess === undefined) {
      return { crashed: "the agent isn't running" };
    }
    // The agent adapter's base class writes the turn's own events (`turn.started`, `turn.ended`,
    // `turn.failed`) with the agent's; the task host writes them only when the agent's process died
    // and the prompt never came back.
    const turnId = turnIdSchema.parse(randomUUID());
    turn = turnId;
    const runningAgent = agent;
    const runningSession = session;
    const timer = setTimeout(
      () => {
        log.warn("turn reached its maximum minutes: cancelling", { turnMaxMinutes: currentSpec.limits.turnMaxMinutes });
        turnAbort.abort();
        void runningAgent.cancel(runningSession);
      },
      currentSpec.limits.turnMaxMinutes * 60_000,
    );
    timer.unref();
    const exited = agentProcess.exited.then((exit) => ({ kind: "exited" as const, exit }));
    const prompted = runningAgent.prompt(runningSession, turnId, text).then((result) => ({ kind: "prompted" as const, result }));
    const within = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null);
          }, ms).unref();
        }),
      ]);
    const outcome = await Promise.race([prompted, exited]);
    clearTimeout(timer);
    if (outcome.kind === "exited") {
      const error = `the agent's process exited mid-turn (code ${String(outcome.exit.code)}${outcome.exit.signal === null ? "" : `, ${outcome.exit.signal}`})`;
      // The driver sees the closed pipe and ends the prompt, and the base class writes `turn.failed`;
      // if it doesn't come back, the task host writes it.
      if ((await within(prompted, 5_000)) === null) {
        await emit({ kind: "turn.failed", turnId, error });
      }
      return { crashed: error };
    }
    if (!outcome.result.ok) {
      // The connection to the agent failed: did its process exit too?
      const gone = (await within(exited, 1_000)) !== null;
      return { crashed: gone ? "the agent's process exited mid-turn" : `the turn failed: ${outcome.result.error.message}`.slice(0, ERROR_MAX) };
    }
    const stopReason: StopReason = outcome.result.value.stopReason;
    log.info("turn ended", { stopReason });
    return { crashed: null };
  };

  // ---------- endings ----------

  const pushWork = async (currentSpec: TaskSpec, message: string): Promise<{ readonly ok: true; readonly repos: readonly RepoPushResult[] } | { readonly ok: false; readonly error: string }> => {
    const hiddenRef = hiddenRefFor(currentSpec.taskId);
    const pushed = await deps.executor.commitAndPush({
      box,
      message,
      author: currentSpec.gitIdentity,
      coAuthors: currentSpec.coAuthors,
      branchName: currentSpec.branchName,
      hiddenRef,
    });
    if (!pushed.ok) {
      return { ok: false, error: `pushing the task's work failed: ${pushed.error.message}`.slice(0, ERROR_MAX) };
    }
    for (const repo of pushed.value) {
      if (repo.ahead && repo.headSha !== null) {
        await emit({ kind: "git.pushed", repoId: repo.repoId, branch: currentSpec.branchName, headSha: repo.headSha, ref: `refs/heads/${currentSpec.branchName}` });
        await emit({ kind: "git.pushed", repoId: repo.repoId, branch: currentSpec.branchName, headSha: repo.headSha, ref: hiddenRef });
      }
    }
    return { ok: true, repos: pushed.value };
  };

  const endAgent = async (): Promise<void> => {
    if (agent !== undefined && session !== undefined) {
      const closing = agent.close(session);
      await Promise.race([closing.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, deps.stopGraceMs + 5_000))]);
    }
    session = undefined;
    if (boxCreated) {
      await deps.executor.stop({ box, graceMs: deps.stopGraceMs });
    }
  };

  const cleanUp = async (keepWorkspace: boolean): Promise<void> => {
    keyProxy?.revoke();
    await Promise.allSettled([keyProxy?.close(), gitProxy?.close(), mcp?.close()]);
    credentials = undefined;
    if (boxCreated && !keepWorkspace) {
      const released = await deps.executor.release(box);
      if (!released.ok) {
        log.warn("releasing the workspace failed", { code: released.error.code });
      }
    }
    await emitChain;
    channel?.close();
  };

  const crash = async (error: string): Promise<void> => {
    log.warn("session crashed", { reason: error.slice(0, 200) });
    await emit({ kind: "session.crashed", error: error.slice(0, ERROR_MAX) });
  };

  // ---------- the run ----------

  const prepare = async (): Promise<{ readonly ok: true; readonly spec: TaskSpec } | { readonly ok: false; readonly error: string }> => {
    const fetched = await deps.link.fetchSpec(dispatch.taskId, dispatch.leaseEpoch);
    if (!fetched.ok) {
      return { ok: false, error: `couldn't get the task's spec: ${fetched.failure.message}` };
    }
    const taskSpec = fetched.value;
    if (taskSpec.taskId !== dispatch.taskId || taskSpec.sessionId !== dispatch.sessionId || taskSpec.leaseEpoch !== dispatch.leaseEpoch) {
      return { ok: false, error: "the task's spec doesn't match its dispatch" };
    }
    spec = taskSpec;
    const issued = await deps.link.fetchCredentials(dispatch.taskId, dispatch.leaseEpoch);
    if (!issued.ok) {
      return { ok: false, error: `couldn't get the task's credentials: ${issued.failure.message}` };
    }
    credentials = issued.value;
    const held = issued.value;
    const listen = { listenHost: deps.listenHost, ...(deps.advertiseHost === undefined ? {} : { advertiseHost: deps.advertiseHost }) };
    keyProxy = await startKeyProxy({
      taskId: taskSpec.taskId,
      providerId: taskSpec.agent.providerId,
      modelId: taskSpec.agent.modelId,
      model: held.model,
      ...listen,
      fakeKeyTtlMs: (taskSpec.limits.turnMaxMinutes + 30) * 60_000,
      logger: log,
      onUsage: (event) => {
        void emit(event);
      },
      onRateLimited: (limit) => {
        // The protocol has no event for this yet: logged with the provider, for the server's logs.
        log.warn("model provider rate-limited the task", { providerId: taskSpec.agent.providerId, status: limit.status, retryAfterMs: limit.retryAfterMs });
      },
      onUpstreamRefused: (refusal: UpstreamRefusal) => {
        // F-089: an upstream 401 or 403 fails the task at once, with a typed reason.
        end({ kind: "crashed", error: `the model provider refused the task's token (status ${String(refusal.status)})` });
        if (agent !== undefined && session !== undefined) {
          void agent.cancel(session);
        }
      },
    });
    const tokens = new Map(held.repos.map((repo) => [repo.repoId, repo] as const));
    gitProxy = await startGitProxy({
      taskId: taskSpec.taskId,
      branch: taskSpec.branchName,
      mode: taskSpec.kind === "code" ? "read-write" : "read-only",
      repos: taskSpec.repos.map((repo) => ({
        repoId: repo.repoId,
        fullName: repo.fullName,
        cloneUrl: deps.gitUpstreamUrl === undefined ? repo.cloneUrl : deps.gitUpstreamUrl(repo.cloneUrl),
        lfsActionHosts: repo.lfsActionHosts,
        token: async () => {
          const current = tokens.get(repo.repoId);
          // Refreshed through the server a few minutes before it expires (ADR 0030).
          if (current === undefined || current.expiresAt - Date.now() < 5 * 60_000) {
            const fresh = await deps.link.fetchCredentials(dispatch.taskId, dispatch.leaseEpoch);
            if (fresh.ok) {
              for (const item of fresh.value.repos) {
                tokens.set(item.repoId, item);
              }
            }
          }
          const token = tokens.get(repo.repoId)?.gitToken;
          if (token === undefined) {
            throw new Error("no token for the repo");
          }
          return token;
        },
      })),
      logger: log,
      ...listen,
    });
    mcp = await startMcpTools({
      taskId: taskSpec.taskId,
      repos: taskSpec.repos.map((repo) => ({ repoId: repo.repoId, fullName: repo.fullName, prTemplate: repo.prTemplate })),
      taskTitle: taskSpec.title,
      ...listen,
      logger: log,
      onPrText: (event) => {
        void emit(event);
      },
    });
    const created = await deps.executor.create({
      ...box,
      spec: taskSpec,
      proxies: { gitBaseUrl: gitProxy.baseUrl, modelBaseUrl: keyProxy.baseUrl, mcpUrl: mcp.url },
    });
    if (!created.ok) {
      return { ok: false, error: `couldn't create the workspace: ${created.error.message}` };
    }
    boxCreated = true;
    dirsCache = created.value;
    const hasSetup = taskSpec.environment.setupScript !== null && taskSpec.environment.setupScript.trim() !== "";
    if (hasSetup) {
      await emit({ kind: "environment.setup_started" });
    }
    const prepared = await deps.executor.prepare({
      box,
      spec: taskSpec,
      secrets: held.secrets,
      onSetupOutput: (stream, text) => {
        void emit({ kind: "environment.setup_output", stream, text });
      },
      signal: endingSignal.signal,
    });
    if (!prepared.ok) {
      return { ok: false, error: `preparing the workspace failed: ${prepared.error.message}` };
    }
    if (prepared.value.setup !== null) {
      await emit({ kind: "environment.setup_finished", exitCode: prepared.value.setup.exitCode, durationMs: prepared.value.setup.durationMs });
      if (prepared.value.setup.exitCode !== 0) {
        return { ok: false, error: `the environment's setup script failed (exit ${String(prepared.value.setup.exitCode)})` };
      }
    }
    boxPrepared = true;
    return { ok: true, spec: taskSpec };
  };

  const startAgent = async (taskSpec: TaskSpec): Promise<string | null> => {
    const held = credentials;
    if (keyProxy === undefined || mcp === undefined || held === undefined) {
      return "the task's proxies aren't running";
    }
    const created = deps.agents.create(taskSpec.agent.adapter, {
      onLiveText: (delta) => {
        channel?.appendLiveText({ turnId: delta.turnId, segmentId: delta.segmentId, kind: delta.kind }, delta.text);
      },
    });
    if (created === undefined) {
      return `this runner has no agent adapter "${taskSpec.agent.adapter.slice(0, 64)}"`;
    }
    agent = created;
    const state = await deps.executor.state(box);
    if (!state.ok || state.value !== "ready") {
      return "the workspace isn't ready";
    }
    const dirs = workspaceOf();
    const launch = await created.prepareLaunch({
      taskId: taskSpec.taskId,
      sessionId: taskSpec.sessionId,
      workspaceDir: dirs.workspaceDir,
      agentDir: dirs.agentDir,
      model: { endpointModelId: taskSpec.agent.endpointModelId, apiFormat: taskSpec.agent.apiFormat, baseUrl: keyProxy.baseUrl, placeholderKey: keyProxy.fakeKey },
      mcp: { url: mcp.url, bearer: mcp.bearer },
      instructions: taskSpec.agent.instructions,
      extraEnv: agentVariables(taskSpec),
    });
    if (!launch.ok) {
      return `the agent couldn't be launched: ${launch.error.message}`;
    }
    // ADR 0030: the agent's process gets the fake key and the proxy URLs, never a real credential.
    const checked = checkLaunchEnvironment(launch.value.env, held);
    if (!checked.ok) {
      log.error("the agent's environment held a credential: refusing to start it", { variable: checked.variable });
      return `the agent's environment held ${checked.holds} (in ${checked.variable}): refused to start it`;
    }
    const started = await deps.executor.startAgent(box, launch.value);
    if (!started.ok) {
      return `the agent didn't start: ${started.error.message}`;
    }
    agentProcess = started.value;
    const opened = await created.startSession({
      taskId: taskSpec.taskId,
      sessionId: taskSpec.sessionId,
      io: { stdin: started.value.stdin, stdout: started.value.stdout, stderr: started.value.stderr },
      cwd: dirs.workspaceDir,
      mcpServers: [{ name: "ostra", url: mcp.url, headers: { authorization: `Bearer ${mcp.bearer}` } }],
      onEvents: (events) => {
        for (const event of events) {
          void emit(event);
        }
      },
      onPermission,
      onQuestion,
    });
    if (!opened.ok) {
      return `the agent's session didn't start: ${opened.error.message}`;
    }
    session = opened.value;
    return null;
  };

  const workspaceOf = (): { readonly workspaceDir: string; readonly agentDir: string } => {
    if (dirsCache === undefined) {
      throw new Error("the workspace isn't created");
    }
    return dirsCache;
  };

  const main = async (): Promise<void> => {
    channel = await deps.link.openSession({ taskId: dispatch.taskId, sessionId: dispatch.sessionId, leaseEpoch: dispatch.leaseEpoch });
    const prepared = await prepare();
    if (!prepared.ok) {
      end({ kind: "crashed", error: prepared.error });
    }
    const taskSpec = spec;
    if (ending === undefined && taskSpec !== undefined) {
      const failed = await startAgent(taskSpec);
      if (failed !== null) {
        end({ kind: "crashed", error: failed });
      }
    }
    // The turn, and any messages queued for after it.
    let next: string | undefined = taskSpec?.prompt;
    while (ending === undefined && taskSpec !== undefined && next !== undefined) {
      const result = await runTurn(next, taskSpec);
      if (result.crashed !== null) {
        end({ kind: "crashed", error: result.crashed });
        break;
      }
      next = steers.length > 0 ? steers.splice(0).join("\n\n") : undefined;
    }
    end({ kind: "finished" });
    const how: Ending = ending ?? { kind: "finished" };
    switch (how.kind) {
      case "finished": {
        await endAgent();
        if (taskSpec === undefined) {
          break;
        }
        const pushed = await pushWork(taskSpec, taskSpec.title);
        if (!pushed.ok) {
          await crash(pushed.error);
          break;
        }
        const ahead = pushed.repos.some((repo) => repo.ahead);
        await emit({ kind: "session.ended", outcome: ahead ? "with-changes" : "without-changes", repos: pushed.repos.map((repo) => ({ repoId: repo.repoId, ahead: repo.ahead })) });
        break;
      }
      case "stopped": {
        await endAgent();
        if (taskSpec !== undefined && boxPrepared) {
          const pushed = await pushWork(taskSpec, `${taskSpec.title} (stopped: unfinished work)`);
          if (!pushed.ok) {
            log.warn("pushing a stopped task's work failed", { error: pushed.error.slice(0, 200) });
          }
        }
        break;
      }
      case "crashed": {
        await endAgent();
        if (taskSpec !== undefined && boxPrepared) {
          const pushed = await pushWork(taskSpec, `${taskSpec.title} (crashed: unfinished work)`);
          if (!pushed.ok) {
            log.warn("pushing a crashed task's work failed", { error: pushed.error.slice(0, 200) });
          }
        }
        await crash(how.error);
        break;
      }
      case "fenced":
      case "abandoned":
        await endAgent();
        break;
      default:
        how satisfies never;
    }
    await cleanUp(how.kind === "fenced");
    stopDone.resolve({ result: "done" });
    log.info("task run ended", { ending: how.kind });
  };

  const done = main().catch(async (error: unknown) => {
    log.error("task run failed", { error: errorName(error) });
    await crash("the runner failed while running the task").catch(() => undefined);
    await cleanUp(false).catch(() => undefined);
    stopDone.resolve({ result: "done", reason: "failed" });
  });

  return {
    dispatch,
    done,
    stop: async (reason) => {
      log.info("stop requested", { reason });
      end({ kind: "stopped" });
      if (agent !== undefined && session !== undefined) {
        await agent.cancel(session).catch(() => undefined);
      }
      const deadline = new Promise<CommandOutcome>((resolve) => {
        setTimeout(() => {
          resolve({ result: "done", reason: "stop-still-pushing" });
        }, STOP_DEADLINE_MS).unref();
      });
      return Promise.race([stopDone.promise, deadline]);
    },
    interrupt: async () => {
      if (agent === undefined || session === undefined || turn === undefined) {
        return { result: "rejected", reason: "no-turn" };
      }
      await agent.cancel(session);
      return { result: "done" };
    },
    steer: async (body) => {
      if (agent === undefined || session === undefined) {
        return { result: "rejected", reason: "session-not-running" };
      }
      if (body.delivery === "queue" && agent.capabilities.steerMidTurn && session.connection.steeringAdvertised) {
        const steered = await agent.steer(session, body.text);
        return steered.ok ? { result: "done" } : { result: "rejected", reason: steered.error.code };
      }
      // Queued for after the turn; an interrupt cancels the turn first.
      steers.push(body.text);
      if (body.delivery === "interrupt") {
        await agent.cancel(session);
      }
      return { result: "accepted" };
    },
    fence: async () => {
      end({ kind: "fenced" });
      if (agent !== undefined && session !== undefined) {
        await agent.cancel(session).catch(() => undefined);
      }
      await done;
    },
    abandon: async () => {
      end({ kind: "abandoned" });
      if (agent !== undefined && session !== undefined) {
        await agent.cancel(session).catch(() => undefined);
      }
      await done;
    },
  };
};
