import { turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AgentAdapter, AgentIo, AgentLaunch, AgentSession, PrepareLaunchInput } from "../agent/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every agent adapter passes (ADR 0018, ADR 0025): against the scripted fake ACP agent
// (ticket 10), against stub model endpoints, and, gated on `model.env`, against the real endpoint.

export type StartedAgent = {
  readonly io: AgentIo;
  /** Ends the agent's process. */
  readonly stop: () => Promise<void>;
};

export type AgentFixture = {
  readonly launchInput: PrepareLaunchInput;
  /** Values that must never reach the agent: the real model token, git tokens, secrets. */
  readonly secrets: readonly string[];
  /** Starts the agent's process from its launch, as the executor would. */
  readonly start: (launch: AgentLaunch) => Promise<StartedAgent>;
  /** A prompt the agent answers with a message and an `end_turn`. */
  readonly simplePrompt: string;
  /** A prompt the agent keeps working on until it's cancelled. */
  readonly longPrompt: string;
};

const turn = (n: number) => turnIdSchema.parse(`contract-turn-${String(n)}`);

export const defineAgentContractSuite = (options: ContractSuiteOptions<AgentAdapter, AgentFixture>): void => {
  describe(`agent contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "agent", {
      steerMidTurn: "boolean",
      sessionLoad: "boolean",
      nativePlan: "boolean",
      rejectAndContinue: "boolean",
      elicitationForm: "boolean",
      modelBaseUrlAndPlaceholderKey: "boolean",
    });

    const launch = async (): Promise<AgentLaunch> => {
      const prepared = await subject().adapter.prepareLaunch(subject().fixture.launchInput);
      if (!prepared.ok) {
        throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
      }
      return prepared.value;
    };

    const session = async (
      events: TaskEvent[],
    ): Promise<{ readonly session: AgentSession; readonly started: StartedAgent }> => {
      const { adapter, fixture } = subject();
      const started = await fixture.start(await launch());
      const result = await adapter.startSession({
        taskId: fixture.launchInput.taskId,
        sessionId: fixture.launchInput.sessionId,
        io: started.io,
        cwd: fixture.launchInput.workspaceDir,
        mcpServers: [],
        onEvents: (batch) => {
          events.push(...batch);
        },
        onPermission: () => Promise.resolve({ outcome: "cancelled" }),
        onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
      });
      if (!result.ok) {
        await started.stop();
        throw new Error(`startSession failed: ${result.error.message}`);
      }
      return { session: result.value, started };
    };

    it("launches with an allowlisted environment that holds no credential", async () => {
      const prepared = await launch();
      const everything = JSON.stringify({ args: prepared.args, env: prepared.env, files: prepared.files });
      for (const secret of subject().fixture.secrets) {
        expect(everything.includes(secret), "a credential reached the agent's launch").toBe(false);
      }
      expect(prepared.cwd).toBe(subject().fixture.launchInput.workspaceDir);
    });

    it("runs a turn to end_turn and maps the agent's message", async () => {
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        const result = await subject().adapter.prompt(running, turn(1), subject().fixture.simplePrompt);
        expect(result).toEqual({ ok: true, value: { stopReason: "end_turn" } });
        expect(events.some((event) => event.kind === "agent.message")).toBe(true);
      } finally {
        await subject().adapter.close(running);
        await started.stop();
      }
    });

    it("cancels a running turn: the prompt ends with cancelled", async () => {
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        const turnResult = subject().adapter.prompt(running, turn(2), subject().fixture.longPrompt);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await subject().adapter.cancel(running);
        expect(await turnResult).toEqual({ ok: true, value: { stopReason: "cancelled" } });
      } finally {
        await subject().adapter.close(running);
        await started.stop();
      }
    });

    it("steers mid-turn only when it declares steerMidTurn", async () => {
      const { adapter } = subject();
      const { session: running, started } = await session([]);
      try {
        const steered = await adapter.steer(running, "also add a test");
        if (adapter.capabilities.steerMidTurn && running.connection.steeringAdvertised) {
          expect(steered.ok).toBe(true);
        } else {
          expect(steered).toMatchObject({ ok: false, error: { code: "unsupported" } });
        }
      } finally {
        await adapter.close(running);
        await started.stop();
      }
    });

    it("refuses to resume a session when it doesn't declare sessionLoad", async (context) => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.sessionLoad) {
        context.skip();
        return;
      }
      const started = await fixture.start(await launch());
      try {
        const result = await adapter.startSession({
          taskId: fixture.launchInput.taskId,
          sessionId: fixture.launchInput.sessionId,
          io: started.io,
          cwd: fixture.launchInput.workspaceDir,
          mcpServers: [],
          onEvents: () => undefined,
          onPermission: () => Promise.resolve({ outcome: "cancelled" }),
          onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
          resumeAgentSessionId: "an-earlier-session",
        });
        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
      } finally {
        await started.stop();
      }
    });
  });
};
