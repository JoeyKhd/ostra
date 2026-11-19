import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { taskCredentialsSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Ticket 31 (F-024, ADR 0032: "milestone 3's steering test runs on the model in `model.env`"),
// gated on `model.env`: the pinned OpenCode on the host executor, on the development model, with
// the real key proxy. Between the key proxy and the provider sits a recorder that keeps, for each
// model call, only when it came, whether it offered tools and whether its body held a marker: never
// the body. A steer sent mid-turn during a tool step reaches the turn's next model call; "Interrupt
// and send" cancels the turn within 5 s and starts the next turn with the message.

const live = z
  .object({
    OSTRA_DEV_MODEL_BASE_URL: z.url(),
    OSTRA_DEV_MODEL_API_KEY: z.string().min(1),
    OSTRA_DEV_MODEL_ID: z.string().min(1),
  })
  .safeParse(process.env);

type ModelCall = { readonly at: number; readonly withTools: boolean; readonly marked: ReadonlySet<string> };

/** A pass-through in front of the provider that records each call's time and which markers it held. */
const startRecorder = async (upstreamBase: string, markers: readonly string[]) => {
  const upstream = new URL(upstreamBase);
  const calls: ModelCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const text = body.toString("utf8");
      calls.push({ at: Date.now(), withTools: text.includes('"tools"'), marked: new Set(markers.filter((marker) => text.includes(marker))) });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(name)) {
          headers.set(name, value);
        }
      }
      fetch(new URL(request.url ?? "/", upstream.origin), { method: request.method ?? "POST", headers, body: request.method === "GET" ? null : body })
        .then((answer) => {
          const out: Record<string, string> = {};
          answer.headers.forEach((value, name) => {
            if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) {
              out[name] = value;
            }
          });
          response.writeHead(answer.status, out);
          if (answer.body === null) {
            response.end();
            return;
          }
          Readable.fromWeb(answer.body).pipe(response);
        })
        .catch(() => {
          response.writeHead(502).end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}${upstream.pathname.replace(/\/+$/, "")}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
};

describe.skipIf(!live.success)("steering on the real model, live with OpenCode (F-024)", () => {
  it("F-024: a steer mid-turn during a tool step reaches the next model call, and an interrupt cancels within 5 s and starts the next turn with the message", async () => {
    if (!live.success) {
      return;
    }
    const config = live.data;
    const suffix = randomBytes(3).toString("hex");
    const steerMark = `kestrel-${suffix}`;
    const interruptMark = `heron-${suffix}`;
    const recorder = await startRecorder(config.OSTRA_DEV_MODEL_BASE_URL, [steerMark, interruptMark]);
    const shared = await startShared("live-steering");
    let harness: Harness | undefined;
    try {
      harness = await startHarness(shared, { agents: defaultAgents() });
      const h = harness;
      const made = h.taskFor(
        `Run exactly this shell command and wait for it to finish: node -e "setTimeout(() => console.log('slept'), 20000)". Then reply with one short sentence.`,
        {
          agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: config.OSTRA_DEV_MODEL_ID },
          environment: { ...taskSpecFixture.environment, setupScript: null },
          limits: { turnMaxMinutes: 10, idleMinutes: 60 },
        },
      );
      const spec: TaskSpec = made.spec;
      h.server.tasks.set(spec.taskId, {
        spec,
        credentials: taskCredentialsSchema.parse({
          ...made.credentials,
          model: { baseUrl: recorder.baseUrl, apiFormat: "anthropic-messages", authScheme: "x-api-key", token: config.OSTRA_DEV_MODEL_API_KEY },
        }),
      });
      h.dispatch(spec);

      // 1. "Send" during the tool step: steered into the running turn, and the next model call carries it.
      await h.waitForKind(spec, "tool.called", 1, 300_000);
      const steeredAt = Date.now();
      const steer = h.command("steer", {
        sessionId: spec.sessionId,
        clientMessageId: `live-steer-${suffix}`,
        text: `When you reply, include the code word ${steerMark} in your sentence.`,
        delivery: "queue",
      });
      expect(await h.waitForAck(steer)).toMatchObject({ result: "done" });
      await h.waitForKind(spec, "session.saved", 1, 300_000);
      const nextCall = recorder.calls.find((call) => call.at > steeredAt && call.withTools);
      expect(nextCall?.marked.has(steerMark), "the next model call after the steer carried it").toBe(true);
      expect(h.ofKind(spec, "turn.started")).toHaveLength(1);
      console.info("live steer:", JSON.stringify({ callsAfterSteer: recorder.calls.filter((call) => call.at > steeredAt).length, carried: true }));

      // 2. "Interrupt and send" during a long tool step: cancelled within 5 s, then the message is the next turn.
      h.command("steer", {
        sessionId: spec.sessionId,
        clientMessageId: `live-long-${suffix}`,
        text: `Run exactly this shell command and wait for it to finish: node -e "setTimeout(() => console.log('slept'), 120000)". Then reply with one short sentence.`,
        delivery: "queue",
      });
      await h.waitForKind(spec, "tool.called", 2, 300_000);
      const interruptedAt = Date.now();
      const interrupt = h.command("steer", {
        sessionId: spec.sessionId,
        clientMessageId: `live-interrupt-${suffix}`,
        text: `Stop that. Reply with one sentence that includes the code word ${interruptMark}, and run no tool.`,
        delivery: "interrupt",
      });
      expect(await h.waitForAck(interrupt)).toMatchObject({ result: "accepted" });
      await h.waitForKind(spec, "turn.ended", 2, 60_000);
      const cancelledIn = Date.now() - interruptedAt;
      expect(h.ofKind(spec, "turn.ended")[1]?.stopReason).toBe("cancelled");
      expect(cancelledIn).toBeLessThan(5_000);
      await h.waitForKind(spec, "turn.started", 3, 60_000);
      await h.waitForKind(spec, "session.saved", 3, 300_000);
      const afterInterrupt = recorder.calls.find((call) => call.at > interruptedAt && call.withTools);
      expect(afterInterrupt?.marked.has(interruptMark), "the next turn's model call carried the message").toBe(true);
      console.info("live interrupt:", JSON.stringify({ cancelledInMs: cancelledIn, carried: true }));

      // Nothing secret in what the runner sent or logged.
      expect(JSON.stringify([h.eventsOf(spec), h.logs]).includes(config.OSTRA_DEV_MODEL_API_KEY)).toBe(false);
    } finally {
      await harness?.close().catch(() => undefined);
      await shared.close();
      await recorder.close();
    }
  }, 1_200_000);
});
