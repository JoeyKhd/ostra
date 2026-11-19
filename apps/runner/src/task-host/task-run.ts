import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { approvalIdSchema, denyPrompt, firstMatchingTaskRule, questionIdSchema, runnerLimits, turnIdSchema } from "@ostra/protocol";
import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequestSubject,
  CheckId,
  CheckStatus,
  CommandBody,
  QuestionId,
  RuleContext,
  TaskRule,
  TurnMode,
  HiddenRefOutcome,
  RestoreOrigin,
  SessionId,
  StopReason,
  TaskCredentials,
  TaskEvent,
  TaskSpec,
  TurnId,
} from "@ostra/protocol";
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
import { allowOnce, decidePermission, rejectOnce, TASK_RULE_NAME } from "./permission-decision.ts";
import { loadSessionArchive, saveSessionArchive } from "./session-archive.ts";
import { writeTicketFiles } from "./ticket-files.ts";
import type { ArchiveContext } from "./session-archive.ts";
import { runTurnChecks } from "./turn-checks.ts";
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
// for a stopped task). A crash pushes the hidden ref and ends with `session.crashed`.
//
// Milestone 3 (ticket 30, ADR 0049): a permission request goes through the task rules, then the
// profile's rules (`permission-decision.ts`). What needs a person is held, at most 15 minutes,
// until an `approval-answer`; a deny ends the turn, closes the other held requests and re-prompts
// with the reason as data (ADR 0032). A question is held for a `question-answer` the same way.
//
// From protocol minor 1 (milestone 2, a spec with `limits.idleMinutes`) a session spans turns
// (ADR 0039). After every turn: commit and push the branch, save each repo's working tree to the
// hidden ref, export the session and upload the archive, then `session.saved`; the agent waits
// for the next turn. A failed export or hidden ref never fails the turn. The box stays when the
// session ends. A minor-0 spec keeps milestone 1's one turn and `session.ended`.
//
// A reopen (ticket 24) follows the spec's `restore.origin`, and never chooses the step itself:
// `resumed` takes the box this runner kept and loads the agent's own session in it; `restored`
// makes a fresh box, restores each repo's hidden ref and imports the session archive; `rebuilt`
// restores the hidden refs and sends the rebuild template (the spec's `prompt`) as the first turn.
// A step that can't be done falls back to `rebuilt` and says why. Then each pending message is a
// turn of its own, in order.

/**
 * The rule an approval is recorded as auto-answered by when the server is below minor 2 and can't
 * send an answer: it's answered "once", as milestone 1 did (spec section 5.1).
 */
export const PEER_TOO_OLD = "peer-too-old";

/** An approval held for a person's answer. */
type HeldApproval = {
  readonly approvalId: ApprovalId;
  /** What it touches, for a later task rule. The agent's text: never logged. */
  readonly subject: ApprovalRequestSubject | null;
  readonly options: readonly ApprovalOption[];
  /** Answers the agent, once. */
  readonly settle: (answer: PermissionAnswer) => void;
  /** Answers "cancelled" and reports the approval closed, unless it was answered already. */
  readonly close: (reason: "cancelled" | "expired") => void;
};

/** A question held for the driver's answer. */
type HeldQuestion = {
  readonly questionId: QuestionId;
  readonly answer: (answers: Readonly<Record<string, string>>) => void;
  readonly close: (reason: "cancelled" | "expired") => void;
};

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
  /**
   * Ticket 24, `resumed`: the box a session of this task left kept on this runner, handed to the
   * new session (a session still waiting in it ends first). `undefined` when there's none.
   */
  readonly claimKeptBox?: (box: BoxRef, sessionId: SessionId) => Promise<KeptBox | undefined>;
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
  /** Minor 2 (ticket 30): a person's answer to a held approval. */
  readonly answerApproval: (body: CommandBody<"approval-answer">) => Promise<CommandOutcome>;
  /** Minor 2 (ticket 30): the driver's answer to a held question. */
  readonly answerQuestion: (body: CommandBody<"question-answer">) => Promise<CommandOutcome>;
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
  /** How a reopened session came back (ticket 24), for `session.restored`. `undefined` for a new one. */
  let restored:
    | {
        origin: RestoreOrigin;
        hiddenRef: HiddenRefOutcome;
        previousBox: "kept" | undefined;
        fallbackReason: string | undefined;
        /** The agent's own session to load: the kept box's, or the imported archive's. */
        resumeId: string | undefined;
      }
    | undefined;
  /** A reopen's pending messages, each a turn of its own, in order (F-047). Never logged. */
  const pending: string[] = [];
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

  // ---------- the agent's requests (F-026, ticket 30) ----------

  /** The session's "for this task" rules: the spec's, then each one an `allow_task` answer added. */
  const taskRules: TaskRule[] = [];
  /** Approvals waiting on a person, by ID. Their subjects are the agent's text: never logged. */
  const heldApprovals = new Map<ApprovalId, HeldApproval>();
  /** Questions waiting on the driver, by ID. */
  const heldQuestions = new Map<QuestionId, HeldQuestion>();
  /**
   * The runner's own next prompt, before any queued message: a deny's re-prompt (ADR 0032), or a
   * plan's answer (ticket 31). Never logged.
   */
  let ownPrompt: string | undefined;
  /** The session's mode (F-063): plan mode comes with ticket 31. */
  const mode: TurnMode = "build";
  const waitMs = runnerLimits.approvalWaitMinutes * 60_000;

  /** What the rules read from the spec: the MCP servers and which are read-only. */
  const ruleContext = (): RuleContext => ({
    mcpServers: (spec?.agent.mcpServers ?? []).map((server) => ({ name: server.name, readOnly: server.readOnly })),
  });

  /** Every held request answered "cancelled", each reported closed with `reason`. */
  const closeHeld = (reason: "cancelled" | "expired"): void => {
    for (const held of [...heldApprovals.values()]) {
      held.close(reason);
    }
    for (const held of [...heldQuestions.values()]) {
      held.close(reason);
    }
  };

  /**
   * Cancels the running turn. The held requests are answered first: an agent that waits on one
   * can't end its turn until it has its answer (ACP's cancel).
   */
  const cancelTurn = async (): Promise<void> => {
    closeHeld("cancelled");
    if (agent !== undefined && session !== undefined) {
      await agent.cancel(session).catch(() => undefined);
    }
  };

  /** A held request's wait ran out (15 minutes): the turn is cancelled, and the item stays open on the server. */
  const expire = (what: "approval" | "question"): void => {
    log.info("a held request waited its limit: cancelling the turn", { what, waitMinutes: runnerLimits.approvalWaitMinutes });
    void cancelTurn();
  };

  const onPermission = (agentSessionId: string, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> => {
    const options = toApprovalOptions(request);
    const currentTurn = turn;
    const first = options[0];
    if (currentTurn === undefined || signal.aborted || first === undefined) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    const listed: [ApprovalOption, ...ApprovalOption[]] = [first, ...options.slice(1)];
    const approvalId = approvalIdSchema.parse(randomUUID());
    // A server below minor 2 can't send an answer: milestone 1's "once", recorded so (spec section 5.1).
    if (channel?.supports("plan.proposed") !== true) {
      void emit({ kind: "approval.requested", turnId: currentTurn, approvalId, toolCallId: request.toolCallId, options: listed });
      void emit({ kind: "approval.auto_answered", approvalId, ruleId: PEER_TOO_OLD });
      log.info("permission answered once: the server can't answer it", { agentSessionId });
      return Promise.resolve(allowOnce(options));
    }
    const decision = decidePermission({
      request,
      mode,
      approvalRules: spec?.agent.approvalRules ?? [],
      taskRules,
      context: ruleContext(),
      permissionRules: agent?.capabilities.permissionRules ?? "runner-only",
    });
    const subject = request.subject ?? null;
    const shown = subject === null ? {} : { subject: { kind: subject.subject.kind, value: subject.subject.value.slice(0, 8192) } };
    switch (decision.kind) {
      case "refuse-in-plan":
        log.info("a plan turn's request was refused", { tool: subject?.tool ?? null, toolKind: request.toolKind ?? null });
        return Promise.resolve(rejectOnce(options));
      case "allow":
        return Promise.resolve(allowOnce(options));
      case "task-rule":
        void emit({
          kind: "approval.requested",
          turnId: currentTurn,
          approvalId,
          toolCallId: request.toolCallId,
          options: listed,
          rule: { source: "task", ruleId: decision.rule.ruleId, name: TASK_RULE_NAME },
          ...shown,
        });
        void emit({ kind: "approval.auto_answered", approvalId, ruleId: decision.rule.ruleId });
        log.info("permission answered by a task rule", { approvalId, ruleId: decision.rule.ruleId });
        return Promise.resolve(allowOnce(options));
      case "ask":
        break;
      default:
        return decision satisfies never;
    }
    void emit({
      kind: "approval.requested",
      turnId: currentTurn,
      approvalId,
      toolCallId: request.toolCallId,
      options: listed,
      rule: decision.rule,
      ...shown,
    });
    log.info("permission held for a person", { approvalId, ruleId: decision.rule?.ruleId ?? null, tool: subject?.tool ?? null });
    return new Promise<PermissionAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: PermissionAnswer): void => {
        if (settled) {
          return;
        }
        settled = true;
        disarm();
        heldApprovals.delete(approvalId);
        resolve(answer);
      };
      const close = (reason: "cancelled" | "expired"): void => {
        if (!settled) {
          void emit({ kind: "approval.closed", approvalId, reason });
        }
        settle({ outcome: "cancelled" });
      };
      const disarm = timers.after(waitMs, () => {
        close("expired");
        expire("approval");
      });
      signal.addEventListener("abort", () => {
        close("cancelled");
      }, { once: true });
      heldApprovals.set(approvalId, { approvalId, subject, options, settle, close });
    });
  };

  /** `approval-answer` (ADR 0036): "once" for both allows, "reject" for a deny, which ends the turn and re-prompts. */
  const answerApproval = async (body: CommandBody<"approval-answer">): Promise<CommandOutcome> => {
    const held = heldApprovals.get(body.approvalId);
    if (held === undefined) {
      return { result: "rejected", reason: "no-pending-approval" };
    }
    switch (body.decision) {
      case "allow_once":
        held.settle(allowOnce(held.options));
        log.info("approval answered", { approvalId: body.approvalId, decision: body.decision });
        return { result: "done" };
      case "allow_task": {
        held.settle(allowOnce(held.options));
        const rule = body.taskRule ?? null;
        if (rule !== null) {
          taskRules.push(rule);
          // The other held requests the new rule covers are answered by it at once (ticket 30's decision).
          for (const other of [...heldApprovals.values()]) {
            if (other.subject !== null && firstMatchingTaskRule([rule], other.subject) !== null) {
              void emit({ kind: "approval.auto_answered", approvalId: other.approvalId, ruleId: rule.ruleId });
              other.settle(allowOnce(other.options));
            }
          }
        }
        log.info("approval answered", { approvalId: body.approvalId, decision: body.decision, ruleId: rule?.ruleId ?? null });
        return { result: "done" };
      }
      case "deny": {
        held.settle(rejectOnce(held.options));
        // ADR 0032: the turn ends, the other held requests close, and the agent hears why.
        ownPrompt = denyPrompt(body.reason ?? null);
        log.info("approval denied: ending the turn to re-prompt", { approvalId: body.approvalId, withReason: (body.reason ?? "").trim() !== "" });
        if (turnRunning) {
          await cancelTurn();
        } else {
          closeHeld("cancelled");
          nudge();
        }
        return { result: "done" };
      }
      default:
        return body.decision satisfies never;
    }
  };

  const onQuestion = async (_agentSessionId: string, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> => {
    const currentTurn = turn;
    const thisTurn = turnAbort;
    if (currentTurn === undefined || signal.aborted) {
      return { outcome: "cancelled" };
    }
    const questionId = questionIdSchema.parse(randomUUID());
    void emit({ kind: "question.asked", turnId: currentTurn, questionId, message: request.message, fields: [...request.fields] });
    // A turn that waits on a person follows the idle timer too (ADR 0039, ticket 23): when it fires,
    // the turn is cancelled, its work saved, and the session ends. The needs-you item stays on the server.
    const waitingSpec = spec;
    const disarmIdle =
      acrossTurns && waitingSpec !== undefined
        ? timers.after(idleMs(waitingSpec), () => {
            log.info("a turn waited on a person past the idle limit: ending the session", { idleMinutes: waitingSpec.limits.idleMinutes ?? null });
            end({ kind: "idle" });
            thisTurn.abort();
            held.close("expired");
            void cancelTurn();
          })
        : () => undefined;
    let settle: (answer: QuestionAnswer) => void = () => undefined;
    const answered = new Promise<QuestionAnswer>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const finish = (answer: QuestionAnswer): void => {
      if (settled) {
        return;
      }
      settled = true;
      disarmIdle();
      disarmWait();
      heldQuestions.delete(questionId);
      settle(answer);
    };
    const held: HeldQuestion = {
      questionId,
      answer: (answers) => {
        finish({ outcome: "answered", answers });
      },
      close: (reason) => {
        if (!settled) {
          void emit({ kind: "question.closed", questionId, reason });
        }
        finish({ outcome: "cancelled" });
      },
    };
    const disarmWait = timers.after(waitMs, () => {
      held.close("expired");
      expire("question");
    });
    heldQuestions.set(questionId, held);
    signal.addEventListener("abort", () => {
      held.close("cancelled");
    }, { once: true });
    thisTurn.signal.addEventListener("abort", () => {
      held.close("expired");
    }, { once: true });
    return answered;
  };

  /** `question-answer`: the driver's answers reach the agent. The text is never logged. */
  const answerQuestion = (body: CommandBody<"question-answer">): Promise<CommandOutcome> => {
    const held = heldQuestions.get(body.questionId);
    if (held === undefined) {
      return Promise.resolve({ result: "rejected", reason: "no-pending-question" });
    }
    held.answer(body.answers);
    log.info("question answered", { questionId: body.questionId, fields: Object.keys(body.answers).length });
    return Promise.resolve({ result: "done" });
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
        closeHeld("expired");
        void runningAgent.cancel(runningSession);
      },
      currentSpec.limits.turnMaxMinutes * 60_000,
    );
    timer.unref();
    try {
      return await promptTurn(text, turnId, runningAgent, runningSession, agentProcess);
    } finally {
      clearTimeout(timer);
      // Nothing outlives its turn: a request the agent left open is closed with it.
      closeHeld("cancelled");
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
    options: { readonly hiddenRefEvent: boolean; readonly pushOnly?: boolean } = { hiddenRefEvent: true },
  ): Promise<{ readonly ok: true; readonly repos: readonly RepoPushResult[] } | { readonly ok: false; readonly error: string }> => {
    const hiddenRef = hiddenRefFor(currentSpec.taskId);
    const pushed = await deps.executor.commitAndPush({
      box,
      message,
      author: currentSpec.gitIdentity,
      coAuthors: currentSpec.coAuthors,
      branchName: currentSpec.branchName,
      hiddenRef,
      // Committed before the checks (milestone 3): what a check left in the tree stays out of the push.
      ...(options.pushOnly === true ? { pushOnly: true } : {}),
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
   * Milestone 3 (F-054, ADR 0052): the turn's work committed, then the environment's checks that
   * apply to the repos the turn changed (Q188). `undefined` when the spec has none, the peer is older
   * than minor 2, or the session is being stopped; then `commitAndPush` commits as before. A turn that
   * changed nothing runs none. Nothing here fails the turn or holds the push.
   */
  const commitAndCheck = async (
    currentSpec: TaskSpec,
    message: string,
    ordinal: number,
  ): Promise<{ readonly committed: boolean; readonly checks: readonly { readonly checkId: CheckId; readonly status: CheckStatus }[] | undefined }> => {
    const how = endingNow()?.kind;
    const settled = how === undefined || how === "finished" || how === "idle";
    if ((currentSpec.checks?.length ?? 0) === 0 || channel?.supports("check.started") !== true || !settled || dirsCache === undefined) {
      return { committed: false, checks: undefined };
    }
    const committed = await deps.executor.commitWork({ box, message, author: currentSpec.gitIdentity, coAuthors: currentSpec.coAuthors });
    if (!committed.ok) {
      log.warn("committing the turn before its checks failed: no checks", { turnOrdinal: ordinal, code: committed.error.code });
      return { committed: false, checks: undefined };
    }
    const changedRepoIds = committed.value.filter((repo) => repo.changed).map((repo) => repo.repoId);
    if (changedRepoIds.length === 0) {
      return { committed: true, checks: undefined };
    }
    const checks = await runTurnChecks(
      { executor: deps.executor, link: deps.link, emit, logger: log, now },
      {
        box,
        spec: currentSpec,
        changedRepoIds,
        // Beside the task's agent folder, in the box's own root: removed once the outputs are up.
        outputDir: path.join(path.dirname(dirsCache.agentDir), "checks", `turn-${String(ordinal)}`),
        signal: endingSignal.signal,
      },
    );
    return { committed: true, checks: checks.length === 0 ? undefined : checks };
  };

  /**
   * ADR 0039's order after a turn: the branch, the hidden ref, the archive, then `session.saved`;
   * from milestone 3 the commit and the turn's checks come before the branch's push (ADR 0052).
   * Only the branch's push can fail the session; its error comes back for the caller.
   */
  const saveWork = async (currentSpec: TaskSpec, message: string): Promise<{ readonly pushError: string | null }> => {
    unsaved = false;
    const startedAt = now();
    const ordinal = Math.max(1, turnOrdinal);
    // 0. The commit, then the checks, whatever they find: a failing check never holds the push.
    const checked = await commitAndCheck(currentSpec, message, ordinal);
    // 1. The task's branch in every repo: what the PR is made of.
    const pushed = await pushWork(currentSpec, message, { hiddenRefEvent: false, pushOnly: checked.committed });
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
      ...(checked.checks === undefined ? {} : { checks: [...checked.checks] }),
    });
    // The working figures (spike 2, gotcha 13): one line per turn, numbers only.
    log.info("work saved after the turn", {
      turnOrdinal: ordinal,
      afterTurnMs: now() - startedAt,
      archiveBytes: archived.ok ? archived.archive.size : null,
      hiddenRefs: [...savedRepos.values()].filter((repo) => repo.sha !== null).length,
      branchPushed: pushed.ok,
      checks: checked.checks?.length ?? 0,
    });
    return { pushError: pushed.ok ? null : pushed.error };
  };

  /** The next turn's prompt: a reopen's pending message, one at a time, then the messages queued while a turn ran. */
  const takeQueued = (): string | undefined => {
    // The runner's own prompt first: a deny's re-prompt answers the turn the deny ended.
    if (ownPrompt !== undefined) {
      const own = ownPrompt;
      ownPrompt = undefined;
      return own;
    }
    return pending.shift() ?? (steers.length > 0 ? steers.splice(0).join("\n\n") : undefined);
  };

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
    // A new or rebuilt session starts with the spec's prompt (the rebuild template for `rebuilt`); a
    // resumed or restored one carries on from its own history, with the pending messages.
    let next: string | undefined = restored === undefined || restored.origin === "rebuilt" ? taskSpec.prompt : takeQueued();
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
    taskRules.push(...(taskSpec.agent.taskRules ?? []));
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
        void cancelTurn();
      },
      // F-068: the key proxy enforces the task's spend cap, in a session across turns only (minor 1).
      ...(acrossTurns && taskSpec.limits.spendCap !== undefined
        ? {
            spendCap: taskSpec.limits.spendCap,
            onSpendCapReached: (reached: SpendCapReached) => {
              log.info("the spend cap is reached: ending the turn", { unit: reached.unit, observed: reached.observed });
              end({ kind: "limit", limit: "spend-cap", observed: reached.observed });
              void cancelTurn();
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
    const proxies = { gitBaseUrl: gitProxy.baseUrl, modelBaseUrl: keyProxy.baseUrl, mcpUrl: mcp.url };
    const step = acrossTurns ? (taskSpec.restore?.origin ?? "new") : "new";
    if (step !== "new") {
      restored = { origin: step === "resumed" ? "rebuilt" : step, hiddenRef: "none", previousBox: undefined, fallbackReason: undefined, resumeId: undefined };
      pending.push(...(taskSpec.restore?.pendingMessages ?? []).map((message) => message.text));
    }
    if (step === "resumed") {
      const resumed = await resumeKeptBox(taskSpec, proxies);
      if (resumed.ok) {
        restored = { origin: "resumed", hiddenRef: "none", previousBox: "kept", fallbackReason: undefined, resumeId: resumed.agentSessionId };
        await placeTicketFiles(taskSpec);
        return { ok: true, spec: taskSpec };
      }
      fallBack(resumed.reason);
    }
    const created = await deps.executor.create({ ...box, spec: taskSpec, proxies });
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
      const cache = prepared.value.dependencyCache;
      const snapshot = prepared.value.snapshot;
      await emit({
        kind: "environment.setup_finished",
        exitCode: prepared.value.setup.exitCode,
        durationMs: prepared.value.setup.durationMs,
        // Milestone 3 (F-051): what the box started from. A minor-1 peer's codec drops both.
        ...(cache === undefined ? {} : { dependencyCache: cache.reused ? ("warm" as const) : ("cold" as const) }),
        ...(snapshot === undefined ? {} : { snapshot }),
      });
      log.info("setup finished", {
        exitCode: prepared.value.setup.exitCode,
        durationMs: prepared.value.setup.durationMs,
        dependencyCache: cache === undefined ? null : cache.reused ? "warm" : "cold",
      });
      if (prepared.value.setup.exitCode !== 0) {
        return { ok: false, error: `the environment's setup script failed (exit ${String(prepared.value.setup.exitCode)})` };
      }
    }
    boxPrepared = true;
    if (restored !== undefined) {
      await restoreOntoFreshBox(taskSpec);
    }
    await placeTicketFiles(taskSpec);
    return { ok: true, spec: taskSpec };
  };

  // ---------- a reopen: the same box, or a fresh one (ticket 24, ADR 0039) ----------

  /** The step can't be done: the session is rebuilt from the template, and says why in words. */
  const fallBack = (reason: string): void => {
    log.warn("the restore falls back to the rebuild template", { reason: reason.slice(0, 300) });
    if (restored !== undefined) {
      restored.origin = "rebuilt";
      restored.resumeId = undefined;
      restored.previousBox = undefined;
      restored.fallbackReason = reason.slice(0, 500);
    }
  };

  /** `resumed`: the box this runner kept takes the new session's proxies. */
  const resumeKeptBox = async (
    taskSpec: TaskSpec,
    proxies: { readonly gitBaseUrl: string; readonly modelBaseUrl: string; readonly mcpUrl: string },
  ): Promise<{ readonly ok: true; readonly agentSessionId: string | undefined } | { readonly ok: false; readonly reason: string }> => {
    const keptBox = await deps.claimKeptBox?.(box, dispatch.sessionId);
    if (keptBox === undefined) {
      return { ok: false, reason: "the box to resume isn't kept on this runner any more" };
    }
    if (keptBox.agentAdapter !== taskSpec.agent.adapter) {
      await deps.executor.release(box, "requested");
      return { ok: false, reason: "the kept box ran another agent" };
    }
    const resumed = await deps.executor.resumeBox({ ...box, spec: taskSpec, proxies });
    if (!resumed.ok) {
      // A box half resumed can't take a fresh one's place: it goes first.
      await deps.executor.release(box, "requested");
      return { ok: false, reason: `the kept box couldn't take the session: ${resumed.error.message}` };
    }
    boxCreated = true;
    boxPrepared = true;
    dirsCache = resumed.value;
    return { ok: true, agentSessionId: keptBox.agentSessionId ?? undefined };
  };

  /** `restored` and `rebuilt`, on the fresh box: each repo's hidden ref, then the archive for `restored`. */
  const restoreOntoFreshBox = async (taskSpec: TaskSpec): Promise<void> => {
    const state = restored;
    const refs = taskSpec.restore?.hiddenRefs ?? [];
    if (state === undefined) {
      return;
    }
    if (refs.length > 0) {
      const applied = await deps.executor.restoreWorkInProgress({ box, refs });
      if (applied.ok) {
        const outcomes = applied.value.map((repo) => repo.outcome);
        state.hiddenRef = outcomes.includes("conflict") ? "conflict" : outcomes.includes("applied") ? "applied" : "none";
      } else {
        log.warn("restoring the hidden refs failed", { code: applied.error.code });
        state.hiddenRef = "conflict";
      }
    }
    if (state.origin !== "restored") {
      return;
    }
    const archive = taskSpec.restore?.archive ?? null;
    if (archive === null) {
      fallBack("the spec names no session archive");
      return;
    }
    const adapter = makeAgent(taskSpec);
    const context = adapter === undefined ? undefined : archiveContext(taskSpec);
    if (context === undefined) {
      fallBack("this runner can't run the task's agent");
      return;
    }
    const loaded = await loadSessionArchive(context, archive);
    if (!loaded.ok) {
      fallBack(loaded.reason);
      return;
    }
    state.resumeId = loaded.agentSessionId;
  };

  /** The task's agent adapter, made once per agent process. */
  const makeAgent = (taskSpec: TaskSpec): AgentAdapter | undefined => {
    agent ??= deps.agents.create(taskSpec.agent.adapter, {
      onLiveText: (delta) => {
        channel?.appendLiveText({ turnId: delta.turnId, segmentId: delta.segmentId, kind: delta.kind }, delta.text);
      },
    });
    return agent;
  };

  /**
   * The agent, started for the session: with a resume, it loads its own session. A load that fails
   * starts the agent again on a new session, rebuilt from the template.
   */
  const startAgentFor = async (taskSpec: TaskSpec): Promise<string | null> => {
    const resumeId = restored?.resumeId;
    const first = await startAgent(taskSpec, resumeId);
    if (first.ok || resumeId === undefined || first.stage !== "session" || ending !== undefined) {
      return first.ok ? null : first.error;
    }
    fallBack(`the agent couldn't load its session: ${first.error}`);
    // Its process goes, and the box is made ready again for a new one.
    await endAgent();
    agent = undefined;
    const proxies = keyProxy === undefined || gitProxy === undefined || mcp === undefined ? undefined : { gitBaseUrl: gitProxy.baseUrl, modelBaseUrl: keyProxy.baseUrl, mcpUrl: mcp.url };
    if (proxies === undefined) {
      return "the task's proxies aren't running";
    }
    const again = await deps.executor.resumeBox({ ...box, spec: taskSpec, proxies });
    if (!again.ok) {
      return `the box couldn't take a new agent: ${again.error.message}`;
    }
    const second = await startAgent(taskSpec, undefined);
    return second.ok ? null : second.error;
  };

  /** `session.restored`: how the session came back, once the agent runs. Replayed updates were never sent. */
  const reportRestored = async (): Promise<void> => {
    const state = restored;
    if (state === undefined || session === undefined) {
      return;
    }
    await emit({
      kind: "session.restored",
      origin: state.origin,
      replayedUpdates: state.origin === "rebuilt" ? 0 : session.replayedUpdates,
      hiddenRef: state.hiddenRef,
      ...(state.previousBox === undefined ? {} : { previousBox: state.previousBox }),
      ...(state.fallbackReason === undefined ? {} : { fallbackReason: state.fallbackReason }),
    });
    log.info("session restored", { origin: state.origin, hiddenRef: state.hiddenRef, replayedUpdates: session.replayedUpdates, fellBack: state.fallbackReason !== undefined, pending: pending.length });
  };

  /**
   * F-064, ticket 26: the ticket's images under `.ostra/ticket/` in the folder the agent's session
   * opens on, before the agent starts. A file that fails is skipped and named; the turn starts anyway.
   */
  const placeTicketFiles = async (taskSpec: TaskSpec): Promise<void> => {
    const files = taskSpec.contextFiles ?? [];
    if (files.length === 0 || dirsCache === undefined || channel?.supports("ticket.files_ready") !== true) {
      return;
    }
    const placed = await writeTicketFiles({
      link: deps.link,
      taskId: taskSpec.taskId,
      leaseEpoch: taskSpec.leaseEpoch,
      files,
      sessionDir: agentCwd(dirsCache.workspaceDir, taskSpec.repos),
      logger: log,
    });
    await emit({ kind: "ticket.files_ready", files: [...placed.files], ...(placed.skipped.length > 0 ? { skipped: [...placed.skipped] } : {}) });
  };

  type AgentStart = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly stage: "launch" | "session" };

  const startAgent = async (taskSpec: TaskSpec, resumeAgentSessionId: string | undefined): Promise<AgentStart> => {
    const failed = (error: string, stage: "launch" | "session" = "launch"): AgentStart => ({ ok: false, error, stage });
    const held = credentials;
    if (keyProxy === undefined || mcp === undefined || held === undefined) {
      return failed("the task's proxies aren't running");
    }
    const created = makeAgent(taskSpec);
    if (created === undefined) {
      return failed(`this runner has no agent adapter "${taskSpec.agent.adapter.slice(0, 64)}"`);
    }
    const state = await deps.executor.state(box);
    if (!state.ok || state.value !== "ready") {
      return failed("the workspace isn't ready");
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
      // Milestone 3 (ADR 0049): a `native` agent writes the rules into its own settings as "ask".
      approvalRules: taskSpec.agent.approvalRules ?? [],
      taskRules: [...taskRules],
      mode,
    });
    if (!launch.ok) {
      return failed(`the agent couldn't be launched: ${launch.error.message}`);
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
      return failed(`the agent's environment held ${checked.holds} (in ${checked.variable}): refused to start it`);
    }
    const started = await deps.executor.startAgent(box, guarded);
    if (!started.ok) {
      return failed(`the agent didn't start: ${started.error.message}`);
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
      ...(resumeAgentSessionId === undefined ? {} : { resumeAgentSessionId }),
    });
    if (!opened.ok) {
      return failed(`the agent's session didn't start: ${opened.error.message}`, "session");
    }
    session = opened.value;
    return { ok: true };
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
      const failed = await startAgentFor(taskSpec);
      if (failed !== null) {
        end({ kind: "crashed", error: failed });
      } else {
        await reportRestored();
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
      await cancelTurn();
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
      await cancelTurn();
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
        await cancelTurn();
      }
      return { result: "accepted" };
    },
    fence: async () => {
      end({ kind: "fenced" });
      await cancelTurn();
      await done;
    },
    abandon: async () => {
      end({ kind: "abandoned" });
      await cancelTurn();
      await done;
    },
    answerApproval,
    answerQuestion,
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
