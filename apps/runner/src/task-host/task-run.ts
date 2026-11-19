import { randomUUID } from "node:crypto";
import { GIT_GUARD_ENV_NAMES, gitGuardEnv, toApprovalOptions } from "@ostra/adapter-sdk";
import type {
  AgentAdapter,
  AgentLaunch,
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
import { approvalIdSchema, questionIdSchema, runnerLimits, turnIdSchema } from "@ostra/protocol";
import type { CommandBody, StopReason, TaskCredentials, TaskEvent, TaskSpec, TurnId } from "@ostra/protocol";
import type { CommandOutcome, SessionChannel } from "../connection/peer.ts";
import { startGitProxy } from "../sidecar/git-proxy/git-proxy.ts";
import type { GitProxy } from "../sidecar/git-proxy/git-proxy.ts";
import { hiddenRefFor } from "../sidecar/git-proxy/policy.ts";
import { rateLimitHoldSeconds, startKeyProxy } from "../sidecar/key-proxy.ts";
import type { KeyProxy, SpendCapReached, UpstreamRefusal } from "../sidecar/key-proxy.ts";
import { startMcpTools } from "../sidecar/mcp-tools.ts";
import type { McpTools } from "../sidecar/mcp-tools.ts";
import { agentCwd } from "./agent-cwd.ts";
import type { AgentRegistry } from "./agents.ts";
import { checkLaunchEnvironment } from "./environment-check.ts";
import type { ServerLink } from "./server-link.ts";
import { saveSessionArchive } from "./session-archive.ts";
import type { ArchiveContext } from "./session-archive.ts";
import { filesOutsideRepos, outsideKey } from "./workspace-scan.ts";

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
//
// From protocol minor 1 (milestone 2, a spec with `limits.idleMinutes`) a session spans turns
// (ADR 0039). After every turn: commit and push the branch, save each repo's working tree to the
// hidden ref, export the session and upload the archive, then `session.saved`; the agent waits
// for the next turn. A failed export or hidden ref never fails the turn. The box stays when the
// session ends. A minor-0 spec keeps milestone 1's one turn and `session.ended`.

/** Why milestone 1 answers every permission itself (F-026 brings rules and the panel's answer). */
export const NO_RULES_YET = "no rules until F-026";

/** How much of the push work a stop waits for before it acks anyway. */
/** A rate-limit hold is reported again only when it reaches this far past the last one reported. */
const RATE_LIMIT_REPORT_STEP_MS = 5_000;

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
  /** The clock the after-turn figures read. Default: `Date.now`. */
  readonly now?: () => number;
  /** The idle timer's clock (spec section 8: tests run it in seconds). Default: the real one. */
  readonly timers?: TaskTimers;
};

/** A timer port: `after` calls `fire` once, `ms` from now, unless the answer is called first. */
export type TaskTimers = { readonly after: (ms: number, fire: () => void) => () => void };

export const realTimers: TaskTimers = {
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

/** A box a session left kept (ADR 0039): its next session can resume in it, or a `release` removes it. */
export type KeptBox = {
  readonly box: BoxRef;
  /** The agent adapter that ran in it, and its own session there, for `session/load` on a resume. */
  readonly agentAdapter: string;
  readonly agentSessionId: string | null;
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
  /**
   * Ends a session that waits between turns, as its idle timer would (a `release`, ticket 23).
   * Resolves once the run is done; `false`, and nothing ends, while a turn runs.
   */
  readonly endBetweenTurns: () => Promise<boolean>;
  /** Once `done`: the box the run left kept, if it did. */
  readonly keptBox: () => KeptBox | undefined;
};

type Ending =
  | { readonly kind: "finished" }
  /** Milestone 2: the session ended between turns (the idle timer, ticket 23): `session.ended`, the box kept. */
  | { readonly kind: "idle" }
  /**
   * Milestone 2: the key proxy reached the task's spend cap (ticket 25): the turn ends, its work is
   * saved, `session.limit_reached` goes up, and the session ends as a stop does.
   */
  | { readonly kind: "limit"; readonly limit: "spend-cap"; readonly observed: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "crashed"; readonly error: string }
  | { readonly kind: "fenced" }
  | { readonly kind: "abandoned" };

/** The longest error text an event carries. */
const ERROR_MAX = 4000;

/** How long the agent's fake key lasts in a session across turns: the session's end revokes it first. */
const ACROSS_TURNS_KEY_TTL_MS = 24 * 60 * 60_000;

/** A session spans turns from minor 1 (ADR 0039): its spec carries the idle timer, and the server reads `session.saved`. */
const spansTurns = (taskSpec: TaskSpec, channel: SessionChannel | undefined): boolean =>
  taskSpec.limits.idleMinutes !== undefined && channel?.supports("session.saved") === true;

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
      // The git guard is the runner's: no repo variable can set it (it is overlaid on the launch too).
      if (!GIT_GUARD_ENV_NAMES.some((guarded) => guarded === variable.name)) {
        out[variable.name] = variable.value;
      }
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
  let dirsCache: { readonly workspaceDir: string; readonly agentDir: string; readonly gitConfig: string } | undefined;
  let boxPrepared = false;
  let keyProxy: KeyProxy | undefined;
  let gitProxy: GitProxy | undefined;
  /** When the last rate-limit event's hold ends, in ms since the epoch: later 429s inside it say nothing new. */
  let rateLimitedUntil = 0;
  let mcp: McpTools | undefined;
  let spec: TaskSpec | undefined;
  /** The task's credentials: in this closure only, never in a variable, argument or file of the runner. */
  let credentials: TaskCredentials | undefined;
  let ending: Ending | undefined;
  const endingSignal = new AbortController();
  const steers: string[] = [];
  const stopDone = deferred<CommandOutcome>();
  /** The running turn's own abort: its time ran out, or it was cancelled to end the session. */
  let turnAbort = new AbortController();
  /** A turn is between its prompt and its end. */
  let turnRunning = false;
  /** The session spans turns (milestone 2): set once the spec is read. */
  let acrossTurns = false;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;
  /** Set when the run ends with its box kept. */
  let kept: KeptBox | undefined;
  /** The idle limit of a session across turns, in ms. */
  const idleMs = (taskSpec: TaskSpec): number => (taskSpec.limits.idleMinutes ?? runnerLimits.idleMinutes) * 60_000;
  /** Wakes the session waiting between turns: a message came, or the session is ending. */
  let wake: (() => void) | undefined;
  const nudge = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };

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
      nudge();
    }
  };

  // ---------- the agent's requests ----------

  const onPermission = (agentSessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> => {
    const options = toApprovalOptions(request);
    const chosen =
      options.find((option) => option.kind === "allow-once") ?? options.find((option) => option.decision !== "deny");
    const currentTurn = turn;
    if (chosen === undefined || currentTurn === undefined || signal.aborted || options[0] === undefined) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    const approvalId = approvalIdSchema.parse(randomUUID());
    void emit({
      kind: "approval.requested",
      turnId: currentTurn,
      approvalId,
      toolCallId: request.toolCallId,
      options: [options[0], ...options.slice(1)],
    });
    void emit({ kind: "approval.auto_answered", approvalId, ruleId: NO_RULES_YET });
    log.info("permission answered once", { agentSessionId, decision: chosen.decision });
    return Promise.resolve({ outcome: "selected", optionId: chosen.optionId });
  };

  const onQuestion = async (_agentSessionId: string, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> => {
    const currentTurn = turn;
    const thisTurn = turnAbort;
    if (currentTurn === undefined) {
      return { outcome: "cancelled" };
    }
    const questionId = questionIdSchema.parse(randomUUID());
    void emit({ kind: "question.asked", turnId: currentTurn, questionId, message: request.message, fields: [...request.fields] });
    // A turn that waits on a person follows the idle timer (ADR 0039, ticket 23): when it fires, the
    // turn is cancelled, its work saved, and the session ends. The needs-you item stays on the server.
    const waitingSpec = spec;
    const disarm =
      acrossTurns && waitingSpec !== undefined
        ? timers.after(idleMs(waitingSpec), () => {
            log.info("a turn waited on a person past the idle limit: ending the session", { idleMinutes: waitingSpec.limits.idleMinutes ?? null });
            end({ kind: "idle" });
            thisTurn.abort();
            if (agent !== undefined && session !== undefined) {
              void agent.cancel(session).catch(() => undefined);
            }
          })
        : () => undefined;
    // Milestone 1's panel shows the question read-only (F-026 answers it): it waits until the turn's
    // time runs out or the turn is cancelled.
    await new Promise<void>((resolve) => {
      if (signal.aborted || thisTurn.signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        resolve();
      }, { once: true });
      thisTurn.signal.addEventListener("abort", () => {
        resolve();
      }, { once: true });
    });
    disarm();
    void emit({ kind: "question.closed", questionId, reason: thisTurn.signal.aborted ? "expired" : "cancelled" });
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
    turnOrdinal += 1;
    unsaved = true;
    turnRunning = true;
    const thisTurn = new AbortController();
    turnAbort = thisTurn;
    const runningAgent = agent;
    const runningSession = session;
    const timer = setTimeout(
      () => {
        log.warn("turn reached its maximum minutes: cancelling", { turnMaxMinutes: currentSpec.limits.turnMaxMinutes });
        thisTurn.abort();
        void runningAgent.cancel(runningSession);
      },
      currentSpec.limits.turnMaxMinutes * 60_000,
    );
    timer.unref();
    try {
      return await promptTurn(text, turnId, runningAgent, runningSession, agentProcess);
    } finally {
      clearTimeout(timer);
      turnRunning = false;
      turn = undefined;
    }
  };

  const promptTurn = async (
    text: string,
    turnId: TurnId,
    runningAgent: AgentAdapter,
    runningSession: AgentSession,
    runningProcess: AgentProcess,
  ): Promise<{ readonly crashed: string | null }> => {
    const exited = runningProcess.exited.then((exit) => ({ kind: "exited" as const, exit }));
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

  // ---------- files outside every repo (Q133) ----------

  /** The last set reported: an event goes up only when it changes. The names are never logged. */
  let outsideReported = outsideKey([], { repos: [] });
  const scanOutsideRepos = async (currentSpec: TaskSpec): Promise<void> => {
    if (!boxPrepared || channel?.supports("workspace.files_outside_repos") !== true) {
      return;
    }
    const listed = await deps.executor.listWorkspaceRoot(box);
    if (!listed.ok) {
      log.warn("listing the workspace root failed", { code: listed.error.code });
      return;
    }
    const key = outsideKey(listed.value, currentSpec);
    if (key === outsideReported) {
      return;
    }
    outsideReported = key;
    const found = filesOutsideRepos(listed.value, currentSpec);
    log.info("files outside the repos changed", { count: found.paths.length + found.more });
    await emit({ kind: "workspace.files_outside_repos", paths: [...found.paths], more: found.more });
  };

  // ---------- endings ----------

  const pushWork = async (
    currentSpec: TaskSpec,
    message: string,
    options: { readonly hiddenRefEvent: boolean } = { hiddenRefEvent: true },
  ): Promise<{ readonly ok: true; readonly repos: readonly RepoPushResult[] } | { readonly ok: false; readonly error: string }> => {
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
        if (options.hiddenRefEvent) {
          await emit({ kind: "git.pushed", repoId: repo.repoId, branch: currentSpec.branchName, headSha: repo.headSha, ref: hiddenRef });
        }
      }
    }
    return { ok: true, repos: pushed.value };
  };

  // ---------- after every turn (milestone 2, ticket 22) ----------

  /** The turn within the session, from 1. */
  let turnOrdinal = 0;
  /** A turn ran since the work was last saved. */
  let unsaved = false;
  /** Each repo's head and whether it's ahead after the last push, for `session.ended`. */
  let lastPushed: readonly RepoPushResult[] = [];

  /** Where the session's archive is made: the box, the agent, the folder its session opened on. */
  const archiveContext = (currentSpec: TaskSpec): ArchiveContext | undefined => {
    if (agent === undefined || dirsCache === undefined) {
      return undefined;
    }
    return {
      executor: deps.executor,
      agent,
      link: deps.link,
      box,
      taskId: currentSpec.taskId,
      leaseEpoch: currentSpec.leaseEpoch,
      agentDir: dirsCache.agentDir,
      workspaceDir: agentCwd(dirsCache.workspaceDir, currentSpec.repos),
    };
  };

  /**
   * ADR 0039's order after a turn: the branch, the hidden ref, the archive, then `session.saved`.
   * Only the branch's push can fail the session; its error comes back for the caller.
   */
  const saveWork = async (currentSpec: TaskSpec, message: string): Promise<{ readonly pushError: string | null }> => {
    unsaved = false;
    const startedAt = now();
    const ordinal = Math.max(1, turnOrdinal);
    // 1. The task's branch in every repo: what the PR is made of.
    const pushed = await pushWork(currentSpec, message, { hiddenRefEvent: false });
    if (pushed.ok) {
      lastPushed = pushed.repos;
    } else {
      log.warn("pushing the branch after the turn failed", { turnOrdinal: ordinal, error: pushed.error.slice(0, 200) });
    }
    // 2. Each repo's working tree to the hidden ref, forced (uncommitted and untracked work included).
    const wip = await deps.executor.saveWorkInProgress({ box, turnOrdinal: ordinal });
    if (!wip.ok) {
      log.warn("saving the hidden ref failed", { turnOrdinal: ordinal, code: wip.error.code, reason: wip.error.message.slice(0, 200) });
    }
    const savedRepos = new Map(wip.ok ? wip.value.map((repo) => [repo.repoId, repo] as const) : []);
    const hiddenRef = hiddenRefFor(currentSpec.taskId);
    for (const repo of currentSpec.repos) {
      const sha = savedRepos.get(repo.repoId)?.sha ?? null;
      if (sha !== null) {
        await emit({ kind: "git.pushed", repoId: repo.repoId, branch: currentSpec.branchName, headSha: sha, ref: hiddenRef });
      }
    }
    // 3. The session archive: export, gzip, upload with its digest.
    const context = archiveContext(currentSpec);
    const archived =
      context === undefined || session === undefined
        ? { ok: false as const, reason: "no agent session to export" }
        : await saveSessionArchive(context, session.agentSessionId, ordinal);
    if (!archived.ok) {
      log.warn("the session archive wasn't saved", { turnOrdinal: ordinal, reason: archived.reason.slice(0, 300) });
    }
    // 4. What left the box.
    const pushedRepos = new Map(pushed.ok ? pushed.repos.map((repo) => [repo.repoId, repo] as const) : []);
    await emit({
      kind: "session.saved",
      turnOrdinal: ordinal,
      repos: currentSpec.repos.map((repo) => ({
        repoId: repo.repoId,
        headSha: pushedRepos.get(repo.repoId)?.headSha ?? null,
        ahead: pushedRepos.get(repo.repoId)?.ahead ?? false,
        hiddenRefSha: savedRepos.get(repo.repoId)?.sha ?? null,
      })),
      archive: archived.ok ? archived.archive : null,
    });
    // The working figures (spike 2, gotcha 13): one line per turn, numbers only.
    log.info("work saved after the turn", {
      turnOrdinal: ordinal,
      afterTurnMs: now() - startedAt,
      archiveBytes: archived.ok ? archived.archive.size : null,
      hiddenRefs: [...savedRepos.values()].filter((repo) => repo.sha !== null).length,
      branchPushed: pushed.ok,
    });
    return { pushError: pushed.ok ? null : pushed.error };
  };

  /** The messages queued while a turn ran, as the next turn's prompt. */
  const takeQueued = (): string | undefined => (steers.length > 0 ? steers.splice(0).join("\n\n") : undefined);

  /**
   * Between turns: the next turn's text, or `undefined` once the session is ending. The idle timer
   * runs while it waits (F-096): `limits.idleMinutes` with no new turn, and the session ends. A new
   * turn before then starts the timer again the next time the session waits.
   */
  const nextTurn = async (taskSpec: TaskSpec): Promise<string | undefined> => {
    const disarm = timers.after(idleMs(taskSpec), () => {
      log.info("the session was idle for its limit: ending it", { idleMinutes: taskSpec.limits.idleMinutes ?? null });
      end({ kind: "idle" });
    });
    try {
      while (ending === undefined) {
        const queued = takeQueued();
        if (queued !== undefined) {
          return queued;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return undefined;
    } finally {
      disarm();
    }
  };

  /** The commit message for what a turn left, by how the session is going. */
  const leftoverMessage = (currentSpec: TaskSpec): string => {
    switch (ending?.kind) {
      case "stopped":
        return `${currentSpec.title} (stopped: unfinished work)`;
      case "crashed":
        return `${currentSpec.title} (crashed: unfinished work)`;
      case "limit":
        return `${currentSpec.title} (spend cap reached: unfinished work)`;
      case undefined:
      case "finished":
      case "idle":
      case "fenced":
      case "abandoned":
        return currentSpec.title;
      default:
        return ending satisfies never;
    }
  };

  /** How the session is ending, read fresh: commands end it between awaits. */
  const endingNow = (): Ending | undefined => ending;

  /** Milestone 2's session: turn after turn, the work saved after each, until the session ends. */
  const runAcrossTurns = async (taskSpec: TaskSpec): Promise<void> => {
    let next: string | undefined = taskSpec.prompt;
    while (ending === undefined) {
      next ??= await nextTurn(taskSpec);
      if (next === undefined) {
        break;
      }
      const result = await runTurn(next, taskSpec);
      next = undefined;
      if (result.crashed !== null) {
        end({ kind: "crashed", error: result.crashed });
      }
      // `end` runs from the commands too, so the session is asked again after each await.
      const current = endingNow();
      if (current?.kind === "fenced" || current?.kind === "abandoned") {
        break;
      }
      await scanOutsideRepos(taskSpec);
      // A stopped or crashed turn's work is saved too: the hidden ref holds it.
      const saved = await saveWork(taskSpec, leftoverMessage(taskSpec));
      if (saved.pushError !== null && endingNow() === undefined) {
        end({ kind: "crashed", error: saved.pushError });
      }
      next = takeQueued();
    }
  };

  /** How a session across turns ends. The box stays for a reopen (ADR 0039), unless it never got ready. */
  const finishAcrossTurns = async (taskSpec: TaskSpec, how: Ending): Promise<void> => {
    switch (how.kind) {
      case "finished":
      case "idle": {
        await endAgent();
        const repos = lastPushed.length > 0 ? lastPushed : taskSpec.repos.map((repo) => ({ repoId: repo.repoId, headSha: null, ahead: false }));
        await emit({
          kind: "session.ended",
          outcome: repos.some((repo) => repo.ahead) ? "with-changes" : "without-changes",
          repos: repos.map((repo) => ({ repoId: repo.repoId, ahead: repo.ahead })),
        });
        return;
      }
      case "stopped":
      case "limit":
      case "crashed": {
        await endAgent();
        // A stop or crash outside a turn: what the turn left was saved already, unless no turn ran.
        if (boxPrepared && unsaved) {
          await scanOutsideRepos(taskSpec);
          await saveWork(taskSpec, leftoverMessage(taskSpec));
        }
        if (how.kind === "crashed") {
          await crash(how.error);
        }
        if (how.kind === "limit") {
          // The session ends as a stop does, with no `session.ended`: core records the limit (F-068).
          await emit({ kind: "session.limit_reached", limit: how.limit, observed: how.observed });
        }
        return;
      }
      case "fenced":
      case "abandoned":
        await endAgent();
        return;
      default:
        how satisfies never;
    }
  };

  /** The agent's own session ID, kept past its close: a resume loads it (ticket 24). */
  let lastAgentSessionId: string | undefined;

  const endAgent = async (): Promise<void> => {
    if (session !== undefined) {
      lastAgentSessionId = session.agentSessionId;
    }
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
      // Milestone 1's one-turn session: the workspace goes when the session ends. Ticket 23 keeps it.
      const released = await deps.executor.release(box, "requested");
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
    acrossTurns = spansTurns(taskSpec, channel);
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
      fakeKeyTtlMs: acrossTurns ? ACROSS_TURNS_KEY_TTL_MS : (taskSpec.limits.turnMaxMinutes + 30) * 60_000,
      logger: log,
      onUsage: (event) => {
        void emit(event);
      },
      onRateLimited: (limit) => {
        log.warn("model provider rate-limited the task", { providerId: taskSpec.agent.providerId, status: limit.status, retryAfterMs: limit.retryAfterMs });
        // F-089: the server holds new dispatches on the provider. A hold is reported again only
        // when it reaches well past the last one, so an agent retrying into a limit doesn't fill its log.
        const retryAfterSeconds = rateLimitHoldSeconds(limit.retryAfterMs);
        const until = Date.now() + retryAfterSeconds * 1000;
        if (until >= rateLimitedUntil + RATE_LIMIT_REPORT_STEP_MS) {
          rateLimitedUntil = until;
          void emit({ kind: "provider.rate_limited", providerId: taskSpec.agent.providerId, retryAfterSeconds });
        }
      },
      onUpstreamRefused: (refusal: UpstreamRefusal) => {
        // F-089: an upstream 401 or 403 fails the task at once, with a typed reason.
        end({ kind: "crashed", error: `the model provider refused the task's token (status ${String(refusal.status)})` });
        if (agent !== undefined && session !== undefined) {
          void agent.cancel(session);
        }
      },
      // F-068: the key proxy enforces the task's spend cap, in a session across turns only (minor 1).
      ...(acrossTurns && taskSpec.limits.spendCap !== undefined
        ? {
            spendCap: taskSpec.limits.spendCap,
            onSpendCapReached: (reached: SpendCapReached) => {
              log.info("the spend cap is reached: ending the turn", { unit: reached.unit, observed: reached.observed });
              end({ kind: "limit", limit: "spend-cap", observed: reached.observed });
              if (agent !== undefined && session !== undefined) {
                void agent.cancel(session).catch(() => undefined);
              }
            },
          }
        : {}),
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
    // ADR 0029: git run by the agent outside a checkout reads the task's config, not the machine's
    // system or global one (on Git for Windows, the system config names the member's credential
    // manager). This is the runner's own overlay, so it holds for every agent adapter.
    // F-025: with one repo the agent starts in its checkout (the process, and the session below), so a
    // relative path in the prompt lands in the repo; the adapter's `workspaceDir` stays the root.
    const cwd = agentCwd(dirs.workspaceDir, taskSpec.repos);
    const guarded: AgentLaunch = { ...launch.value, cwd, env: { ...launch.value.env, ...gitGuardEnv(dirs.gitConfig) } };
    // ADR 0030: the agent's process gets the fake key and the proxy URLs, never a real credential.
    const checked = checkLaunchEnvironment(guarded.env, held);
    if (!checked.ok) {
      log.error("the agent's environment held a credential: refusing to start it", { variable: checked.variable });
      return `the agent's environment held ${checked.holds} (in ${checked.variable}): refused to start it`;
    }
    const started = await deps.executor.startAgent(box, guarded);
    if (!started.ok) {
      return `the agent didn't start: ${started.error.message}`;
    }
    agentProcess = started.value;
    const opened = await created.startSession({
      taskId: taskSpec.taskId,
      sessionId: taskSpec.sessionId,
      io: { stdin: started.value.stdin, stdout: started.value.stdout, stderr: started.value.stderr },
      cwd,
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

  const workspaceOf = (): { readonly workspaceDir: string; readonly agentDir: string; readonly gitConfig: string } => {
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
    if (taskSpec !== undefined && acrossTurns) {
      if (ending === undefined) {
        await runAcrossTurns(taskSpec);
      }
      const how: Ending = ending ?? { kind: "idle" };
      await finishAcrossTurns(taskSpec, how);
      // The box stays for the next session, unless it never got ready or the server refused the lease.
      const keep = how.kind === "fenced" || (boxPrepared && how.kind !== "abandoned");
      await cleanUp(keep);
      if (keep && boxCreated) {
        kept = { box, agentAdapter: taskSpec.agent.adapter, agentSessionId: lastAgentSessionId ?? null };
      }
      stopDone.resolve({ result: "done" });
      log.info("task run ended", { ending: how.kind, turns: turnOrdinal });
      return;
    }
    // Milestone 1 (a minor-0 spec): the turn, and any messages queued for after it.
    let next: string | undefined = taskSpec?.prompt;
    while (ending === undefined && taskSpec !== undefined && next !== undefined) {
      const result = await runTurn(next, taskSpec);
      if (result.crashed !== null) {
        end({ kind: "crashed", error: result.crashed });
        break;
      }
      await scanOutsideRepos(taskSpec);
      next = takeQueued();
    }
    end({ kind: "finished" });
    const how: Ending = ending ?? { kind: "finished" };
    switch (how.kind) {
      case "idle":
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
      case "limit":
      case "stopped": {
        await endAgent();
        if (taskSpec !== undefined) {
          await scanOutsideRepos(taskSpec);
        }
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
      if (agent === undefined || session === undefined || ending !== undefined) {
        return { result: "rejected", reason: "session-not-running" };
      }
      if (!turnRunning) {
        // Between turns (milestone 2): the message is the next turn.
        steers.push(body.text);
        nudge();
        return { result: "accepted" };
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
    endBetweenTurns: async () => {
      if (turnRunning) {
        return false;
      }
      end({ kind: "idle" });
      await done;
      return true;
    },
    keptBox: () => kept,
  };
};
