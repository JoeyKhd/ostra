import type { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { stopReasonSchema } from "@ostra/protocol";
import type { QuestionField, StopReason, TaskEvent } from "@ostra/protocol";
import { z } from "zod";

import { adapterError, ok } from "../../common/result.ts";
import type { AdapterError, AdapterResult } from "../../common/result.ts";
import type {
  AcpUpdate,
  AgentIo,
  DriverConnection,
  DriverHandlers,
  DriverPort,
  McpServer,
  PermissionAnswer,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
} from "../base.ts";
import { createAcpMapper } from "./map.ts";
import type { AcpMapper, LiveTextDelta } from "./map.ts";
import { isAlive, watchProcessTree } from "./process-tree.ts";

// ostra's own ACP driver (ADR 0018, ADR 0032), on the official `@agentclientprotocol/sdk` over the
// agent's stdio. Ported from spikes/how-should-the-runner-drive-opencode/src/lib/acp-driver.ts.
// Every `AgentAdapter` composes it through the `DriverPort`: the adapter says how to start its
// agent, the executor starts it, and the driver speaks ACP to whatever stdio it is handed.
//
// What it promises:
// - `initialize` advertises `elicitation.form`, so an agent's question reaches ostra instead of
//   being cancelled.
// - A cancel returns within `cancelGraceMs` (5 s): the turn ends `cancelled` even when the agent
//   never answers, and the agent's process tree is ended when the driver knows its PID.
// - Updates that `session/load` replays are not emitted as new events.
// - ACP payloads are vendor data: they're read with loose schemas, and no ACP type leaves this
//   file. Failures are values (`AdapterResult`), with messages that hold no agent content.

export type AcpDriverOptions = {
  readonly clientVersion?: string;
  /** How long `initialize` may take. Default 60 s. */
  readonly initializeTimeoutMs?: number;
  /** How long a cancelled turn may take to end before the driver ends it. Default 5 s (F-023). */
  readonly cancelGraceMs?: number;
  /** How long a closing agent has to exit on its own before its tree is killed. Default 3 s. */
  readonly closeGraceMs?: number;
  /** How often to snapshot the agent's process tree during a turn, to reap orphans. Default 2 s; 0 is off. */
  readonly treeSnapshotMs?: number;
  /** Partial text, as it's written (ADR 0035): the runner turns it into live-text frames. */
  readonly onLiveText?: (delta: LiveTextDelta & { readonly sessionId: string }) => void;
};

const STDERR_DRAIN = (): void => undefined;

// ---------- node streams as web streams ----------

const readableFromNode = (stream: Readable): ReadableStream<Uint8Array> => {
  let closed = false;
  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        stream.on("data", (chunk: Buffer) => {
          if (closed) {
            return;
          }
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          // Backpressure: stop reading the pipe, and the agent blocks on its own write.
          if ((controller.desiredSize ?? 0) <= 0) {
            stream.pause();
          }
        });
        stream.on("end", () => {
          if (closed) {
            return;
          }
          closed = true;
          controller.close();
        });
        stream.on("error", (error) => {
          if (closed) {
            return;
          }
          closed = true;
          controller.error(error);
        });
      },
      pull: () => {
        stream.resume();
      },
      cancel: () => {
        closed = true;
        stream.destroy();
      },
    },
    { highWaterMark: 64 },
  );
};

const writableFromNode = (stream: Writable): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
    close: () => {
      stream.end();
    },
    abort: () => {
      stream.destroy();
    },
  });

// ---------- what an agent sends, read loosely ----------

const updateNotificationSchema = z.looseObject({
  sessionId: z.string().min(1),
  update: z.looseObject({ sessionUpdate: z.string() }),
});

const permissionSchema = z.looseObject({
  toolCall: z.looseObject({ toolCallId: z.string(), title: z.string().nullish() }),
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() })),
});

const propertySchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  enum: z.array(z.unknown()).nullish(),
  oneOf: z.array(z.looseObject({ const: z.unknown().optional(), title: z.string().nullish() })).nullish(),
});
type Property = z.infer<typeof propertySchema>;

const elicitationSchema = z.looseObject({
  mode: z.string(),
  message: z.string(),
  requestedSchema: z.looseObject({ properties: z.record(z.string(), propertySchema).nullish() }).optional(),
});

const initializeSchema = z.looseObject({
  agentInfo: z.looseObject({ name: z.string().nullish(), version: z.string().nullish() }).nullish(),
  _meta: z.looseObject({ steering: z.looseObject({ supported: z.boolean().optional() }).optional() }).nullish(),
});

const sessionNewSchema = z.looseObject({ sessionId: z.string().min(1) });
const promptSchema = z.looseObject({ stopReason: z.string() });
const configResponseSchema = z.looseObject({
  configOptions: z.array(z.looseObject({ id: z.string(), currentValue: z.unknown().optional() })).nullish(),
});
const steerSchema = z.looseObject({ outcome: z.string().optional() });
const rpcErrorSchema = z.looseObject({ code: z.number() });

const fieldOptions = (property: Property): readonly string[] | undefined => {
  const fromEnum = (property.enum ?? []).filter((value): value is string => typeof value === "string");
  if (fromEnum.length > 0) {
    return fromEnum;
  }
  const fromOneOf = (property.oneOf ?? []).flatMap((option) => (typeof option.const === "string" ? [option.const] : []));
  return fromOneOf.length > 0 ? fromOneOf : undefined;
};

/** An ACP form's schema as ostra's question fields: text, or a select when the field has options. */
const toQuestionFields = (properties: Readonly<Record<string, Property>>): QuestionField[] =>
  Object.entries(properties).map(([id, property]) => {
    const options = fieldOptions(property);
    return {
      id: id.slice(0, 200),
      label: (property.title ?? property.description ?? id).slice(0, 2000),
      type: options === undefined ? "text" : "select",
      ...(options === undefined ? {} : { options: options.slice(0, 100).map((option) => option.slice(0, 500)) }),
    } satisfies QuestionField;
  });

/** A member's text answer as the value the form's field asks for: a number, a boolean or text. */
const coerceAnswer = (property: Property | undefined, answer: string): string | number | boolean => {
  const type = property?.type;
  if (type === "boolean") {
    return /^(?:true|yes|y|1|on)$/i.test(answer.trim());
  }
  if (type === "number" || type === "integer") {
    const value = Number(answer);
    return Number.isFinite(value) ? value : answer;
  }
  return answer;
};

// ---------- errors as values ----------

/** The SDK's errors once its transport is gone. */
const CLOSED_CONNECTION = /ACP (connection|outbound channel)( is)? closed|agent process ended/i;

/** What a failed call says, in ostra's words: never the agent's message, which may hold content. */
const describeFailure = (what: string, error: unknown, processEnded: boolean): AdapterError => {
  if (processEnded || (error instanceof Error && CLOSED_CONNECTION.test(error.message))) {
    return { code: "unavailable", message: `${what} failed: the agent's process ended` };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { code: "unavailable", message: `${what} failed: the agent did not answer in time` };
  }
  const rpc = rpcErrorSchema.safeParse(error);
  if (rpc.success) {
    return { code: "invalid-response", message: `${what} failed: the agent refused it (JSON-RPC ${String(rpc.data.code)})` };
  }
  return { code: "unavailable", message: `${what} failed unexpectedly` };
};

const toAcpMcpServer = (server: McpServer): acp.McpServer => ({
  type: "http",
  name: server.name,
  url: server.url,
  headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
});

// ---------- the driver ----------

const connectAgent = async (
  io: AgentIo,
  handlers: DriverHandlers,
  options: AcpDriverOptions,
): Promise<AdapterResult<DriverConnection>> => {
  const cancelGraceMs = options.cancelGraceMs ?? 5000;
  const closeGraceMs = options.closeGraceMs ?? 3000;
  const treeSnapshotMs = options.treeSnapshotMs ?? 2000;
  const pid = io.pid ?? null;
  const watch = pid === null ? undefined : watchProcessTree(pid);

  let ended = false;
  let closing = false;
  const endedSignal = new Promise<void>((resolve) => {
    io.stdout.once("close", () => {
      ended = true;
      resolve();
    });
    io.stdout.once("end", () => {
      ended = true;
      resolve();
    });
  });
  // Keep the agent's stderr drained, or a chatty agent blocks on a full pipe. It is never logged:
  // it may hold the agent's own content.
  io.stderr.on("data", STDERR_DRAIN);
  io.stdin.on("error", () => {
    // EPIPE after the agent died: surfaced through the calls that were waiting.
  });

  const replaying = new Set<string>();
  const wire = acp.ndJsonStream(writableFromNode(io.stdin), readableFromNode(io.stdout));
  // Session updates are taken off the wire here, before the SDK sees them. The SDK checks every
  // update against its own schema and throws on a kind it doesn't know, which stops that message
  // and every handler after it: an update would be dropped silently (ADR 0018). Read with a loose
  // schema of ours, an update of any kind reaches the mapping, which makes an unknown one visible.
  // Messages keep their order, so a `session/load`'s replay is over when its answer comes.
  const stream = {
    writable: wire.writable,
    readable: wire.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform: (message, controller) => {
          if ("method" in message && !("id" in message) && message.method === acp.methods.client.session.update) {
            const notification = updateNotificationSchema.safeParse(message.params);
            if (notification.success && !replaying.has(notification.data.sessionId)) {
              handlers.onUpdate(notification.data.sessionId, notification.data.update);
            }
            return;
          }
          controller.enqueue(message);
        },
      }),
    ),
  };
  const app = acp
    .client({ name: "ostra-runner" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx): Promise<acp.RequestPermissionResponse> => {
      const parsed = permissionSchema.safeParse(ctx.params);
      if (!parsed.success) {
        return { outcome: { outcome: "cancelled" } };
      }
      const request: PermissionRequest = {
        toolCallId: parsed.data.toolCall.toolCallId,
        title: parsed.data.toolCall.title ?? "",
        options: parsed.data.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
      };
      const answer: PermissionAnswer = await handlers.onPermission(ctx.params.sessionId, request, ctx.signal);
      return answer.outcome === "selected"
        ? { outcome: { outcome: "selected", optionId: answer.optionId } }
        : { outcome: { outcome: "cancelled" } };
    })
    .onRequest(acp.methods.client.elicitation.create, async (ctx): Promise<acp.CreateElicitationResponse> => {
      const parsed = elicitationSchema.safeParse(ctx.params);
      // Only forms reach a member: a URL or an unknown mode is cancelled, as the agent expects.
      if (!parsed.success || parsed.data.mode !== "form") {
        return { action: "cancel" };
      }
      const properties = parsed.data.requestedSchema?.properties ?? {};
      const request: QuestionRequest = { message: parsed.data.message, fields: toQuestionFields(properties) };
      const sessionId = z.looseObject({ sessionId: z.string().optional() }).parse(ctx.params).sessionId ?? "";
      const answer: QuestionAnswer = await handlers.onQuestion(sessionId, request, ctx.signal);
      switch (answer.outcome) {
        case "answered":
          return {
            action: "accept",
            content: Object.fromEntries(
              Object.entries(answer.answers).map(([id, value]) => [id, coerceAnswer(properties[id], value)]),
            ),
          };
        case "declined":
          return { action: "decline" };
        case "cancelled":
          return { action: "cancel" };
        default:
          return answer satisfies never;
      }
    });
  const connection = app.connect(stream);

  /** Waits for `work`, ending early with a typed failure when the agent's process ends. */
  const guarded = async <T,>(what: string, work: Promise<T>, timeoutMs?: number): Promise<AdapterResult<T>> => {
    const timeout =
      timeoutMs === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
            }, timeoutMs).unref();
          });
    const gone = endedSignal.then((): never => {
      throw new Error("agent process ended");
    });
    try {
      return ok(await Promise.race(timeout === undefined ? [work, gone] : [work, gone, timeout]));
    } catch (error) {
      return { ok: false, error: describeFailure(what, error, ended) };
    }
  };

  const killTree = async (): Promise<void> => {
    if (watch !== undefined) {
      await watch.killAll();
    }
  };

  const initialized = await guarded(
    "starting the agent",
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        session: { compaction: {} },
        plan: {},
      },
      clientInfo: { name: "ostra-runner", title: "ostra", version: options.clientVersion ?? "0.0.0" },
    }),
    options.initializeTimeoutMs ?? 60_000,
  );
  if (!initialized.ok) {
    // The agent must not outlive the attempt.
    await killTree();
    connection.close(new Error("initialize failed"));
    return initialized;
  }
  const info = initializeSchema.safeParse(initialized.value);
  const steeringAdvertised = info.success && info.data._meta?.steering?.supported === true;

  // Turns in flight, by the agent's session ID: a cancel needs the one it's cancelling.
  type Turn = { readonly startedAt: number; cancelled: boolean; readonly graceExpired: Promise<void>; readonly expire: () => void };
  const turns = new Map<string, Turn>();

  let snapshotTimer: NodeJS.Timeout | undefined;
  const startSnapshots = (): void => {
    if (watch === undefined || treeSnapshotMs <= 0 || snapshotTimer !== undefined) {
      return;
    }
    let running = false;
    snapshotTimer = setInterval(() => {
      if (running) {
        return;
      }
      running = true;
      void watch.snapshot().finally(() => {
        running = false;
      });
    }, treeSnapshotMs);
    snapshotTimer.unref();
  };
  const stopSnapshots = (): void => {
    if (snapshotTimer !== undefined) {
      clearInterval(snapshotTimer);
      snapshotTimer = undefined;
    }
  };

  const mcp = (servers: readonly McpServer[]): acp.McpServer[] => servers.map(toAcpMcpServer);

  const configEvents = (configId: string, value: string, response: unknown): readonly TaskEvent[] => {
    const parsed = configResponseSchema.safeParse(response);
    const current = parsed.success ? parsed.data.configOptions?.find((option) => option.id === configId)?.currentValue : undefined;
    const shown = typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? String(current) : value;
    return [{ kind: "session.config_changed", key: configId.slice(0, 200), value: shown.slice(0, 2000) }];
  };

  const driverConnection: DriverConnection = {
    agentName: info.success ? (info.data.agentInfo?.name ?? null) : null,
    agentVersion: info.success ? (info.data.agentInfo?.version ?? null) : null,
    steeringAdvertised,

    newSession: async (input) => {
      const created = await guarded(
        "starting a session",
        connection.agent.request(acp.methods.agent.session.new, { cwd: input.cwd, mcpServers: mcp(input.mcpServers) }),
      );
      if (!created.ok) {
        return created;
      }
      const parsed = sessionNewSchema.safeParse(created.value);
      return parsed.success
        ? ok({ agentSessionId: parsed.data.sessionId })
        : adapterError("invalid-response", "the agent's new session had no ID");
    },

    loadSession: async (input) => {
      replaying.add(input.agentSessionId);
      try {
        const loaded = await guarded(
          "resuming the session",
          connection.agent.request(acp.methods.agent.session.load, {
            sessionId: input.agentSessionId,
            cwd: input.cwd,
            mcpServers: mcp(input.mcpServers),
          }),
        );
        // The replayed updates arrive before the answer; let any still being dispatched land first.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        return loaded.ok ? ok(undefined) : loaded;
      } finally {
        replaying.delete(input.agentSessionId);
      }
    },

    prompt: async (agentSessionId, text) => {
      let expire: () => void = () => undefined;
      const graceExpired = new Promise<void>((resolve) => {
        expire = resolve;
      });
      const turn: Turn = { startedAt: Date.now(), cancelled: false, graceExpired, expire };
      turns.set(agentSessionId, turn);
      startSnapshots();
      try {
        const answered = guarded(
          "running the turn",
          connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: agentSessionId,
            prompt: [{ type: "text", text }],
          }),
        );
        // A cancel the agent never answers ends the turn here, and the agent with it.
        const result = await Promise.race([answered, graceExpired.then(() => "grace-expired" as const)]);
        if (result === "grace-expired") {
          await killTree();
          return ok({ stopReason: "cancelled" satisfies StopReason });
        }
        if (!result.ok) {
          return result;
        }
        const parsed = promptSchema.safeParse(result.value);
        if (!parsed.success) {
          return adapterError("invalid-response", "the agent's answer to the turn had no stop reason");
        }
        // A stop reason this build doesn't know ends the turn as `end_turn`, rather than failing it.
        const stopReason = stopReasonSchema.safeParse(parsed.data.stopReason);
        const reason: StopReason = stopReason.success ? stopReason.data : "end_turn";
        if (reason === "cancelled" && watch !== undefined) {
          await watch.reapBornSince(turn.startedAt);
        }
        return ok({ stopReason: reason });
      } finally {
        turns.delete(agentSessionId);
        if (turns.size === 0) {
          stopSnapshots();
        }
      }
    },

    cancel: async (agentSessionId) => {
      const turn = turns.get(agentSessionId);
      if (turn !== undefined && !turn.cancelled) {
        turn.cancelled = true;
        setTimeout(turn.expire, cancelGraceMs).unref();
      }
      try {
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: agentSessionId });
      } catch {
        // The connection is gone: the turn ends through its own failure.
      }
    },

    steer: async (agentSessionId, text) => {
      if (!steeringAdvertised) {
        return adapterError("unsupported", "the agent did not advertise mid-turn steering");
      }
      const steered = await guarded(
        "steering the turn",
        connection.agent.request("_session/steering", { sessionId: agentSessionId, prompt: [{ type: "text", text }] }),
      );
      if (!steered.ok) {
        return steered;
      }
      const outcome = steerSchema.safeParse(steered.value);
      return outcome.success && outcome.data.outcome === "injected"
        ? ok(undefined)
        : adapterError("conflict", "the agent had no running turn to steer");
    },

    setConfigOption: async (agentSessionId, configId, value) => {
      const set = await guarded(
        "changing the session's configuration",
        connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: agentSessionId, configId, value }),
      );
      return set.ok ? ok(configEvents(configId, value, set.value)) : set;
    },

    setMode: async (agentSessionId, modeId) => {
      const set = await guarded(
        "changing the session's mode",
        connection.agent.request(acp.methods.agent.session.setMode, { sessionId: agentSessionId, modeId }),
      );
      return set.ok ? ok<readonly TaskEvent[]>([{ kind: "session.config_changed", key: "mode", value: modeId.slice(0, 2000) }]) : set;
    },

    close: async () => {
      if (closing) {
        return;
      }
      closing = true;
      stopSnapshots();
      if (watch !== undefined && !ended) {
        await watch.snapshot();
      }
      io.stdin.end();
      await Promise.race([
        endedSignal,
        new Promise<void>((resolve) => {
          setTimeout(resolve, closeGraceMs).unref();
        }),
      ]);
      // No process of the agent's outlives its session: end what didn't leave on its own.
      if (pid !== null && isAlive(pid)) {
        await killTree();
      } else if (watch !== undefined) {
        await watch.reap();
      }
      connection.close(new Error("ostra closed the connection"));
    },
  };
  return ok(driverConnection);
};

/** `createAcpDriver` is what an adapter hands to `AgentAdapter`'s constructor. */
export const createAcpDriver = (options: AcpDriverOptions = {}): DriverPort => {
  // One mapper per ostra session, which holds the open text segment between updates.
  const mappers = new Map<string, AcpMapper>();
  const mapperFor = (sessionId: string): AcpMapper => {
    const existing = mappers.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createAcpMapper(
      options.onLiveText === undefined
        ? {}
        : { onLiveText: (delta) => options.onLiveText?.({ ...delta, sessionId }) },
    );
    mappers.set(sessionId, created);
    return created;
  };
  return {
    connect: (io, handlers) => connectAgent(io, handlers, options),
    mapUpdate: (update: AcpUpdate, context) => mapperFor(String(context.sessionId)).map(update, context),
    finishTurn: (context) => mapperFor(String(context.sessionId)).finishTurn(context),
    closeSession: (sessionId) => {
      mappers.delete(String(sessionId));
    },
  };
};
