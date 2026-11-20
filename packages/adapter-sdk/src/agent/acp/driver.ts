import type { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { optionIdSchema, stopReasonSchema, subagentIdSchema, toolCallIdSchema } from "@ostra/protocol";
import type { QuestionField, StopReason, SubagentId, TaskEvent, ToolCallId } from "@ostra/protocol";
import { z } from "zod";

import { adapterError, ok } from "../../common/result.ts";
import type { AdapterError, AdapterResult } from "../../common/result.ts";
import type {
  AcpUpdate,
  AgentIo,
  ConnectOptions,
  DriverConnection,
  DriverHandlers,
  DriverPort,
  McpServer,
  PermissionAnswer,
  PermissionRequest,
  PromptOutcome,
  QuestionAnswer,
  QuestionRequest,
  SessionConfigOption,
  SubagentRef,
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
//   never answers, and the agent's process tree is ended when the driver knows its PID. The reap
//   of the turn's processes counts against the same budget: a listing can wait for the one in
//   flight, and takes a PowerShell's seconds on a Windows machine where koffi can't load, so a reap
//   still running at the deadline finishes after the turn has ended, limited to the processes born
//   during that turn.
// - Updates that `session/load` replays are not emitted as new events.
// - With `subagents: "background"` (OpenCode), a turn waits for its subagents (below, "Subagents"),
//   and each subagent's updates, states and approvals are named as its own (F-138).
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
  /**
   * With `subagents: "background"`: how long a turn waits, after its prompt is answered, for its
   * subagents and the turns their reports wake. Past it the driver stops them and ends the turn.
   * Default 30 minutes (`OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`).
   */
  readonly subagentWaitMs?: number;
  /** How often a waiting turn asks whether the agent is still at work, once no subagent runs. Default 1 s. */
  readonly idlePollMs?: number;
  /**
   * How long a turn waits, once its last subagent ended, for the agent to wake for its report
   * before it counts the report as already read. Default 10 s: the wake is local, no model call.
   */
  readonly wakeGraceMs?: number;
};

/** `subagentWaitMs`' default: 30 minutes. */
export const DEFAULT_SUBAGENT_WAIT_MS = 30 * 60_000;

const STDERR_DRAIN = (): void => undefined;

/** What a cancel's budget keeps back from its reap, for the turn's own end (F-023). */
const REAP_MARGIN_MS = 500;

/** Resolves after `ms` (at once for 0 or less), without holding the process open. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

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
  toolCall: z.looseObject({
    toolCallId: toolCallIdSchema,
    title: z.string().nullish(),
    // Milestone 3: what the request touches, for the rules (ADR 0049). Vendor data, read loosely.
    kind: z.string().nullish(),
    rawInput: z.unknown().optional(),
    locations: z.array(z.looseObject({ path: z.string() })).nullish().catch(null),
    // F-138: OpenCode names the subagent whose call asks.
    _meta: z.record(z.string(), z.unknown()).nullish().catch(null),
  }),
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

/** One value of a select option, or a group of them (ACP's `SessionConfigSelectOptions`). */
const selectValueSchema = z.looseObject({ value: z.string() });
const selectGroupSchema = z.looseObject({ options: z.array(z.unknown()) });

/** A session's `configOptions` (milestone 4, F-137): read loosely, one option at a time. */
const configOptionsSchema = z.looseObject({ configOptions: z.array(z.unknown()).nullish() });
const configOptionSchema = z.looseObject({
  id: z.string().min(1),
  category: z.string().nullish(),
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).nullish(),
});

const valuesOf = (entries: readonly unknown[]): readonly string[] =>
  entries.flatMap((entry): readonly string[] => {
    const value = selectValueSchema.safeParse(entry);
    if (value.success) {
      return [value.data.value];
    }
    const group = selectGroupSchema.safeParse(entry);
    return group.success ? valuesOf(group.data.options) : [];
  });

/**
 * The config options a `session/new` or `session/load` answer advertised. The agent owns their
 * shape, so one that doesn't parse is skipped, never the session.
 */
export const parseConfigOptions = (response: unknown): readonly SessionConfigOption[] => {
  const parsed = configOptionsSchema.safeParse(response);
  if (!parsed.success) {
    return [];
  }
  return (parsed.data.configOptions ?? []).flatMap((raw): readonly SessionConfigOption[] => {
    const option = configOptionSchema.safeParse(raw);
    if (!option.success) {
      return [];
    }
    const current = option.data.currentValue;
    return [
      {
        id: option.data.id,
        category: option.data.category ?? null,
        currentValue: typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? String(current) : null,
        values: valuesOf(option.data.options ?? []),
      },
    ];
  });
};
const promptSchema = z.looseObject({ stopReason: z.string() });
const configResponseSchema = z.looseObject({
  configOptions: z.array(z.looseObject({ id: z.string(), currentValue: z.unknown().optional() })).nullish(),
});
const steerSchema = z.looseObject({ outcome: z.string().optional() });
const rpcErrorSchema = z.looseObject({ code: z.number() });

// ---------- subagents ----------
//
// OpenCode 2.3.2 runs every subagent in the background: its `subagent` call ends at once, the
// agent is told to end its turn, and each subagent's report wakes the agent again later, with no
// prompt in flight (`research/opencode-subagents.md`). The driver asks for OpenCode's extension
// `opencode/child-session-updates`, so each child session's updates and states arrive as
// `opencode/session/child_update` notifications, past the prompt's answer too. A turn then ends
// only when its prompt has been answered, no child is `created` or `running`, and the agent has
// been at work after the last one ended and is idle again. Whether it's idle, ACP doesn't say: the
// driver asks with `_session/steering` and a prompt OpenCode refuses before injecting it (an image
// with neither data nor URI). OpenCode checks for a running turn first, so an idle session answers
// `promptRequired` and a busy one refuses the prompt (`-32602`, field `prompt`): nothing is ever
// injected. Without both extensions advertised, a turn ends with its prompt's answer, as before.

/** The client capability that asks OpenCode for its child sessions' updates. */
const CHILD_SESSION_UPDATES = "opencode/child-session-updates";
/** The notification that carries them. */
const CHILD_UPDATE_METHOD = "opencode/session/child_update";

const agentMetaSchema = z.looseObject({
  agentCapabilities: z.looseObject({ _meta: z.record(z.string(), z.unknown()).nullish() }).nullish(),
});

const childUpdateSchema = z.looseObject({
  rootSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  // F-138: who started it and how deep it is, for the tree.
  parentSessionId: z.string().min(1).optional().catch(undefined),
  depth: z.number().int().positive().optional().catch(undefined),
  type: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }).optional(),
  status: z.string().optional(),
  error: z.unknown().optional(),
});

/** OpenCode's own name for a child session's update, on the update itself (`_meta["opencode/child-session"]`). */
const CHILD_SESSION_META = "opencode/child-session";
const childMetaSchema = z.looseObject({
  id: z.string().min(1),
  parentID: z.string().min(1).optional().catch(undefined),
  depth: z.number().int().positive().optional().catch(undefined),
});

/** The child session a `_meta` names, when it names one. */
const childOfMeta = (meta: unknown): z.infer<typeof childMetaSchema> | undefined => {
  const record = z.record(z.string(), z.unknown()).safeParse(meta);
  const child = childMetaSchema.safeParse(record.success ? record.data[CHILD_SESSION_META] : undefined);
  return child.success ? child.data : undefined;
};

/** A failed subagent's error, as words: OpenCode's text, or the message of its error object. */
const errorWords = (error: unknown): string | undefined => {
  if (typeof error === "string" && error !== "") {
    return error;
  }
  const message = z.looseObject({ message: z.string().min(1) }).safeParse(error);
  if (message.success) {
    return message.data.message;
  }
  const data = z.looseObject({ data: z.looseObject({ message: z.string().min(1) }) }).safeParse(error);
  return data.success ? data.data.data.message : undefined;
};

const childStatusSchema = z.enum(["created", "running", "completed", "failed", "interrupted"]);
type ChildStatus = z.infer<typeof childStatusSchema>;

const isOpen = (status: ChildStatus): boolean => status === "created" || status === "running";

/** The main agent's `subagent` call, once it ended: its output names the child session it started. */
const startedChildSchema = z.looseObject({
  sessionUpdate: z.literal("tool_call_update"),
  toolCallId: toolCallIdSchema,
  rawOutput: z.looseObject({ metadata: z.looseObject({ sessionID: z.string().min(1) }) }),
});

/** How long the probe may take before the agent counts as at work. */
const PROBE_TIMEOUT_MS = 5000;

/** How long a prompt waits for its session to be attached again after a cancel stopped its subagents. */
const RESUME_WAIT_MS = 30_000;

/** The steering probe's prompt: OpenCode refuses it before it reaches the session (`ACPPrompt.prepare`). */
const IDLE_PROBE_PROMPT = [{ type: "image", mimeType: "image/png", data: "" }] as const;

/** A refusal of the probe's prompt: the session has a running turn. */
const probeRefusedSchema = z.looseObject({ code: z.literal(-32602), data: z.looseObject({ field: z.literal("prompt") }) });

/** One session's subagents, as OpenCode reported them. */
type Subagents = {
  /** Each child session's last state, nested ones included. */
  readonly children: Map<string, ChildStatus>;
  /** F-138: each child as the page names it: its ID, its parent and its depth. */
  readonly refs: Map<string, SubagentRef>;
  /** The main agent's call that started each child. */
  readonly startedBy: Map<string, ToolCallId>;
  /** When a child last ended, and when the main session last sent an update, in ms since the epoch. */
  lastChildEndAt: number;
  lastRootUpdateAt: number;
  /** When the probe last found the agent at work. */
  lastBusyAt: number;
  /** Wakes a waiting turn: a child's state changed, or the turn was cancelled. */
  waiters: (() => void)[];
};

const openChildren = (subagents: Subagents): readonly string[] =>
  [...subagents.children].flatMap(([child, status]) => (isOpen(status) ? [child] : []));

const wake = (subagents: Subagents): void => {
  const waiting = subagents.waiters;
  subagents.waiters = [];
  for (const resolve of waiting) {
    resolve();
  }
};

/** Resolves on the next `wake`, or after `ms`. */
const nextChange = (subagents: Subagents, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
    subagents.waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });

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
  connectOptions: ConnectOptions,
): Promise<AdapterResult<DriverConnection>> => {
  const cancelGraceMs = options.cancelGraceMs ?? 5000;
  const closeGraceMs = options.closeGraceMs ?? 3000;
  const treeSnapshotMs = options.treeSnapshotMs ?? 2000;
  const subagentWaitMs = options.subagentWaitMs ?? DEFAULT_SUBAGENT_WAIT_MS;
  const idlePollMs = options.idlePollMs ?? 1000;
  const wakeGraceMs = options.wakeGraceMs ?? 10_000;
  const asksForSubagents = connectOptions.subagents === "background";
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
  // Subagents, by the session that started them: set once `initialize` says the agent sends them.
  let tracksSubagents = false;
  const subagentsBySession = new Map<string, Subagents>();
  const subagentsOf = (agentSessionId: string): Subagents => {
    const existing = subagentsBySession.get(agentSessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Subagents = { children: new Map(), refs: new Map(), startedBy: new Map(), lastChildEndAt: 0, lastRootUpdateAt: 0, lastBusyAt: 0, waiters: [] };
    subagentsBySession.set(agentSessionId, created);
    return created;
  };
  /**
   * F-138: a child session as the page names it, relative to the session that started the tree: no
   * parent when the main agent started it. Kept, so a later notice that names no parent still has one.
   * `undefined` when the adapter reports no subagents, or the agent's IDs can't be ostra's.
   */
  const refOf = (rootSessionId: string, childSessionId: string, parentSessionId: string | undefined, depth: number | undefined): SubagentRef | undefined => {
    if (!asksForSubagents) {
      return undefined;
    }
    const subagents = subagentsOf(rootSessionId);
    const known = subagents.refs.get(childSessionId);
    const id = subagentIdSchema.safeParse(childSessionId);
    if (!id.success) {
      return undefined;
    }
    const parent = parentSessionId === undefined || parentSessionId === rootSessionId ? null : subagentIdSchema.safeParse(parentSessionId);
    const parentId: SubagentId | null = parent === null ? null : parent.success ? parent.data : null;
    const ref: SubagentRef = {
      id: id.data,
      parentId: parentSessionId === undefined ? (known?.parentId ?? null) : parentId,
      depth: depth ?? known?.depth ?? (parentId === null ? 1 : (subagents.refs.get(parentId)?.depth ?? 1) + 1),
    };
    subagents.refs.set(childSessionId, ref);
    return ref;
  };
  /** A child session's update or state, from `opencode/session/child_update`. */
  const onChildUpdate = (params: unknown): void => {
    const parsed = childUpdateSchema.safeParse(params);
    if (!parsed.success) {
      return;
    }
    const { rootSessionId, childSessionId, parentSessionId, depth, type, update, status, error } = parsed.data;
    const ref = refOf(rootSessionId, childSessionId, parentSessionId, depth);
    if (type === "update" && update !== undefined) {
      // A nested subagent starts from its parent's call, whose ID OpenCode prefixes with the parent's session.
      const started = tracksSubagents ? startedChildSchema.safeParse(update) : undefined;
      if (started?.success === true) {
        subagentsOf(rootSessionId).startedBy.set(started.data.rawOutput.metadata.sessionID, started.data.toolCallId);
      }
      // As OpenCode projects it without the extension: the child's `_meta`, its prefixed call IDs.
      // F-138: named as the subagent's, so its calls and its answer are its own.
      if (replaying.has(rootSessionId)) {
        handlers.onReplay?.(rootSessionId, update);
      } else {
        handlers.onUpdate(rootSessionId, update, ref);
      }
      return;
    }
    const state = childStatusSchema.safeParse(status);
    if (type !== "status" || !state.success) {
      return;
    }
    if (ref !== undefined && !replaying.has(rootSessionId)) {
      const words = state.data === "failed" ? errorWords(error) : undefined;
      handlers.onSubagentStatus?.(rootSessionId, { subagent: ref, status: state.data, ...(words === undefined ? {} : { error: words }) });
    }
    if (!tracksSubagents) {
      return;
    }
    const subagents = subagentsOf(rootSessionId);
    subagents.children.set(childSessionId, state.data);
    if (!isOpen(state.data)) {
      subagents.lastChildEndAt = Date.now();
    }
    wake(subagents);
  };
  /**
   * F-138: a child's update OpenCode projected onto the session itself (no extension, or a turn's
   * own child): its `_meta` names the child.
   */
  const projectedChild = (agentSessionId: string, update: AcpUpdate): SubagentRef | undefined => {
    if (!asksForSubagents) {
      return undefined;
    }
    const child = childOfMeta(update["_meta"]);
    return child === undefined ? undefined : refOf(agentSessionId, child.id, child.parentID, child.depth);
  };
  /** An update of a session's own: the agent is at work, and its `subagent` call may name a child. */
  const onSessionUpdate = (agentSessionId: string, update: AcpUpdate): void => {
    if (!tracksSubagents) {
      return;
    }
    const subagents = subagentsOf(agentSessionId);
    subagents.lastRootUpdateAt = Date.now();
    const started = startedChildSchema.safeParse(update);
    if (started.success) {
      subagents.startedBy.set(started.data.rawOutput.metadata.sessionID, started.data.toolCallId);
    }
  };
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
            if (notification.success) {
              if (replaying.has(notification.data.sessionId)) {
                handlers.onReplay?.(notification.data.sessionId, notification.data.update);
              } else {
                const child = projectedChild(notification.data.sessionId, notification.data.update);
                if (child === undefined) {
                  onSessionUpdate(notification.data.sessionId, notification.data.update);
                }
                handlers.onUpdate(notification.data.sessionId, notification.data.update, child);
              }
            }
            return;
          }
          if ("method" in message && !("id" in message) && message.method === CHILD_UPDATE_METHOD) {
            onChildUpdate(message.params);
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
      const { kind, rawInput, locations } = parsed.data.toolCall;
      // F-138: a subagent's call names it in `_meta`, so the approval can say which subagent asks.
      const child = asksForSubagents ? childOfMeta(parsed.data.toolCall._meta) : undefined;
      const subagent = child === undefined ? undefined : refOf(ctx.params.sessionId, child.id, child.parentID, child.depth);
      const request: PermissionRequest = {
        toolCallId: parsed.data.toolCall.toolCallId,
        title: parsed.data.toolCall.title ?? "",
        ...(subagent === undefined ? {} : { subagentId: subagent.id }),
        ...(typeof kind === "string" ? { toolKind: kind } : {}),
        ...(rawInput === undefined ? {} : { rawInput }),
        ...(locations === null || locations === undefined ? {} : { locations: locations.map((location) => location.path) }),
        // An option whose ID can't be an ID is left out; the IDs are parsed here, once.
        options: parsed.data.options.flatMap((option) => {
          const optionId = optionIdSchema.safeParse(option.optionId);
          return optionId.success ? [{ optionId: optionId.data, name: option.name, kind: option.kind }] : [];
        }),
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
        // OpenCode's own extension: its subagents' updates and states, past the turn's answer too.
        ...(asksForSubagents ? { _meta: { [CHILD_SESSION_UPDATES]: true } } : {}),
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
  // A turn can wait for subagents only when the agent sends their states and the probe can ask it.
  const agentMeta = agentMetaSchema.safeParse(initialized.value);
  tracksSubagents = asksForSubagents && steeringAdvertised && agentMeta.success && agentMeta.data.agentCapabilities?._meta?.[CHILD_SESSION_UPDATES] === true;

  // Turns in flight, by the agent's session ID: a cancel needs the one it's cancelling.
  type Turn = {
    readonly startedAt: number;
    /** When ostra cancelled it, ms since the epoch; null while it runs on. */
    cancelledAt: number | null;
    readonly graceExpired: Promise<void>;
    readonly expire: () => void;
    /** A subagent ran when ostra cancelled the turn: what OpenCode follows of the session stops too. */
    subagentsAtCancel: boolean;
    /** The turn waits for its subagents (its prompt was answered). */
    waiting: boolean;
    /** Members' messages the agent couldn't take mid-turn while it waited idle: the turn's next prompts. */
    readonly queued: string[];
  };
  const turns = new Map<string, Turn>();

  /** Read afresh after an await: the agent's end and a cancel come from callbacks. */
  const hasEnded = (): boolean => ended;
  const cancelledAtOf = (turn: Turn): number => turn.cancelledAt ?? Date.now();

  // Each session's folder and MCP servers, to attach it again after its subagents were stopped.
  const sessionInputs = new Map<string, { readonly cwd: string; readonly mcpServers: readonly McpServer[] }>();
  // A `session/resume` still in flight past a cancel's budget: the session's next prompt waits for it.
  const resuming = new Map<string, Promise<void>>();

  /** Waits for `work` until `until` (ms since the epoch) at most, or the agent's end. What it stops may be gone already: a failure is no matter. */
  const within = async (work: Promise<unknown>, until: number): Promise<void> => {
    await Promise.race([work.catch(() => undefined), delay(until - Date.now()), endedSignal]);
  };

  /** Whether the agent is at work on the session, by the steering probe ("Subagents", above). */
  const probeIdle = async (agentSessionId: string): Promise<"idle" | "busy" | "gone"> => {
    if (ended) {
      return "gone";
    }
    try {
      const answer = await Promise.race([
        connection.agent.request("_session/steering", { sessionId: agentSessionId, prompt: IDLE_PROBE_PROMPT.map((block) => ({ ...block })) }),
        endedSignal.then(() => "gone" as const),
        delay(PROBE_TIMEOUT_MS).then(() => "slow" as const),
      ]);
      if (answer === "gone") {
        return "gone";
      }
      // An agent too slow to answer is taken as at work: the wait's bound still holds.
      if (answer === "slow") {
        return "busy";
      }
      const outcome = steerSchema.safeParse(answer);
      return outcome.success && outcome.data.outcome === "injected" ? "busy" : "idle";
    } catch (error) {
      if (hasEnded()) {
        return "gone";
      }
      return probeRefusedSchema.safeParse(error).success ? "busy" : "idle";
    }
  };

  const closeSession = (agentSessionId: string): Promise<unknown> =>
    connection.agent.request(acp.methods.agent.session.close, { sessionId: agentSessionId });

  /**
   * Stops what a cancelled or timed-out turn left at work, by `until`: each running subagent
   * (`session/close` on a child session interrupts it, and nothing else), then the agent's own turn
   * and OpenCode's follower of the session (`session/close` on it), and attaches the session again
   * for the next turn (`session/resume`). `session/cancel` can't: it reaches a prompt in flight only.
   */
  const stopSubagents = async (agentSessionId: string, until: number): Promise<void> => {
    const subagents = subagentsOf(agentSessionId);
    const open = openChildren(subagents);
    // F-138: what was stopped is reported as such, for the page: OpenCode won't report it now.
    const report = (): void => {
      for (const child of open) {
        const ref = subagents.refs.get(child);
        if (ref !== undefined && subagents.children.get(child) !== "interrupted") {
          handlers.onSubagentStatus?.(agentSessionId, { subagent: ref, status: "interrupted" });
        }
      }
    };
    await within(Promise.all(open.map(closeSession)), until);
    await within(closeSession(agentSessionId), until);
    const input = sessionInputs.get(agentSessionId);
    if (input !== undefined) {
      const resumed = connection.agent
        .request(acp.methods.agent.session.resume, { sessionId: agentSessionId, cwd: input.cwd, mcpServers: mcp(input.mcpServers) })
        .then(() => undefined, () => undefined)
        .finally(() => {
          resuming.delete(agentSessionId);
        });
      resuming.set(agentSessionId, resumed);
      await within(resumed, until);
    }
    // Their end won't be reported now: OpenCode no longer follows the session.
    report();
    for (const child of open) {
      subagents.children.set(child, "interrupted");
    }
    subagents.lastChildEndAt = Date.now();
  };

  /**
   * After the prompt's answer: waits until no subagent of the session runs, and the agent was at
   * work after the last one ended and is idle again; or until the turn is cancelled, the wait
   * runs out or the agent ends. A member's message queued meanwhile goes in as the next prompt.
   */
  const waitForSubagents = async (agentSessionId: string, turn: Turn): Promise<"settled" | "cancelled" | "timed-out" | "gone"> => {
    const subagents = subagentsOf(agentSessionId);
    const deadline = Date.now() + subagentWaitMs;
    turn.waiting = true;
    try {
      for (;;) {
        if (turn.cancelledAt !== null) {
          return "cancelled";
        }
        if (ended) {
          return "gone";
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          return "timed-out";
        }
        const queued = turn.queued.shift();
        if (queued !== undefined) {
          await Promise.race([
            guarded("running the turn", connection.agent.request(acp.methods.agent.session.prompt, { sessionId: agentSessionId, prompt: [{ type: "text", text: queued }] })),
            turn.graceExpired,
            delay(left),
          ]);
          continue;
        }
        if (openChildren(subagents).length > 0) {
          await Promise.race([nextChange(subagents, left), endedSignal]);
          continue;
        }
        // No subagent runs: the last one's report wakes the agent, if it isn't at work already.
        const state = await probeIdle(agentSessionId);
        if (state === "gone") {
          return "gone";
        }
        if (state === "busy") {
          subagents.lastBusyAt = Date.now();
        } else {
          const worked = Math.max(subagents.lastRootUpdateAt, subagents.lastBusyAt) > subagents.lastChildEndAt;
          // Idle after it read the report; or no sign of work long after the last end, so it had read it in the turn.
          if ((worked || Date.now() - subagents.lastChildEndAt >= wakeGraceMs) && openChildren(subagents).length === 0) {
            return "settled";
          }
        }
        await Promise.race([nextChange(subagents, Math.min(idlePollMs, left)), endedSignal]);
      }
    } finally {
      turn.waiting = false;
    }
  };

  /** The prompt was answered: what the session's subagents still make of the turn. */
  const afterAnswer = async (agentSessionId: string, turn: Turn, reason: StopReason): Promise<AdapterResult<PromptOutcome>> => {
    const subagents = subagentsOf(agentSessionId);
    /** Stops what's at work within the cancel's budget; past it the agent goes, as for a cancel it never answers. */
    const stopForCancel = async (cancelledAt: number): Promise<AdapterResult<PromptOutcome>> => {
      const stopped = await Promise.race([
        stopSubagents(agentSessionId, cancelledAt + cancelGraceMs - Math.min(REAP_MARGIN_MS, cancelGraceMs / 2)).then(() => "stopped" as const),
        turn.graceExpired.then(() => "expired" as const),
      ]);
      if (stopped === "expired") {
        await killTree();
      }
      return ok({ stopReason: "cancelled" satisfies StopReason });
    };
    if (turn.cancelledAt !== null) {
      // Ours: a subagent running when it came stops with the turn, and so do the turns it'd wake.
      return turn.subagentsAtCancel || openChildren(subagents).length > 0 ? stopForCancel(turn.cancelledAt) : ok({ stopReason: reason });
    }
    if (reason === "cancelled" || openChildren(subagents).length === 0) {
      // The agent's own cancel (a deny), whose re-prompt carries its subagents on; or none runs, and
      // OpenCode follows nothing of the session past the answer.
      return ok({ stopReason: reason });
    }
    const settled = await waitForSubagents(agentSessionId, turn);
    switch (settled) {
      case "settled":
        return ok({ stopReason: reason });
      case "gone":
        return adapterError("unavailable", "running the turn failed: the agent's process ended while its subagents ran");
      case "cancelled":
        return stopForCancel(cancelledAtOf(turn));
      case "timed-out": {
        const startedBy = openChildren(subagents).map((child) => subagents.startedBy.get(child) ?? null);
        await stopSubagents(agentSessionId, Date.now() + cancelGraceMs);
        return ok({ stopReason: reason, subagentsStopped: { waitedMs: subagentWaitMs, startedBy } });
      }
      default:
        return settled satisfies never;
    }
  };

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
      if (!parsed.success) {
        return adapterError("invalid-response", "the agent's new session had no ID");
      }
      sessionInputs.set(parsed.data.sessionId, { cwd: input.cwd, mcpServers: input.mcpServers });
      return ok({ agentSessionId: parsed.data.sessionId, configOptions: parseConfigOptions(created.value) });
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
        if (!loaded.ok) {
          return loaded;
        }
        sessionInputs.set(input.agentSessionId, { cwd: input.cwd, mcpServers: input.mcpServers });
        return ok({ configOptions: parseConfigOptions(loaded.value) });
      } finally {
        replaying.delete(input.agentSessionId);
      }
    },

    prompt: async (agentSessionId, text) => {
      // A session attached again after a cancel takes its next prompt once it's back.
      const pending = resuming.get(agentSessionId);
      if (pending !== undefined) {
        await Promise.race([pending, delay(RESUME_WAIT_MS), endedSignal]);
      }
      let expire: () => void = () => undefined;
      const graceExpired = new Promise<void>((resolve) => {
        expire = resolve;
      });
      const turn: Turn = { startedAt: Date.now(), cancelledAt: null, graceExpired, expire, subagentsAtCancel: false, waiting: false, queued: [] };
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
          const endedAt = Date.now();
          const reaped = (async () => watch.reapBornSince(turn.startedAt, (await io.unitPids?.().catch(() => [])) ?? [], endedAt))().catch(() => 0);
          // Ours: within the cancel's budget (F-023), with a margin for the turn's own end. The
          // agent's own (a deny ends OpenCode's turn `cancelled`): the reap runs to its end first.
          await (turn.cancelledAt === null ? reaped : Promise.race([reaped, delay(turn.cancelledAt + cancelGraceMs - Math.min(REAP_MARGIN_MS, cancelGraceMs / 2) - Date.now())]));
        }
        return tracksSubagents ? await afterAnswer(agentSessionId, turn, reason) : ok({ stopReason: reason });
      } finally {
        turns.delete(agentSessionId);
        if (turns.size === 0) {
          stopSnapshots();
        }
      }
    },

    cancel: async (agentSessionId) => {
      const turn = turns.get(agentSessionId);
      if (turn?.cancelledAt === null) {
        turn.cancelledAt = Date.now();
        setTimeout(turn.expire, cancelGraceMs).unref();
      }
      // OpenCode's cancel reaches the agent's own turn alone: each running subagent is closed, which interrupts it.
      const open = tracksSubagents ? openChildren(subagentsOf(agentSessionId)) : [];
      if (turn !== undefined && open.length > 0) {
        turn.subagentsAtCancel = true;
      }
      if (tracksSubagents) {
        wake(subagentsOf(agentSessionId));
      }
      try {
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: agentSessionId });
      } catch {
        // The connection is gone: the turn ends through its own failure.
      }
      await within(Promise.all(open.map(closeSession)), Date.now() + cancelGraceMs);
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
      if (outcome.success && outcome.data.outcome === "injected") {
        return ok(undefined);
      }
      // The turn waits for its subagents while the agent idles: the message is its next prompt, in this turn.
      const turn = turns.get(agentSessionId);
      if (turn?.waiting === true && turn.cancelledAt === null) {
        turn.queued.push(text);
        wake(subagentsOf(agentSessionId));
        return ok(undefined);
      }
      return adapterError("conflict", "the agent had no running turn to steer");
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
    connect: (io, handlers, connectOptions = {}) => connectAgent(io, handlers, options, connectOptions),
    mapUpdate: (update: AcpUpdate, context) => mapperFor(String(context.sessionId)).map(update, context),
    mapSubagentStatus: (notice, context) => mapperFor(String(context.sessionId)).subagentStatus(notice, context),
    finishTurn: (context) => mapperFor(String(context.sessionId)).finishTurn(context),
    closeSession: (sessionId) => {
      mappers.delete(String(sessionId));
    },
  };
};
