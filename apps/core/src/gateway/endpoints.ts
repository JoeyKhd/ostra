import type { IncomingMessage, ServerResponse } from "node:http";

import { registerPersonalRunner } from "@ostra/domain";
import {
  encodeInfoForMinor,
  encodeRunnerHttpErrorForMinor,
  infoResponseSchema,
  minorFromHeader,
  minorWindow,
  organizationIdSchema,
  poolIdSchema,
  PROTOCOL_MAJOR,
  registerRequestSchema,
  runnerHeaders,
  runnerIdSchema,
  runnerPaths,
  tokenAssertionSchema,
} from "@ostra/protocol";
import type { RegisterRequest, RegisterResponse, RunnerHttpError, TokenAssertion, TokenRefusalReason } from "@ostra/protocol";

import { readJsonBody, sendError, sendJson } from "../http.ts";
import { bearerToken } from "./access-token.ts";
import { assertionFresh, verifyAssertionSignature } from "./assertion.ts";
import { hashJoinToken } from "./bootstrap-join-token.ts";
import type { GatewayContext } from "./context.ts";

// The runner's HTTP endpoints beside the WebSocket (ADR 0034): `info`, `register` and `token`.
// Ported from spikes/runner-transport/src/server/replica.ts (`onHttp`), with ADR 0034's Ed25519
// identity in place of the spike's shared secret.

/**
 * `GET /runner/v1/info`. From minor 4 the runner sends its minor in `x-ostra-minor`, and gets the
 * window again as `minorWindow` and where the pin installs from as `npm` (`null` here: the
 * runner's own `OSTRA_RUNNER_NPM_REGISTRY` or npm's public registry applies). A request without
 * the header gets minor 3's strict shape.
 */
const info = (context: GatewayContext, http: IncomingMessage, response: ServerResponse): void => {
  const header = http.headers[runnerHeaders.minor];
  const minor = minorFromHeader(typeof header === "string" ? header : undefined);
  const window = minorWindow(context.serverMinor);
  const body = infoResponseSchema.parse({
    protocolMajor: PROTOCOL_MAJOR,
    serverMinor: context.serverMinor,
    supported: window,
    serverVersion: context.serverVersion,
    panelUrl: context.panelUrl,
    deviceClientId: context.deviceClientId,
    minorWindow: window,
    npm: null,
  });
  sendJson(response, 200, encodeInfoForMinor(body, minor));
};

/**
 * A pool runner's join, with any join token of its pool that isn't revoked or expired: the bootstrap
 * one core writes at first start, and the ones an admin makes in the panel (F-091, Q130).
 */
const registerPoolRunner = async (
  context: GatewayContext,
  request: RegisterRequest,
  joinToken: string,
): Promise<{ readonly status: number; readonly body: RegisterResponse } | { readonly status: number; readonly code: "unauthorized" | "conflict" | "bad-request"; readonly message: string }> => {
  const now = new Date(context.ports.clock.now());
  return context.db.$transaction(async (tx) => {
    const token = await tx.joinToken.findUnique({ where: { tokenHash: hashJoinToken(joinToken) } });
    if (token?.revokedAt !== null || (token.expiresAt !== null && token.expiresAt <= now)) {
      return { status: 401, code: "unauthorized", message: "the join token is not valid" };
    }
    if (request.executor === "host") {
      return { status: 400, code: "bad-request", message: "a pool runner uses the docker or kubernetes executor" };
    }
    // Joins into one pool take its row in turn, so of two that race with one name, the second
    // reads the first's runner below and is refused.
    await tx.$queryRaw`SELECT 1 FROM "runner_pool" WHERE "id" = ${token.poolId} AND "organizationId" = ${token.organizationId} FOR NO KEY UPDATE`;
    const sameName = await tx.runner.findFirst({
      where: { organizationId: token.organizationId, poolId: token.poolId, name: request.name, revokedAt: null },
      select: { id: true },
    });
    if (sameName !== null) {
      return { status: 409, code: "conflict", message: "a runner of this name already joined this pool" };
    }
    if ((await tx.runner.findUnique({ where: { publicKey: request.publicKey }, select: { id: true } })) !== null) {
      return { status: 409, code: "conflict", message: "a runner with this key exists; make a new key pair" };
    }
    const runner = await tx.runner.create({
      data: {
        organizationId: token.organizationId,
        kind: "pool",
        poolId: token.poolId,
        name: request.name,
        publicKey: request.publicKey,
        executor: request.executor,
        capacity: request.capacity,
        labels: [...request.labels],
        version: request.version,
        os: { platform: request.os.platform, arch: request.os.arch, release: request.os.release },
        state: "joining",
      },
      select: { id: true },
    });
    const runnerId = runnerIdSchema.parse(runner.id);
    await tx.joinToken.update({ where: { id: token.id }, data: { lastUsedAt: now } });
    const organizationId = organizationIdSchema.parse(token.organizationId);
    await context.ports.audit.recordInTx(tx, {
      organizationId: organizationId,
      projectId: null,
      actor: { kind: "runner", id: runnerId },
      action: "runner.registered",
      entity: "runner",
      entityId: runnerId,
      data: { kind: "pool", executor: request.executor, capacity: request.capacity, joinTokenId: token.id, bootstrap: token.bootstrap },
    });
    await context.ports.notices.emitInTx(tx, {
      organizationId: organizationId,
      projectId: null,
      entity: "runner",
      entityId: runnerId,
    });
    return { status: 201, body: { runnerId, kind: "pool", poolId: poolIdSchema.parse(token.poolId) } };
  });
};

const register = async (context: GatewayContext, http: IncomingMessage, response: ServerResponse): Promise<void> => {
  const body = await readJsonBody(http);
  if (!body.ok) {
    sendError(response, 400, "bad-request", "the body is not JSON of at most 64 KiB");
    return;
  }
  const parsed = registerRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(response, 400, "bad-request", "the body is not a register request");
    return;
  }
  const request = parsed.data;
  const session = bearerToken(http.headers.authorization);
  if (request.joinToken !== undefined) {
    if (session !== null) {
      sendError(response, 400, "bad-request", "send a device session or a join token, not both");
      return;
    }
    const result = await registerPoolRunner(context, request, request.joinToken);
    if ("body" in result) {
      context.logger.info("runner.registered", { runnerId: result.body.runnerId, kind: "pool" });
      sendJson(response, result.status, result.body);
    } else {
      sendError(response, result.status, result.code, result.message);
    }
    return;
  }
  if (session === null) {
    sendError(response, 401, "unauthorized", "a personal runner sends the member's device session as a bearer token");
    return;
  }
  const owner = await context.deviceSessions.verify(session);
  if (owner === null) {
    sendError(response, 401, "unauthorized", "the device session is not valid; sign in again");
    return;
  }
  const result = await context.db.$transaction((tx) =>
    registerPersonalRunner(
      {
        tx,
        owner,
        notices: context.ports.notices,
        audit: context.ports.audit,
        clock: context.ports.clock,
        revokeSession: (sessionId) => context.deviceSessions.revokeInTx(tx, sessionId),
      },
      request,
    ),
  );
  if (!result.ok) {
    const status = result.error === "public-key-taken" ? 409 : result.error === "no-session" ? 401 : 400;
    sendError(response, status, status === 409 ? "conflict" : status === 401 ? "unauthorized" : "bad-request", result.message);
    return;
  }
  context.logger.info("runner.registered", { runnerId: result.runnerId, kind: "personal", organizationId: owner.organizationId });
  sendJson(response, 201, { runnerId: result.runnerId, kind: result.kind, poolId: result.poolId });
};

/** The token endpoint's four refusals (ADR 0034): only `revoked` and `unknown-key` are for good. */
const tokenRefusals = {
  "clock-skew": { status: 401, message: "the assertion's issuedAt is too far from the server's clock; check this machine's time" },
  // One answer for an unknown runner and a bad signature: nothing about which runners exist leaks.
  "unknown-key": { status: 401, message: "the assertion is not signed by a known runner" },
  revoked: { status: 403, message: "this runner is revoked; register it again" },
  replayed: { status: 401, message: "the assertion was already used" },
} as const satisfies Record<TokenRefusalReason, { readonly status: 401 | 403; readonly message: string }>;

/**
 * Refuses a token, saying why to a runner of minor 2 or later (`x-ostra-minor`), and logs it with the
 * runner ID and the reason: never the assertion, its nonce or signature, or a token.
 */
const refuseToken = (
  context: GatewayContext,
  http: IncomingMessage,
  response: ServerResponse,
  assertion: TokenAssertion,
  reason: TokenRefusalReason,
  now: number,
): void => {
  const { status, message } = tokenRefusals[reason];
  const header = http.headers[runnerHeaders.minor];
  // A runner before minor 2 sends no minor here, and gets minor 1's body: its schema is strict.
  const minor = Math.min(context.serverMinor, minorFromHeader(typeof header === "string" ? header : undefined));
  const skewMs = reason === "clock-skew" ? assertion.issuedAt - now : undefined;
  context.logger.warn("runner.token-refused", { runnerId: assertion.runnerId, reason, status, minor, skewMs });
  const body: RunnerHttpError = {
    error: { code: "unauthorized", message, reason, ...(reason === "clock-skew" ? { serverTime: now } : {}) },
  };
  sendJson(response, status, encodeRunnerHttpErrorForMinor(body, minor));
};

const token = async (context: GatewayContext, http: IncomingMessage, response: ServerResponse): Promise<void> => {
  const body = await readJsonBody(http, 4 * 1024);
  const parsed = body.ok ? tokenAssertionSchema.safeParse(body.value) : undefined;
  if (parsed?.success !== true) {
    context.logger.warn("runner.token-refused", { reason: "bad-request", status: 400 });
    sendError(response, 400, "bad-request", "the body is not a signed assertion");
    return;
  }
  const assertion = parsed.data;
  const now = context.ports.clock.now();
  if (!assertionFresh(assertion.issuedAt, now)) {
    refuseToken(context, http, response, assertion, "clock-skew", now);
    return;
  }
  const runner = await context.db.runner.findUnique({
    where: { id: assertion.runnerId },
    select: { id: true, organizationId: true, publicKey: true, state: true, revokedAt: true },
  });
  if (runner === null || !verifyAssertionSignature(assertion, runner.publicKey)) {
    refuseToken(context, http, response, assertion, "unknown-key", now);
    return;
  }
  if (runner.state === "revoked" || runner.revokedAt !== null) {
    refuseToken(context, http, response, assertion, "revoked", now);
    return;
  }
  if (!context.nonces.firstUse(assertion.runnerId, assertion.nonce, now)) {
    refuseToken(context, http, response, assertion, "replayed", now);
    return;
  }
  const issued = context.tokens.issue(assertion.runnerId, organizationIdSchema.parse(runner.organizationId), now);
  sendJson(response, 200, issued);
};

/** Handles a runner HTTP endpoint; `false` when the path isn't one of them. */
export const handleRunnerEndpoint = async (
  context: GatewayContext,
  http: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> => {
  const route = `${http.method ?? "GET"} ${url.pathname}`;
  switch (route) {
    case `GET ${runnerPaths.info}`:
      info(context, http, response);
      return true;
    case `POST ${runnerPaths.register}`:
      await register(context, http, response);
      return true;
    case `POST ${runnerPaths.token}`:
      await token(context, http, response);
      return true;
    case `GET ${runnerPaths.connect}`:
      // Reached without an upgrade: something on the path stripped it (nginx's defaults do).
      sendError(response, 426, "protocol-violation", "a WebSocket upgrade is required on this path");
      return true;
    default:
      return false;
  }
};
