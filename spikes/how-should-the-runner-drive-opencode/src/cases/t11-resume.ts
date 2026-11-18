// T11 Resume, same runner (ADR 0006 step 1): kill OpenCode between turns, and
// separately kill the driver process. After a restart, session/load with the
// same cwd replays history, and the agent answers a question about turn 1.

import { agentText, textPrompt, type AcpDriver } from "../lib/acp-driver.ts";
import { sessionId as toSessionId, type SessionId } from "../lib/ids.ts";
import { isAlive } from "../lib/process-tree.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, newSession, startChildRunner, withTask, withTimeout, type CaseContext, type Task } from "../harness/fixture.ts";
import { detectApiFormat, MODEL_INPUT_HINT } from "../harness/inputs.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";

const replayAndRecall = async (task: Task, driver: AcpDriver, sessionId: SessionId, secret: string, label: string): Promise<Check[]> => {
  const before = driver.events.length;
  await withTimeout(driver.loadSession({ sessionId, cwd: task.dirs.workspace, mcpServers: [] }), 60_000, "session/load");
  const replayed = driver.events.slice(before).filter((e) => e.kind === "session_update" && e.sessionId === sessionId);
  const replayText = JSON.stringify(replayed);
  const sinceSeq = driver.events.at(-1)?.seq ?? 0;
  const response = await withTimeout(driver.prompt(sessionId, textPrompt(`${stubMarker("recall")} What was the secret word I told you in my first message?`)), 60_000, "recall");
  const text = agentText(driver.events, sessionId, sinceSeq);
  return [
    check(`after ${label}, session/load with the same cwd replays history`, replayed.length > 0 && replayText.includes(secret), `${String(replayed.length)} updates replayed; turn 1's text ${replayText.includes(secret) ? "among them" : "MISSING"}`),
    check(`after ${label}, the agent answers a question about turn 1 correctly`, response.stopReason === "end_turn" && text.includes(secret), `agent said "${text.slice(0, 80)}"`),
  ];
};

export const t11Resume = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number | boolean> = {};

  // Kill OpenCode between turns.
  try {
    await withTask(ctx, { name: "t11-agent", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      const sessionId = await newSession(task);
      await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("remember", "albatross")} The secret word is albatross.`)), 60_000, "turn 1");
      task.driver.crash();
      await task.driver.exited;
      const fresh = await task.restart();
      checks.push(...(await replayAndRecall(task, fresh, sessionId, "albatross", "killing OpenCode")));
    });
  } catch (error) {
    checks.push(fail("resume after killing OpenCode", errorMessage(error)));
  }

  // Kill the driver process itself.
  try {
    await withTask(ctx, { name: "t11-driver", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      // The fixture's own driver is not used: a child runner owns the agent.
      await task.driver.stop();
      const child = await startChildRunner(ctx, "t11-driver", {
        kind: "turn-then-wait",
        task: { taskId: task.id, launch: { ...task.launch, args: [...task.launch.args], env: { ...task.launch.env } }, prompt: `${stubMarker("remember", "kestrel")} The secret word is kestrel.` },
      });
      const ready = await child.waitFor("ready", 120_000);
      const sessionId = toSessionId(String(ready["sessionId"]));
      const agentPid = Number(ready["agentPid"]);
      child.kill();
      await child.exited;
      // The orphaned agent should see stdin close and exit by itself.
      const deadline = Date.now() + 10_000;
      while (isAlive(agentPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      const orphanExited = !isAlive(agentPid);
      recorded["agent exits by itself when its driver is killed"] = orphanExited;
      checks.push(check("when the driver process is killed, OpenCode exits on its own (stdin closes)", orphanExited, orphanExited ? "the agent exited within 10 s" : "the agent was still running 10 s later"));
      const fresh = await task.restart();
      checks.push(...(await replayAndRecall(task, fresh, sessionId, "kestrel", "killing the driver process")));
    });
  } catch (error) {
    checks.push(fail("resume after killing the driver process", errorMessage(error)));
  }

  // The same with the real model: a stub only proves the history arrived, a model proves it's used.
  const endpoint = ctx.inputs.model;
  if (endpoint === undefined) {
    checks.push(skip("with the model.env endpoint, the agent answers a question about turn 1 after OpenCode is killed", MODEL_INPUT_HINT));
  } else {
    try {
      const format = await detectApiFormat(endpoint);
      await withTask(ctx, { name: "t11-real", upstream: { kind: "endpoint", endpoint, format } }, async (task) => {
        const sessionId = await newSession(task);
        await withTimeout(task.driver.prompt(sessionId, textPrompt("Remember this for later: the secret word is quokka. Reply with just OK.")), 300_000, "turn 1");
        task.driver.crash();
        await task.driver.exited;
        const fresh = await task.restart();
        await withTimeout(fresh.loadSession({ sessionId, cwd: task.dirs.workspace, mcpServers: [] }), 60_000, "session/load");
        const sinceSeq = fresh.events.at(-1)?.seq ?? 0;
        const response = await withTimeout(fresh.prompt(sessionId, textPrompt("What was the secret word I told you earlier? Answer with just the word.")), 300_000, "recall");
        const text = agentText(fresh.events, sessionId, sinceSeq);
        checks.push(
          check(
            "with the model.env endpoint, the agent answers a question about turn 1 after OpenCode is killed",
            response.stopReason === "end_turn" && text.toLowerCase().includes("quokka"),
            `stopReason=${response.stopReason}; the answer ${text.toLowerCase().includes("quokka") ? "names" : "does NOT name"} the word (${String(text.length)} chars)`,
          ),
        );
      });
    } catch (error) {
      checks.push(fail("with the model.env endpoint, the agent answers a question about turn 1", errorMessage(error)));
    }
  }

  return [{ id: "T11", title: "Resume, same runner: kill OpenCode, and separately the driver; session/load replays history and context holds.", checks, recorded }];
};
