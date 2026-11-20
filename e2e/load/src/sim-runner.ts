import type { Logger } from "@ostra/adapter-sdk";
import type { RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { createAccessTokens, generateRunnerKeyPair, register, startConnection } from "@ostra/runner";
import type { CommandHandlers, CommandOutcome, ConnectionOptions, RunnerConnection, RunnerKeyPair, SessionChannel } from "@ostra/runner";

import { partialTextOn } from "./mix.ts";
import { startScriptedAgent } from "./scripted-agent.ts";
import type { ScriptedAgent } from "./scripted-agent.ts";

// A simulated pool runner (ticket 34, ADR 0061): `apps/runner`'s own key pair, `register` with the
// pool's join token, access tokens and connection (its real peer and disk spool, on the real
// protocol and either carrier). Only what runs a task is a script: a dispatch is accepted while a
// slot is free and starts a scripted agent on the session's channel; a steer is noted with the
// moment it arrived; a stop pauses the agent. Every other command is acknowledged as done.
//
// It joins as a `host` runner: on `host` the runner's own connection carries its tasks' events and
// commands, which is the path a simulated agent can stand in for. On `docker` and `kubernetes` each
// box's sidecar holds its own connection on a task token, so a fleet of those has one connection per
// box: the load test's default of one slot a runner gives it the same number of connections.

export type RegisteredRunner = { readonly runnerId: RunnerId; readonly keyPair: RunnerKeyPair; readonly name: string };

export const registerSimRunner = async (input: { readonly serverUrl: string; readonly joinToken: string; readonly name: string; readonly slots: number }): Promise<RegisteredRunner> => {
  const keyPair = await generateRunnerKeyPair();
  const result = await register({
    serverUrl: input.serverUrl,
    publicKey: keyPair.publicKey,
    name: input.name,
    executor: "host",
    capacity: input.slots,
    labels: [],
    proof: { kind: "join-token", joinToken: input.joinToken },
  });
  if (!result.ok) {
    throw new Error(`the runner ${input.name} could not join: ${result.failure.kind === "refused" ? `refused, ${String(result.failure.status)}` : result.failure.kind}`);
  }
  return { runnerId: result.value.runnerId, keyPair, name: input.name };
};

export type SimTask = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly channel: SessionChannel; readonly agent: ScriptedAgent; readonly partialText: boolean };

export type SimRunnerHooks = {
  readonly onDispatched?: (task: { readonly taskId: TaskId; readonly sessionId: SessionId; readonly partialText: boolean }) => void;
  /** A steer arrived: when, by this machine's clock, and its message's client ID. */
  readonly onSteer?: (clientMessageId: string, at: number) => void;
  readonly onAckLatency?: (ms: number) => void;
  readonly onConnected?: () => void;
  readonly onError?: (error: unknown) => void;
};

export type SimRunner = {
  readonly runnerId: RunnerId;
  readonly connection: RunnerConnection;
  readonly tasks: () => readonly SimTask[];
  readonly connected: () => boolean;
  /** Stops every agent writing. */
  readonly pause: () => void;
  /** Resolves once every event written so far is acked, with each session's count. */
  readonly drained: () => Promise<readonly { readonly taskId: TaskId; readonly sessionId: SessionId; readonly offered: number }[]>;
  readonly stop: () => Promise<void>;
};

const done = (): Promise<CommandOutcome> => Promise.resolve({ result: "done" });

export const startSimRunner = async (input: {
  readonly serverUrl: string;
  readonly runner: RegisteredRunner;
  readonly slots: number;
  readonly dataDir: string;
  readonly logger: Logger;
  readonly hooks?: SimRunnerHooks;
  /** A fixed rate for every agent (the end-to-end test's quick script); unset, each draws its own. */
  readonly ratePerMinute?: number;
  readonly transport?: ConnectionOptions["transport"];
}): Promise<SimRunner> => {
  const hooks = input.hooks ?? {};
  const tasks = new Map<SessionId, SimTask>();
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  let connected = false;

  const handlers: CommandHandlers = {
    dispatch: (command) => {
      const body = command.body;
      if (tasks.has(body.sessionId)) return Promise.resolve({ result: "accepted" });
      if (tasks.size >= input.slots) return Promise.resolve({ result: "rejected", reason: "no-capacity" });
      const connection = holder.connection;
      if (connection === undefined) return Promise.resolve({ result: "rejected", reason: "not-ready" });
      void connection.openSession({ taskId: body.taskId, sessionId: body.sessionId, leaseEpoch: body.leaseEpoch }).then(
        (channel) => {
          const partialText = partialTextOn(body.taskId);
          const agent = startScriptedAgent({
            channel,
            partialText,
            ...(input.ratePerMinute === undefined ? {} : { ratePerMinute: input.ratePerMinute }),
            ...(hooks.onAckLatency === undefined ? {} : { onAckLatency: hooks.onAckLatency }),
            ...(hooks.onError === undefined ? {} : { onError: hooks.onError }),
          });
          tasks.set(body.sessionId, { taskId: body.taskId, sessionId: body.sessionId, channel, agent, partialText });
          connection.statusChanged();
          hooks.onDispatched?.({ taskId: body.taskId, sessionId: body.sessionId, partialText });
        },
        (error: unknown) => hooks.onError?.(error),
      );
      return Promise.resolve({ result: "accepted" });
    },
    steer: (command) => {
      hooks.onSteer?.(command.body.clientMessageId, Date.now());
      return done();
    },
    stop: (command) => {
      tasks.get(command.body.sessionId)?.agent.pause();
      return done();
    },
    interrupt: done,
    "approval-answer": done,
    drain: done,
    resume: done,
    "update-hint": done,
    release: done,
    "question-answer": done,
    "plan-answer": done,
    "snapshot-build": () => Promise.resolve({ result: "rejected", reason: "not-supported" }),
    "set-effort": done,
  };

  const tokens = createAccessTokens({ serverUrl: input.serverUrl, runnerId: input.runner.runnerId, keyPair: input.runner.keyPair });
  const connection = await startConnection({
    serverUrl: input.serverUrl,
    peer: { kind: "runner", runnerId: input.runner.runnerId },
    tokens,
    dataDir: input.dataDir,
    handlers,
    status: () => ({ executor: "host", capacity: input.slots, freeSlots: Math.max(0, input.slots - tasks.size), labels: [], running: [...tasks.keys()] }),
    logger: input.logger,
    transport: input.transport ?? "websocket",
    hooks: {
      onConnected: () => {
        connected = true;
        hooks.onConnected?.();
      },
      onAcked: (sessionId, upTo) => {
        tasks.get(sessionId)?.agent.acked(upTo);
      },
    },
  });
  holder.connection = connection;

  return {
    runnerId: input.runner.runnerId,
    connection,
    tasks: () => [...tasks.values()],
    connected: () => connected && connection.report().connected,
    pause: () => {
      for (const task of tasks.values()) task.agent.pause();
    },
    drained: async () => {
      const held = [...tasks.values()];
      // The agents are paused; what each wrote is acked once its channel drains.
      await Promise.all(held.map(async (task) => {
        await task.agent.settled();
        await task.channel.drained();
      }));
      return held.map((task) => ({ taskId: task.taskId, sessionId: task.sessionId, offered: task.agent.offered() }));
    },
    stop: () => connection.stop(),
  };
};
