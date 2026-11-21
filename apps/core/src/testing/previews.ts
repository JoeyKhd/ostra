import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { panelPreviewPaths, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";
import { createPanelStreamReader, decodePreviewMessage, encodePreviewMessage, previewPaths, previewSubprotocols, replicaIdSchema, runnerLimits } from "@ostra/protocol";
import type { PreviewMessage, PreviewViewId } from "@ostra/protocol";
import WebSocket from "ws";

import { agentEffortLevels } from "../agents/effort-levels.ts";
import { agentImportsArchives } from "../agents/session-archives.ts";
import { postgresDeviceSessions } from "../gateway/device-sessions.ts";
import { createGateway } from "../gateway/gateway.ts";
import type { Gateway, GatewayOptions } from "../gateway/gateway.ts";
import { createPreviews } from "../previews/previews.ts";
import type { Previews } from "../previews/previews.ts";
import { handlePanelStartApp } from "../previews/start-app-endpoint.ts";
import { createCoreServer } from "../server.ts";

// The previews' test seams (milestone 8, ticket 19): one core replica in this process (its gateway
// and its previews, on a free loopback port, with the address the other replicas reach it at), a
// fake box that opens a view's preview connection and sends frames, and a panel's stream reader.

export type PreviewReplica = {
  readonly url: string;
  readonly gateway: Gateway;
  readonly previews: Previews;
  readonly stop: () => Promise<void>;
};

export const startPreviewReplica = async (
  db: Db,
  databaseUrl: string,
  options: {
    readonly signingKey: Buffer;
    /** The secrets key's text every replica shares. */
    readonly secret: string;
    readonly jobs: Jobs;
    readonly clock?: Clock;
    readonly logger?: Logger;
    readonly gateway?: Partial<GatewayOptions>;
    readonly warmMinutes?: number;
    /** How long a CLI gets to answer core's close frame before its socket is cut (30 s in production). */
    readonly cliCloseWaitMs?: number;
    /** How often a CLI's tunnel checks its session again (5 minutes in production). */
    readonly cliRecheckMs?: number;
    /** "Start the app"'s personal runner slots: 2 by default, as an install's. */
    readonly personalSlots?: number;
    /** `OSTRA_PREVIEW_DOMAIN`: set, the replica serves the native preview on its hosts (ticket 25). */
    readonly previewDomain?: string;
    /** `OSTRA_PUBLIC_URL`, the panel's address: `http://localhost:3000` by default. */
    readonly publicUrl?: string;
    /** The native preview's heartbeat and check intervals (30 s and 5 minutes in production). */
    readonly nativeHeartbeatMs?: number;
    readonly nativeRecheckMs?: number;
  },
): Promise<PreviewReplica> => {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  let url = "";
  const gateway = createGateway({
    db,
    databaseUrl,
    replicaId: replicaIdSchema.parse(`test:${randomBytes(4).toString("hex")}`),
    serverVersion: "0.0.0",
    panelUrl: "http://localhost:3000",
    signingKey: options.signingKey,
    deviceSessions: postgresDeviceSessions(db),
    ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, jobs: options.jobs },
    logger,
    ...options.gateway,
  });
  const previews = createPreviews({
    db,
    outbox: postgresCommandOutbox,
    notices: postgresChangeNotices,
    clock,
    logger,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    secret: () => Promise.resolve(options.secret),
    replicaUrl: () => url,
    presenceWaitMs: 3_000,
    ...(options.cliCloseWaitMs === undefined ? {} : { cliCloseWaitMs: options.cliCloseWaitMs }),
    checkMs: 100,
    settings: { warmMinutes: options.warmMinutes ?? 60, domain: options.previewDomain ?? null },
    // Core's public address as a browser reaches the preview hosts here: plain http on loopback.
    urls: { publicUrl: options.publicUrl ?? "http://localhost:3000", corePublicUrl: "http://127.0.0.1" },
    ...(options.cliRecheckMs === undefined ? {} : { cliRecheckMs: options.cliRecheckMs }),
    ...(options.nativeHeartbeatMs === undefined ? {} : { nativeHeartbeatMs: options.nativeHeartbeatMs }),
    ...(options.nativeRecheckMs === undefined ? {} : { nativeRecheckMs: options.nativeRecheckMs }),
  });
  // "Start the app" from the panel, with the dispatch settings core's own reads (`core.ts`).
  const startApp = handlePanelStartApp({
    start: {
      db,
      jobs: options.jobs,
      outbox: postgresCommandOutbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock,
      logger,
      dispatch: { reopen: { agentImportsArchives, archiveMaxBytes: runnerLimits.archiveMaxBytes }, effortLevels: agentEffortLevels, personalSlots: options.personalSlots ?? 2 },
    },
    secret: () => Promise.resolve(options.secret),
    logger,
  });
  const server = createCoreServer({
    routes: [previews.handleRequest, startApp, gateway.handleRequest],
    upgrade: (request, socket, head) => {
      if (!previews.handleUpgrade(request, socket, head)) {
        gateway.handleUpgrade(request, socket, head);
      }
    },
    ...(previews.native === null ? {} : { hosts: { takes: previews.native.takes, handle: previews.native.handleRequest, upgrade: previews.native.handleUpgrade } }),
    logger,
  });
  await gateway.start();
  const port = await server.listen(0, "127.0.0.1");
  url = `http://127.0.0.1:${String(port)}`;
  previews.start();
  return {
    url,
    gateway,
    previews,
    stop: async () => {
      await previews.stop();
      await gateway.stop();
      await server.close();
    },
  };
};

/** A JPEG's first bytes and some more: what a frame must start with. */
export const fakeJpeg = (fill: number, size = 64): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

export type FakeBox = {
  /** The messages core sent the box, in order. */
  readonly received: PreviewMessage[];
  /** Resolves with the next message of `type` not yet taken. */
  readonly next: <T extends PreviewMessage["type"]>(type: T, timeoutMs?: number) => Promise<Extract<PreviewMessage, { type: T }>>;
  readonly sendFrame: (seq: number, fill?: number) => void;
  readonly closed: Promise<number>;
  readonly close: () => void;
};

/** A box's preview connection for one view, as the sidecar (or the `host` runner) opens it. Rejects with the refused status. */
export const connectFakeBox = (baseUrl: string, viewId: PreviewViewId, leaseEpoch: number, token: string): Promise<FakeBox> =>
  new Promise((resolve, reject) => {
    const url = `${baseUrl.replace(/^http/, "ws")}${previewPaths.connection}?view=${encodeURIComponent(viewId)}&leaseEpoch=${String(leaseEpoch)}`;
    const ws = new WebSocket(url, [previewSubprotocols.stream], { headers: { authorization: `Bearer ${token}` } });
    const received: PreviewMessage[] = [];
    const taken = new Set<PreviewMessage>();
    const closed = new Promise<number>((resolveClosed) => {
      ws.on("close", (code) => {
        resolveClosed(code);
      });
    });
    ws.on("message", (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data));
      const parsed = decodePreviewMessage(new Uint8Array(bytes));
      if (parsed.ok) {
        received.push(parsed.message);
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      reject(new Error(`upgrade refused: ${String(response.statusCode)}`));
    });
    ws.on("error", (error) => {
      reject(error);
    });
    const next = async <T extends PreviewMessage["type"]>(type: T, timeoutMs = 5_000): Promise<Extract<PreviewMessage, { type: T }>> => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find((message): message is Extract<PreviewMessage, { type: T }> => message.type === type && !taken.has(message));
        if (found !== undefined) {
          taken.add(found);
          return found;
        }
        if (Date.now() > until) {
          throw new Error(`no ${type} message within ${String(timeoutMs)} ms; got ${received.map((message) => message.type).join(", ")}`);
        }
        await new Promise((wait) => setTimeout(wait, 20));
      }
    };
    ws.on("open", () => {
      resolve({
        received,
        next,
        sendFrame: (seq, fill = seq) => {
          ws.send(encodePreviewMessage({ type: "frame", header: { seq, at: Date.now(), width: 1440, height: 900 }, jpeg: fakeJpeg(fill) }));
        },
        closed,
        close: () => {
          ws.close();
        },
      });
    });
  });

export type PanelStream = {
  readonly status: number;
  /** The messages the stream carried so far. */
  readonly messages: PreviewMessage[];
  readonly next: <T extends PreviewMessage["type"]>(type: T, timeoutMs?: number) => Promise<Extract<PreviewMessage, { type: T }>>;
  readonly abort: () => void;
};

/** The panel's stream of a view, read as the pane reads it. */
export const openPanelStream = async (baseUrl: string, viewId: PreviewViewId, headers: Readonly<Record<string, string>>): Promise<PanelStream> => {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${panelPreviewPaths.stream(viewId)}`, { headers, signal: controller.signal });
  const messages: PreviewMessage[] = [];
  const taken = new Set<PreviewMessage>();
  if (response.ok && response.body !== null) {
    const reader = response.body.getReader();
    const records = createPanelStreamReader();
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            return;
          }
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) {
            continue;
          }
          for (const record of records.push(value)) {
            if (record.ok) {
              messages.push(record.message);
            }
          }
        }
      } catch {
        // Aborted.
      }
    })();
  } else {
    await response.body?.cancel();
  }
  const next = async <T extends PreviewMessage["type"]>(type: T, timeoutMs = 5_000): Promise<Extract<PreviewMessage, { type: T }>> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find((message): message is Extract<PreviewMessage, { type: T }> => message.type === type && !taken.has(message));
      if (found !== undefined) {
        taken.add(found);
        return found;
      }
      if (Date.now() > until) {
        throw new Error(`no ${type} record within ${String(timeoutMs)} ms; got ${messages.map((message) => message.type).join(", ")}`);
      }
      await new Promise((wait) => setTimeout(wait, 20));
    }
  };
  return {
    status: response.status,
    messages,
    next,
    abort: () => {
      controller.abort();
    },
  };
};
