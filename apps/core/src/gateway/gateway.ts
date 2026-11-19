import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { Ports } from "@ostra/domain";
import { PROTOCOL_MINOR } from "@ostra/protocol";
import type { ReplicaId } from "@ostra/protocol";

import { createAccessTokens } from "./access-token.ts";
import { createNonceCache } from "./assertion.ts";
import { createConnections } from "./connections.ts";
import type { Connections } from "./connections.ts";
import { ackingHooks, defaultTimers } from "./context.ts";
import type { GatewayContext, GatewayHooks, GatewayTimers } from "./context.ts";
import type { DeviceSessions } from "./device-sessions.ts";
import { createTaskTokens } from "./task-token.ts";
import { handleRunnerEndpoint } from "./endpoints.ts";

// The runner gateway (ticket 24, ADR 0034): `/runner/v1/*` on core. The HTTP endpoints and the
// WebSocket share one context; the hooks are where ingest (ticket 25) and the reactions to command
// results (tickets 26, 27) plug in.

/** The device flow's client ID, as the panel's better-auth knows it (packages/api). */
export const RUNNER_CLIENT_ID = "ostra-runner";

export type GatewayOptions = {
  readonly db: Db;
  /** For the LISTEN connection. Holds credentials: never logged. */
  readonly databaseUrl: string;
  readonly replicaId: ReplicaId;
  readonly serverVersion: string;
  readonly panelUrl: string;
  /** The key that signs access tokens: core's own, from OSTRA_DATA_DIR. */
  readonly signingKey: Buffer;
  readonly deviceSessions: DeviceSessions;
  readonly ports: Pick<Ports, "notices" | "audit" | "clock" | "jobs">;
  readonly hooks?: Partial<GatewayHooks>;
  readonly timers?: Partial<GatewayTimers>;
  readonly serverMinor?: number;
  /** `false`: commands go out on the sweep only (tests). */
  readonly listen?: boolean;
  readonly logger?: Logger;
};

export type Gateway = {
  readonly context: GatewayContext;
  readonly connections: Connections;
  /** Handles a runner endpoint; `false` when the path isn't one. */
  readonly handleRequest: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export const createGateway = (options: GatewayOptions): Gateway => {
  const context: GatewayContext = {
    db: options.db,
    replicaId: options.replicaId,
    serverMinor: options.serverMinor ?? PROTOCOL_MINOR,
    serverVersion: options.serverVersion,
    panelUrl: options.panelUrl,
    deviceClientId: RUNNER_CLIENT_ID,
    tokens: createAccessTokens(options.signingKey),
    taskTokens: createTaskTokens(options.signingKey),
    nonces: createNonceCache(),
    deviceSessions: options.deviceSessions,
    ports: options.ports,
    hooks: { ...ackingHooks, ...options.hooks },
    timers: { ...defaultTimers, ...options.timers },
    logger: (options.logger ?? silentLogger).child({ component: "gateway", replicaId: options.replicaId }),
  };
  const connections = createConnections(context, {
    databaseUrl: options.databaseUrl,
    ...(options.listen === undefined ? {} : { listen: options.listen }),
  });
  return {
    context,
    connections,
    handleRequest: async (request, response, url) =>
      (await connections.handleHttp(request, response, url)) || handleRunnerEndpoint(context, request, response, url),
    handleUpgrade: connections.handleUpgrade,
    start: connections.start,
    stop: connections.stop,
  };
};
