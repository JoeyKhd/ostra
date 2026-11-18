import WebSocket from "ws";
import { z } from "zod";
import { CommandId, RunnerId } from "../../protocol/ids.ts";
import { PROTOCOL_MAJOR, SERVER_MINOR, downFrame, frameText, parseJson, type CommandAck, type Hello } from "../../protocol/messages.ts";
import { mintToken } from "../../shared/auth.ts";
import { dispatch, stopSession, type Ctx, type Replica } from "../cluster.ts";
import { check, type Check } from "../report.ts";

const CommandRows = z.array(z.object({ id: z.string(), seq: z.coerce.number().int(), kind: z.string(), result: z.string().nullable() }));

/** A bare protocol client: says hello as `runnerId`, waits for welcome, sends one frame. */
const sendAs = (ctx: Ctx, port: number, runnerId: RunnerId, frame: CommandAck): Promise<boolean> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`wss://localhost:${String(port)}/runner/v1/connect`, {
      ca: ctx.serverCaPem,
      headers: { authorization: `Bearer ${mintToken(ctx.secret, runnerId)}` },
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 15_000);
    ws.on("open", () => {
      const hello: Hello = {
        type: "hello",
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: SERVER_MINOR,
        runnerVersion: "0.0.0-authz",
        runnerId,
        carrier: "websocket",
        lastCommandSeq: 0,
        sessions: [],
      };
      ws.send(JSON.stringify(hello));
    });
    ws.on("message", (data) => {
      const parsed = parseJson(frameText(data));
      const msg = parsed.ok ? downFrame(SERVER_MINOR).safeParse(parsed.value) : undefined;
      if (msg?.success !== true || msg.data.type !== "welcome") return;
      ws.send(JSON.stringify(frame));
      clearTimeout(timer);
      resolve(true);
      setTimeout(() => {
        ws.close();
      }, 3_000).unref();
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

/**
 * Not the bar: a runner that learns another runner's command IDs (they appear
 * in runner logs) acks them as `accepted` and `done`. The victim's task must not move.
 */
export const crossRunnerAck = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const rep = replicas[0];
  if (rep === undefined) return [];
  const name = "a runner can't ack another runner's commands: the victim's task doesn't move [not the bar]";
  const victim = RunnerId.parse("authz-victim");
  const attacker = RunnerId.parse("authz-attacker");
  const d = await dispatch(ctx, victim, "authz-victim");
  await stopSession(ctx, victim, d.session);
  const cmds = CommandRows.parse((await ctx.db.query("SELECT id::text AS id, seq, kind, result FROM runner_command WHERE runner_id = $1 ORDER BY seq", [victim])).rows);
  const dispatchCmd = cmds.find((c) => c.kind === "dispatch");
  const stopCmd = cmds.find((c) => c.kind === "stop");
  if (dispatchCmd === undefined || stopCmd === undefined) return [check(name, false, "the victim's commands weren't written")];
  const from = rep.child.lines.length;
  const sent = await sendAs(ctx, rep.port, attacker, {
    type: "command.ack",
    upTo: 0,
    results: [
      { id: CommandId.parse(dispatchCmd.id), seq: dispatchCmd.seq, result: "accepted" },
      { id: CommandId.parse(stopCmd.id), seq: stopCmd.seq, result: "done" },
    ],
  });
  if (!sent) return [check(name, false, "the attacker's connection never got a welcome")];
  // The replica logs each ack it can't match to the calling runner.
  const deadline = Date.now() + 10_000;
  const refusedLines = (): number => rep.child.lines.slice(from).filter((l) => l["t"] === "command-ack-unknown" && l["runner"] === attacker).length;
  while (refusedLines() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const task = z.object({ state: z.string() }).parse((await ctx.db.query("SELECT state FROM task WHERE id = $1", [d.task])).rows[0]);
  const after = CommandRows.parse((await ctx.db.query("SELECT id::text AS id, seq, kind, result FROM runner_command WHERE runner_id = $1 ORDER BY seq", [victim])).rows);
  const untouched = after.every((c) => c.result === null);
  return [
    check(
      name,
      task.state === "offered" && untouched && refusedLines() === 2,
      `the attacker acked the victim's dispatch as accepted and its stop as done: the victim's task is still ${task.state}; its commands' results: ${after.map((c) => c.result ?? "none").join(", ")}; the replica logged ${String(refusedLines())} acks it couldn't match to the caller`,
    ),
  ];
};
