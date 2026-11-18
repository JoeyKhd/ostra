import { createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  minorWindow,
  parseJson,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  registerRequestSchema,
  runnerIdSchema,
  runnerPaths,
  tokenAssertionCanonicalString,
  tokenAssertionSchema,
} from "@ostra/protocol";
import type { InfoResponse, RegisterRequest, RunnerId } from "@ostra/protocol";

// A fake ostra server for the runner's tests (spec section 8: the runner's tests run against a
// fake built from the protocol's schemas). It plays core's `/runner/v1/*` HTTP endpoints and the
// panel's better-auth device endpoints, on one loopback port. Every request body is parsed with
// the protocol's schema, so the runner can't drift from the contract without a test failing.

export type FakeRunner = {
  readonly runnerId: RunnerId;
  readonly request: RegisterRequest;
  /** How it proved itself: the device session it sent, or the join token. */
  readonly proof: "device-session" | "join-token";
  revoked: boolean;
};

export type FakeServerOptions = {
  /** Overrides of `/runner/v1/info`. */
  readonly info?: Partial<InfoResponse>;
  /** Device-code polls answered `authorization_pending` before the approval. */
  readonly pendingPolls?: number;
  /** The device flow's outcome once pending is over. */
  readonly deviceOutcome?: "approve" | "deny";
  /** The join tokens the server accepts. */
  readonly joinTokens?: readonly string[];
};

export type FakeServer = {
  readonly url: string;
  readonly runners: Map<RunnerId, FakeRunner>;
  /** Every device session the panel handed out, and whether it was revoked after register. */
  readonly sessions: Map<string, { revoked: boolean }>;
  /** How many access tokens were issued, by runner. */
  readonly tokensIssued: Map<RunnerId, number>;
  /** The access tokens issued, so a gateway can check them. */
  readonly accessTokens: Map<string, RunnerId>;
  readonly requests: string[];
  readonly setInfo: (info: Partial<InfoResponse>) => void;
  readonly close: () => Promise<void>;
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const parsed = parseJson(Buffer.concat(chunks).toString("utf8"));
  return parsed.ok ? parsed.value : undefined;
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const ostraError = (response: ServerResponse, status: number, code: string, message: string): void => {
  send(response, status, { error: { code, message } });
};

const bearerOf = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
};

export const startFakeServer = async (options: FakeServerOptions = {}): Promise<FakeServer> => {
  const runners = new Map<RunnerId, FakeRunner>();
  const sessions = new Map<string, { revoked: boolean }>();
  const tokensIssued = new Map<RunnerId, number>();
  const accessTokens = new Map<string, RunnerId>();
  const requests: string[] = [];
  const devices = new Map<string, { polls: number }>();
  const seenNonces = new Set<string>();
  let counter = 0;
  let url = "";
  let infoOverride: Partial<InfoResponse> = options.info ?? {};

  const info = (): InfoResponse => ({
    protocolMajor: PROTOCOL_MAJOR,
    serverMinor: PROTOCOL_MINOR,
    supported: minorWindow(PROTOCOL_MINOR),
    serverVersion: "0.0.0",
    panelUrl: url,
    deviceClientId: "ostra-runner",
    ...infoOverride,
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = request.url ?? "/";
    requests.push(`${request.method ?? "GET"} ${path}`);
    if (request.headers["user-agent"]?.startsWith("ostra-runner/") !== true) {
      ostraError(response, 400, "bad-request", "no ostra-runner User-Agent");
      return;
    }
    if (request.method === "GET" && path === runnerPaths.info) {
      send(response, 200, info());
      return;
    }
    if (request.method === "POST" && path === "/api/auth/device/code") {
      const body = await readBody(request);
      if (typeof body !== "object" || body === null || Reflect.get(body, "client_id") !== info().deviceClientId) {
        send(response, 400, { error: "invalid_client" });
        return;
      }
      const deviceCode = randomBytes(24).toString("base64url");
      devices.set(deviceCode, { polls: 0 });
      send(response, 200, {
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: "/device",
        verification_uri_complete: "/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 1,
      });
      return;
    }
    if (request.method === "POST" && path === "/api/auth/device/token") {
      const body = await readBody(request);
      const code: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "device_code") : undefined;
      const device = typeof code === "string" ? devices.get(code) : undefined;
      if (typeof code !== "string" || device === undefined) {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      device.polls += 1;
      if (device.polls <= (options.pendingPolls ?? 1)) {
        send(response, 400, { error: device.polls === 1 ? "authorization_pending" : "slow_down" });
        return;
      }
      devices.delete(code);
      if (options.deviceOutcome === "deny") {
        send(response, 400, { error: "access_denied" });
        return;
      }
      const session = `session-${randomBytes(16).toString("hex")}`;
      sessions.set(session, { revoked: false });
      send(response, 200, { access_token: session, token_type: "Bearer", expires_in: 604_800 });
      return;
    }
    if (request.method === "POST" && path === runnerPaths.register) {
      const parsed = registerRequestSchema.safeParse(await readBody(request));
      if (!parsed.success) {
        ostraError(response, 400, "bad-request", "the register body doesn't match the protocol");
        return;
      }
      const bearer = bearerOf(request);
      let proof: FakeRunner["proof"];
      if (parsed.data.joinToken !== undefined) {
        if (!(options.joinTokens ?? []).includes(parsed.data.joinToken)) {
          ostraError(response, 401, "unauthorized", "unknown join token");
          return;
        }
        proof = "join-token";
      } else {
        const session = bearer === undefined ? undefined : sessions.get(bearer);
        if (session === undefined || session.revoked) {
          ostraError(response, 401, "unauthorized", "no device session");
          return;
        }
        session.revoked = true;
        proof = "device-session";
      }
      counter += 1;
      const runnerId = runnerIdSchema.parse(`runner-${String(counter)}`);
      runners.set(runnerId, { runnerId, request: parsed.data, proof, revoked: false });
      send(response, 200, {
        runnerId,
        kind: proof === "join-token" ? "pool" : "personal",
        poolId: proof === "join-token" ? "pool-1" : null,
      });
      return;
    }
    if (request.method === "POST" && path === runnerPaths.token) {
      const parsed = tokenAssertionSchema.safeParse(await readBody(request));
      if (!parsed.success) {
        ostraError(response, 400, "bad-request", "the assertion doesn't match the protocol");
        return;
      }
      const runner = runners.get(parsed.data.runnerId);
      if (runner === undefined || runner.revoked) {
        ostraError(response, 403, "unauthorized", "this runner is revoked");
        return;
      }
      const publicKey = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: runner.request.publicKey },
        format: "jwk",
      });
      const signed = verify(
        null,
        Buffer.from(tokenAssertionCanonicalString(parsed.data), "utf8"),
        publicKey,
        Buffer.from(parsed.data.signature, "base64url"),
      );
      if (!signed || seenNonces.has(parsed.data.nonce)) {
        ostraError(response, 401, "unauthorized", "bad assertion");
        return;
      }
      seenNonces.add(parsed.data.nonce);
      tokensIssued.set(runner.runnerId, (tokensIssued.get(runner.runnerId) ?? 0) + 1);
      const accessToken = `ostra-runner-${randomBytes(24).toString("base64url")}`;
      accessTokens.set(accessToken, runner.runnerId);
      send(response, 200, { accessToken, expiresAt: Date.now() + 600_000 });
      return;
    }
    ostraError(response, 404, "not-found", "no such endpoint");
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      ostraError(response, 500, "internal", "the fake server failed");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake server has no port");
  }
  url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    runners,
    sessions,
    tokensIssued,
    accessTokens,
    requests,
    setInfo: (next) => {
      infoOverride = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
