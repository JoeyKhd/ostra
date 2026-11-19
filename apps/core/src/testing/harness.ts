import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { memoryJobQueue } from "@ostra/api/testing";
import type { Db } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import { registerResponseSchema, replicaIdSchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { RegisterResponse, RunnerId, TokenResponse } from "@ostra/protocol";

import { postgresDeviceSessions } from "../gateway/device-sessions.ts";
import { createGateway } from "../gateway/gateway.ts";
import type { Gateway, GatewayOptions } from "../gateway/gateway.ts";
import { createCoreServer } from "../server.ts";
import type { RouteHandler } from "../server.ts";
import { connectPeer, makeRunnerKey, signAssertion } from "./fake-peer.ts";
import type { ConnectOptions, FakePeer, RunnerKey } from "./fake-peer.ts";

// Core's gateway on a free loopback port, over a test database, and the steps a runner takes.

export type GatewayHarness = {
  readonly url: string;
  readonly gateway: Gateway;
  readonly stop: () => Promise<void>;
};

export const startGateway = async (
  db: Db,
  databaseUrl: string,
  options: Partial<GatewayOptions> = {},
  extraRoutes: (gateway: Gateway) => readonly RouteHandler[] = () => [],
): Promise<GatewayHarness> => {
  const gateway = createGateway({
    db,
    databaseUrl,
    replicaId: replicaIdSchema.parse(`test:${randomBytes(4).toString("hex")}`),
    serverVersion: "0.0.0",
    panelUrl: "http://localhost:3000",
    signingKey: randomBytes(32),
    deviceSessions: postgresDeviceSessions(db),
    ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, jobs: memoryJobQueue() },
    logger: silentLogger,
    ...options,
  });
  const server = createCoreServer({ routes: [gateway.handleRequest, ...extraRoutes(gateway)], upgrade: gateway.handleUpgrade, logger: silentLogger });
  await gateway.start();
  const port = await server.listen(0, "127.0.0.1");
  return {
    url: `http://127.0.0.1:${String(port)}`,
    gateway,
    stop: async () => {
      await gateway.stop();
      await server.close();
    },
  };
};

/** A device session of `member` in its organization, as better-auth's device flow leaves one. */
export const seedDeviceSession = async (db: Db, member: SeededMember): Promise<string> => {
  const token = randomBytes(24).toString("base64url");
  await db.authSession.create({
    data: {
      id: randomBytes(12).toString("hex"),
      token,
      userId: member.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      activeOrganizationId: member.organizationId,
    },
  });
  return token;
};

export const postJson = async (url: string, body: unknown, bearer?: string): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
};

export const registerBody = (key: RunnerKey, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  publicKey: key.publicKey,
  name: "laptop",
  executor: "host",
  capacity: 1,
  labels: [],
  os: { platform: "win32", arch: "x64", release: "10.0" },
  version: "0.0.0",
  ...overrides,
});

export type RegisteredRunner = {
  readonly key: RunnerKey;
  readonly registered: RegisterResponse;
  readonly runnerId: RunnerId;
};

export const registerPersonal = async (harness: GatewayHarness, db: Db, member: SeededMember): Promise<RegisteredRunner> => {
  const key = await makeRunnerKey();
  const session = await seedDeviceSession(db, member);
  const response = await postJson(`${harness.url}${runnerPaths.register}`, registerBody(key), session);
  if (response.status !== 201) {
    throw new Error(`register answered ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  const registered = registerResponseSchema.parse(response.body);
  return { key, registered, runnerId: registered.runnerId };
};

export const accessToken = async (harness: GatewayHarness, runner: RegisteredRunner): Promise<TokenResponse> => {
  const response = await postJson(`${harness.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId));
  if (response.status !== 200) {
    throw new Error(`token answered ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return tokenResponseSchema.parse(response.body);
};

export const connect = async (harness: GatewayHarness, runner: RegisteredRunner, options: ConnectOptions = {}): Promise<FakePeer> => {
  const token = await accessToken(harness, runner);
  return connectPeer(harness.url, token.accessToken, runner.runnerId, options);
};
