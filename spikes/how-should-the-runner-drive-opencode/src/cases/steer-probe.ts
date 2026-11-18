// Pass-bar bullet 5, second half: whether OpenCode's own HTTP API can steer
// mid-turn. Starts `opencode serve` on loopback with a random password, starts
// a turn whose first step is a 15 s tool call, posts a second prompt with
// `delivery: "steer"` while it runs, and checks whether the model's very next
// call in the same turn carries the steer text. Bullet 5 asks for the answer
// to be recorded, so the check passes on either answer and says which.

import { conversationText, stubMarker } from "../lib/stub-models/scenario.ts";
import { textPrompt } from "../lib/acp-driver.ts";
import { errorMessage, marker, startTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { createServeSession, startServe, until } from "../harness/opencode-serve.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

export const steerProbe = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string> = {};
  // ACP side: what OpenCode advertises.
  const task = await startTask(ctx, { name: "steer", upstream: { kind: "stub", format: "openai" } });
  recorded["ACP initialize _meta"] = JSON.stringify(task.driver.initialize._meta ?? {});
  const stub = ctx.modelSide.stubs.openai;
  const callsWith = (mark: string, from: number): typeof stub.calls =>
    stub.calls.filter((c) => c.at >= from && c.toolNames.length > 0 && conversationText(c.messages).includes(mark));

  // ACP: OpenCode registers `_session/steering`, the extension Claude Code's adapter uses.
  try {
    const session = await task.driver.newSession({ cwd: task.dirs.workspace, mcpServers: [] });
    const mark = marker(ctx, "steer-acp");
    const from = Date.now();
    const turn = task.driver.prompt(session.sessionId, textPrompt(`${stubMarker("steer-probe", `15000 ${mark}`)} start`));
    turn.catch(() => undefined);
    await until("the ACP turn's first model call", 60_000, () => callsWith(mark, from).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let answer: string;
    try {
      answer = JSON.stringify((await task.driver.steer(session.sessionId, textPrompt("STEER-TOKEN-ACP: also mention the colour blue"))) ?? null).slice(0, 160);
    } catch (error) {
      answer = `error: ${errorMessage(error).slice(0, 160)}`;
    }
    recorded["ACP _session/steering answer"] = answer;
    const response = await withTimeout(turn, 90_000, "the steered ACP turn");
    const afterTool = callsWith(mark, from).find((c) => c.messages.some((m) => m.role === "tool"));
    const steered = afterTool !== undefined && conversationText(afterTool.messages).includes("STEER-TOKEN-ACP");
    recorded["OpenCode can steer mid-turn over ACP (_session/steering)"] = steered ? `yes (turn ended ${response.stopReason})` : `no (turn ended ${response.stopReason})`;
  } catch (error) {
    recorded["OpenCode can steer mid-turn over ACP (_session/steering)"] = `probe failed: ${errorMessage(error)}`;
  }
  await task.driver.stop();

  try {
    const serve = await startServe(task);
    try {
      const sessionId = await createServeSession(serve, task);
      const mark = marker(ctx, "steer");
      const from = Date.now();
      const first = await serve.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: `${stubMarker("steer-probe", `15000 ${mark}`)} start` });
      recorded["first prompt status"] = String(first.status);
      await until("the turn's first model call", 60_000, () => callsWith(mark, from).length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const steer = await serve.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: "STEER-TOKEN: also mention the colour blue", delivery: "steer" });
      recorded["steer prompt status"] = String(steer.status);
      // The turn's next model call comes after the 15 s tool step.
      await until("the call after the tool step", 60_000, () => callsWith(mark, from).some((c) => c.messages.some((m) => m.role === "tool")));
      const afterTool = callsWith(mark, from).find((c) => c.messages.some((m) => m.role === "tool"));
      const steeredMidTurn = afterTool !== undefined && conversationText(afterTool.messages).includes("STEER-TOKEN");
      recorded["OpenCode's HTTP API can steer mid-turn"] = steeredMidTurn ? "yes" : "no";
      checks.push(
        check(
          "recorded: whether OpenCode's own HTTP API can steer mid-turn",
          true,
          steeredMidTurn
            ? "recorded yes: a prompt with delivery \"steer\" sent during a tool step reached the model in the same turn's next call"
            : "recorded no: the steer text was not in the same turn's next model call",
        ),
      );
    } finally {
      await serve.close();
    }
  } catch (error) {
    checks.push(fail("recorded: whether OpenCode's own HTTP API can steer mid-turn", errorMessage(error)));
  } finally {
    await task.proxy.close();
  }
  return [{ id: "STEER", title: "Recorded: whether OpenCode's own HTTP API can steer mid-turn.", checks, recorded }];
};
