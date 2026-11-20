import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  blobChunkQuerySchema,
  blobUploadFinishRequestSchema,
  blobUploadStartRequestSchema,
  draftIdSchema,
  draftRequestSchema,
  draftResponseSchema,
  environmentProposalIdSchema,
  environmentProposalRequestSchema,
  environmentProposalResponseSchema,
  encodeRunnerHttpErrorForMinor,
  minorFromHeader,
  memoryNoteResponseSchema,
  memoryProposalRequestSchema,
  memoryProposalResponseSchema,
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  minorWindow,
  parseJson,
  proposalIdSchema,
  PROTOCOL_MAJOR,
  pullCredentialRequestSchema,
  pullCredentialResponseSchema,
  pushCredentialRequestSchema,
  pushCredentialResponseSchema,
  PROTOCOL_MINOR,
  registerRequestSchema,
  reviewRequestSchema,
  reviewResponseSchema,
  reviewRunIdSchema,
  runnerHeaders,
  runnerIdSchema,
  runnerLimits,
  runnerPaths,
  taskCredentialsRequestSchema,
  tokenAssertionCanonicalString,
  tokenAssertionSchema,
} from "@ostra/protocol";
import type {
  DraftRefusal,
  DraftRequestBody,
  DraftResponse,
  EnvironmentProposal,
  EnvironmentProposalRefusal,
  EnvironmentProposalResponse,
  InfoResponse,
  ReviewRefusal,
  ReviewRequestBody,
  ReviewResponse,
  MemoryNote,
  MemoryProposalInput,
  MemoryProposalRefusal,
  MemoryProposalResponse,
  RegisterRequest,
  RegistryCredential,
  RunnerHttpError,
  RunnerId,
  TaskCredentials,
  TaskSpec,
  TokenRefusalReason,
} from "@ostra/protocol";

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

/** A blob the fake server holds for a task: an upload it sealed, or a ticket file a test put there. */
export type FakeBlob = {
  readonly taskId: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly contentType: string;
  readonly purpose: string;
};

/** Faults the bulk path plays, for the runner's resume and failure cases. */
export type BulkFaults = {
  /** The next this many chunk `PUT`s keep half their bytes, then the connection drops. */
  dropChunks: number;
  /** Every upload start answers 503: the upload fails, whatever the runner tries. */
  refuseUploads: boolean;
  /** Downloads of these blobs answer 503. */
  readonly failDownloads: Set<string>;
  /** Downloads of these blobs answer other bytes than the blob's, under its digest: a corrupt copy. */
  readonly corruptDownloads: Set<string>;
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
  /** The server's clock, which a token's `issuedAt` is checked against (ADR 0034's skew window). */
  readonly now?: () => number;
};

/**
 * Milestone 4 (ticket 20): core's memory endpoints for the sidecar, by the protocol's schemas. A
 * search matches every word of the query in a note's title or body; a proposal is kept apart from
 * the notes, so it reaches no agent until approved (here: never).
 */
export type FakeMemory = {
  /** The approved notes a task can reach. */
  readonly notes: MemoryNote[];
  /** The proposals core recorded, with the task and the token each came with. */
  readonly proposals: { readonly taskId: string; readonly bearer: string; readonly input: MemoryProposalInput }[];
  /** Every memory call, in order: its endpoint and the token it carried. */
  readonly calls: { readonly endpoint: "search" | "read" | "propose"; readonly taskId: string; readonly bearer: string }[];
  /** The next proposals' refusal, in order, before any is recorded. */
  readonly refusals: MemoryProposalRefusal[];
  /** While true, every memory call fails as a server error: memory is down. */
  down: boolean;
};

/**
 * Milestone 6 (tickets 22 and 23): core's draft, review and environment proposal endpoints for the
 * sidecar, by the protocol's schemas (minor 5): each saved with the task and the token it came with,
 * or refused as the switch says, as a `200` with its `code`, the way core answers.
 */
export type FakeTeam = {
  readonly drafts: { readonly taskId: string; readonly bearer: string; readonly body: DraftRequestBody }[];
  readonly reviews: { readonly taskId: string; readonly bearer: string; readonly body: ReviewRequestBody }[];
  readonly proposals: { readonly taskId: string; readonly bearer: string; readonly body: EnvironmentProposal }[];
  /** Each endpoint's answer: `null` saves, a refusal refuses. */
  readonly refusals: { draft: DraftRefusal | null; review: ReviewRefusal | null; environment: EnvironmentProposalRefusal | null };
  /** Every call, in order: its endpoint and the token it carried. */
  readonly calls: { readonly endpoint: "draft" | "review" | "environment"; readonly taskId: string; readonly bearer: string }[];
  /** While true, every call fails as a server error: core is down. */
  down: boolean;
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
  /**
   * Refusals the token endpoint answers first, one per request and in order, before it checks
   * anything: as core words them (minor 2, with a `reason`), or as a server before minor 2 did.
   */
  readonly tokenRefusals: { readonly status: number; readonly body: RunnerHttpError }[];
  /** Every token request's nonce and `x-ostra-minor` header, in order. */
  readonly tokenRequests: { readonly nonce: string; readonly issuedAt: number; readonly minor: string | undefined }[];
  readonly requests: string[];
  /** Tasks the server can hand out: their spec, and the credentials issued after the lease check. */
  readonly tasks: Map<string, { readonly spec: TaskSpec; readonly credentials: TaskCredentials }>;
  /** How many times each task's credentials were issued. */
  readonly credentialsIssued: Map<string, number>;
  /** The bulk path's sealed blobs, by blob ID. */
  readonly blobs: Map<string, FakeBlob>;
  /** Milestone 4: the memory endpoints' notes, proposals and calls. */
  readonly memory: FakeMemory;
  /** Milestone 6: the draft, review and proposal endpoints' records and switches. */
  readonly team: FakeTeam;
  readonly bulkFaults: BulkFaults;
  /** Every bulk-path call, by kind: `start`, `chunk`, `finish`, `download`. */
  readonly bulkCalls: string[];
  /** A blob of the task, as core stores a ticket image (ticket 12). Answers its ID: `blobId`, or a new one. */
  readonly putBlob: (taskId: string, bytes: Buffer, contentType: string, blobId?: string) => string;
  /** The HTTP server, so the fake gateway can take its WebSocket upgrades. */
  readonly httpServer: Server;
  readonly setInfo: (info: Partial<InfoResponse>) => void;
  /** Milestone 5 (ticket 20): tasks whose spec request waits while they're here, so their run stays at its start. */
  readonly holdSpecs: Set<string>;
  /**
   * Milestone 5 (ticket 21, F-120): the registry credentials core would issue, as minor 4 says them:
   * a pull credential per task (`null`: core answers `no-image`, as with `node` auth), a push
   * credential per snapshot (absent: `not-the-builder`), and every request, in order.
   */
  readonly registry: {
    readonly pulls: Map<string, { readonly leaseEpoch: number; readonly credential: RegistryCredential | null }>;
    readonly pushes: Map<string, RegistryCredential>;
    readonly requests: { readonly kind: "pull" | "push"; readonly id: string; readonly bearer: string | undefined }[];
  };
  readonly close: () => Promise<void>;
};

const readBytes = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

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
  const tokenRefusals: FakeServer["tokenRefusals"] = [];
  const tokenRequests: FakeServer["tokenRequests"] = [];
  const requests: string[] = [];
  const tasks = new Map<string, { readonly spec: TaskSpec; readonly credentials: TaskCredentials }>();
  const credentialsIssued = new Map<string, number>();
  const holdSpecs = new Set<string>();
  const registry: FakeServer["registry"] = { pulls: new Map(), pushes: new Map(), requests: [] };
  const devices = new Map<string, { polls: number }>();
  const blobs = new Map<string, FakeBlob>();
  type Upload = { readonly taskId: string; readonly sha256: string; readonly size: number; readonly contentType: string; readonly purpose: string; held: Buffer };
  const uploads = new Map<string, Upload>();
  const bulkFaults: BulkFaults = { dropChunks: 0, refuseUploads: false, failDownloads: new Set(), corruptDownloads: new Set() };
  const bulkCalls: string[] = [];
  const memory: FakeMemory = { notes: [], proposals: [], calls: [], refusals: [], down: false };
  const team: FakeTeam = { drafts: [], reviews: [], proposals: [], refusals: { draft: null, review: null, environment: null }, calls: [], down: false };
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

  // Milestone 4 (ticket 20): the memory endpoints, as `packages/protocol`'s minor 3 says them.
  const handleMemory = async (request: IncomingMessage, response: ServerResponse, taskId: string, rest: string): Promise<void> => {
    const bearer = bearerOf(request);
    if (bearer === undefined || !accessTokens.has(bearer)) {
      ostraError(response, 401, "unauthorized", "a valid access token is required");
      return;
    }
    if (!tasks.has(taskId)) {
      ostraError(response, 404, "not-found", "no such task");
      return;
    }
    const endpoint = rest === "search" ? "search" : rest === "proposals" ? "propose" : "read";
    memory.calls.push({ endpoint, taskId, bearer });
    if (memory.down) {
      ostraError(response, 503, "unavailable", "memory is down");
      return;
    }
    if (endpoint === "search" && request.method === "POST") {
      const parsed = memorySearchRequestSchema.safeParse(await readBody(request));
      if (!parsed.success) {
        ostraError(response, 400, "invalid", "a search is a query and a limit");
        return;
      }
      const words = parsed.data.query.toLowerCase().split(/\s+/).filter((word) => word !== "");
      const results = memory.notes
        .filter((note) => words.every((word) => `${note.title}\n${note.body}`.toLowerCase().includes(word)))
        .slice(0, parsed.data.limit)
        .map((note) => {
          const line = [note.title, ...note.body.split("\n")].find((candidate) => words.some((word) => candidate.toLowerCase().includes(word))) ?? note.title;
          return { noteId: note.noteId, title: note.title, line: line.slice(0, runnerLimits.memoryQueryMaxChars), kind: note.kind, scope: note.scope };
        });
      send(response, 200, memorySearchResponseSchema.parse({ results }));
      return;
    }
    if (endpoint === "read" && request.method === "GET") {
      const noteId = decodeURIComponent(rest.slice("notes/".length));
      const note = memory.notes.find((candidate) => candidate.noteId === noteId);
      if (note === undefined) {
        ostraError(response, 404, "not-found", "There's no approved memory note with that ID in this project.");
        return;
      }
      send(response, 200, memoryNoteResponseSchema.parse(note));
      return;
    }
    if (endpoint === "propose" && request.method === "POST") {
      const parsed = memoryProposalRequestSchema.safeParse(await readBody(request));
      const refusal = memory.refusals.shift();
      let answer: MemoryProposalResponse;
      if (!parsed.success) {
        answer = { code: "invalid" };
      } else if (refusal !== undefined) {
        answer = refusal;
      } else {
        memory.proposals.push({ taskId, bearer, input: parsed.data });
        answer = { proposalId: proposalIdSchema.parse(`proposal-${String(memory.proposals.length)}`) };
      }
      send(response, 200, memoryProposalResponseSchema.parse(answer));
      return;
    }
    ostraError(response, 404, "not-found", "no such endpoint");
  };

  // Milestone 6 (tickets 22 and 23): the draft, the review and the proposal, as minor 5 says them.
  const handleTeam = async (request: IncomingMessage, response: ServerResponse, taskId: string, endpoint: "draft" | "review" | "environment"): Promise<void> => {
    const bearer = bearerOf(request);
    if (bearer === undefined || !accessTokens.has(bearer)) {
      ostraError(response, 401, "unauthorized", "a valid access token is required");
      return;
    }
    if (!tasks.has(taskId) || request.method !== "POST") {
      ostraError(response, 404, "not-found", "no such task");
      return;
    }
    team.calls.push({ endpoint, taskId, bearer });
    if (team.down) {
      ostraError(response, 503, "unavailable", "core is down");
      return;
    }
    const body = await readBody(request);
    switch (endpoint) {
      case "draft": {
        const parsed = draftRequestSchema.safeParse(body);
        let answer: DraftResponse;
        if (!parsed.success) {
          answer = { code: "invalid" };
        } else if (team.refusals.draft !== null) {
          answer = team.refusals.draft;
        } else {
          team.drafts.push({ taskId, bearer, body: parsed.data });
          answer = { draftId: draftIdSchema.parse(`draft-${String(team.drafts.length)}`), version: team.drafts.length };
        }
        send(response, 200, draftResponseSchema.parse(answer));
        return;
      }
      case "review": {
        const parsed = reviewRequestSchema.safeParse(body);
        let answer: ReviewResponse;
        if (!parsed.success) {
          answer = { code: "invalid" };
        } else if (team.refusals.review !== null) {
          answer = team.refusals.review;
        } else {
          team.reviews.push({ taskId, bearer, body: parsed.data });
          answer = { reviewRunId: reviewRunIdSchema.parse(`review-run-${String(team.reviews.length)}`) };
        }
        send(response, 200, reviewResponseSchema.parse(answer));
        return;
      }
      case "environment": {
        const parsed = environmentProposalRequestSchema.safeParse(body);
        let answer: EnvironmentProposalResponse;
        if (!parsed.success) {
          answer = { code: "invalid" };
        } else if (team.refusals.environment !== null) {
          answer = team.refusals.environment;
        } else {
          team.proposals.push({ taskId, bearer, body: parsed.data });
          answer = { proposalId: environmentProposalIdSchema.parse(`environment-proposal-${String(team.proposals.length)}`) };
        }
        send(response, 200, environmentProposalResponseSchema.parse(answer));
        return;
      }
      default:
        endpoint satisfies never;
    }
  };

  // The bulk path (ADR 0043, ticket 12's endpoints, as the protocol's schemas say them).
  const handleBlobs = async (request: IncomingMessage, response: ServerResponse, match: RegExpExecArray): Promise<void> => {
    const bearer = bearerOf(request);
    if (bearer === undefined || !accessTokens.has(bearer)) {
      ostraError(response, 401, "unauthorized", "a valid access token is required");
      return;
    }
    const taskId = decodeURIComponent(match[1] ?? "");
    const task = tasks.get(taskId);
    if (task === undefined) {
      ostraError(response, 404, "not-found", "no such task");
      return;
    }
    const stale = (epoch: number): boolean => {
      if (epoch !== task.spec.leaseEpoch) {
        send(response, 409, { error: { code: "stale-lease", message: "stale", currentEpoch: task.spec.leaseEpoch } });
        return true;
      }
      return false;
    };
    const id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const query = Object.fromEntries(new URLSearchParams(match[4] ?? ""));
    if (request.method === "POST" && id === undefined) {
      bulkCalls.push("start");
      const parsed = blobUploadStartRequestSchema.safeParse(await readBody(request));
      if (!parsed.success) {
        ostraError(response, 400, "bad-request", "the start body doesn't match the protocol");
        return;
      }
      if (stale(parsed.data.leaseEpoch)) {
        return;
      }
      if (bulkFaults.refuseUploads) {
        ostraError(response, 503, "unavailable", "the blob store is down");
        return;
      }
      // The same digest and size for the same task resume the upload already open.
      const open = [...uploads.entries()].find(
        ([, upload]) => upload.taskId === taskId && upload.sha256 === parsed.data.sha256 && upload.size === parsed.data.size,
      );
      if (open !== undefined) {
        send(response, 200, { uploadId: open[0], receivedBytes: open[1].held.length });
        return;
      }
      const uploadId = randomUUID();
      uploads.set(uploadId, { taskId, sha256: parsed.data.sha256, size: parsed.data.size, contentType: parsed.data.contentType, purpose: parsed.data.purpose, held: Buffer.alloc(0) });
      send(response, 200, { uploadId, receivedBytes: 0 });
      return;
    }
    if (request.method === "PUT" && id !== undefined && match[3] === undefined) {
      bulkCalls.push("chunk");
      const upload = uploads.get(id);
      const parsed = blobChunkQuerySchema.safeParse(query);
      const bytes = await readBytes(request);
      if (upload?.taskId !== taskId || !parsed.success) {
        ostraError(response, 404, "not-found", "no such upload");
        return;
      }
      if (stale(parsed.data.leaseEpoch)) {
        return;
      }
      if (bytes.length > runnerLimits.uploadChunkMaxBytes) {
        ostraError(response, 413, "too-large", "the chunk is over the cap");
        return;
      }
      if (parsed.data.offset !== upload.held.length) {
        ostraError(response, 409, "offset-mismatch", "the offset isn't the bytes held");
        return;
      }
      if (bulkFaults.dropChunks > 0) {
        // Half the chunk arrives, then the connection drops: the runner must ask where to resume.
        bulkFaults.dropChunks -= 1;
        upload.held = Buffer.concat([upload.held, bytes.subarray(0, Math.floor(bytes.length / 2))]);
        request.socket.destroy();
        return;
      }
      upload.held = Buffer.concat([upload.held, bytes]);
      send(response, 200, { receivedBytes: upload.held.length });
      return;
    }
    if (request.method === "POST" && id !== undefined && match[3] !== undefined) {
      bulkCalls.push("finish");
      const upload = uploads.get(id);
      const parsed = blobUploadFinishRequestSchema.safeParse(await readBody(request));
      if (upload?.taskId !== taskId || !parsed.success) {
        ostraError(response, 404, "not-found", "no such upload");
        return;
      }
      if (stale(parsed.data.leaseEpoch)) {
        return;
      }
      uploads.delete(id);
      if (upload.held.length !== upload.size || digest(upload.held) !== upload.sha256) {
        ostraError(response, 409, "digest-mismatch", "the upload isn't what it said it was");
        return;
      }
      const blobId = randomUUID();
      blobs.set(blobId, { taskId, bytes: upload.held, sha256: upload.sha256, contentType: upload.contentType, purpose: upload.purpose });
      send(response, 200, { blobId, size: upload.size, sha256: upload.sha256 });
      return;
    }
    if (request.method === "GET" && id !== undefined) {
      bulkCalls.push("download");
      if (stale(Number(query["leaseEpoch"]))) {
        return;
      }
      const blob = blobs.get(id);
      if (blob?.taskId !== taskId) {
        ostraError(response, 404, "not-found", "no such blob for this task");
        return;
      }
      if (bulkFaults.failDownloads.has(id)) {
        ostraError(response, 503, "unavailable", "the blob store is down");
        return;
      }
      const bytes = bulkFaults.corruptDownloads.has(id) ? Buffer.concat([blob.bytes.subarray(0, Math.max(0, blob.bytes.length - 1)), Buffer.from("x")]) : blob.bytes;
      response.writeHead(200, { "content-type": blob.contentType, "content-length": bytes.length, [runnerHeaders.blobSha256]: blob.sha256 });
      response.end(bytes);
      return;
    }
    ostraError(response, 404, "not-found", "no such endpoint");
  };

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
      const minorHeader = request.headers[runnerHeaders.minor];
      tokenRequests.push({
        nonce: parsed.data.nonce,
        issuedAt: parsed.data.issuedAt,
        minor: typeof minorHeader === "string" ? minorHeader : undefined,
      });
      const scripted = tokenRefusals.shift();
      if (scripted !== undefined) {
        send(response, scripted.status, scripted.body);
        return;
      }
      // Core's four checks, in core's order, each with its reason for a runner of minor 2 or later.
      const now = options.now?.() ?? Date.now();
      const refuse = (status: 401 | 403, reason: TokenRefusalReason, message: string): void => {
        const body: RunnerHttpError = {
          error: { code: "unauthorized", message, reason, ...(reason === "clock-skew" ? { serverTime: now } : {}) },
        };
        send(response, status, encodeRunnerHttpErrorForMinor(body, minorFromHeader(typeof minorHeader === "string" ? minorHeader : undefined)));
      };
      if (Math.abs(now - parsed.data.issuedAt) > runnerLimits.assertionSkewMs) {
        refuse(401, "clock-skew", "the assertion's issuedAt is too far from the server's clock");
        return;
      }
      const runner = runners.get(parsed.data.runnerId);
      const signed =
        runner !== undefined &&
        verify(
          null,
          Buffer.from(tokenAssertionCanonicalString(parsed.data), "utf8"),
          createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: runner.request.publicKey }, format: "jwk" }),
          Buffer.from(parsed.data.signature, "base64url"),
        );
      if (runner === undefined || !signed) {
        refuse(401, "unknown-key", "the assertion is not signed by a known runner");
        return;
      }
      if (runner.revoked) {
        refuse(403, "revoked", "this runner is revoked");
        return;
      }
      if (seenNonces.has(parsed.data.nonce)) {
        refuse(401, "replayed", "the assertion was already used");
        return;
      }
      seenNonces.add(parsed.data.nonce);
      tokensIssued.set(runner.runnerId, (tokensIssued.get(runner.runnerId) ?? 0) + 1);
      const accessToken = `ostra-runner-${randomBytes(24).toString("base64url")}`;
      accessTokens.set(accessToken, runner.runnerId);
      send(response, 200, { accessToken, expiresAt: Date.now() + 600_000 });
      return;
    }
    const blobMatch = /^\/runner\/v1\/tasks\/([^/?]+)\/blobs(?:\/([^/?]+))?(\/finish)?(?:\?(.*))?$/.exec(path);
    if (blobMatch !== null) {
      await handleBlobs(request, response, blobMatch);
      return;
    }
    const teamMatch = /^\/runner\/v1\/tasks\/([^/?]+)\/(draft|review|environment-proposal)$/.exec(path);
    if (teamMatch !== null) {
      const which = teamMatch[2] === "draft" ? "draft" : teamMatch[2] === "review" ? "review" : "environment";
      await handleTeam(request, response, decodeURIComponent(teamMatch[1] ?? ""), which);
      return;
    }
    const memoryMatch = /^\/runner\/v1\/tasks\/([^/?]+)\/memory\/(search|notes\/[^/?]+|proposals)$/.exec(path);
    if (memoryMatch !== null) {
      await handleMemory(request, response, decodeURIComponent(memoryMatch[1] ?? ""), memoryMatch[2] ?? "");
      return;
    }
    // Milestone 5 (ticket 21): the registry's credentials, for a runner's access token.
    const registryMatch = /^\/runner\/v1\/(tasks|snapshots)\/([^/?]+)\/(pull-credential|push-credential)$/.exec(path);
    if (registryMatch !== null && request.method === "POST") {
      const bearer = bearerOf(request);
      const id = decodeURIComponent(registryMatch[2] ?? "");
      const pull = registryMatch[3] === "pull-credential";
      registry.requests.push({ kind: pull ? "pull" : "push", id, bearer });
      if (bearer === undefined || !accessTokens.has(bearer)) {
        ostraError(response, 401, "unauthorized", "a valid access token is required");
        return;
      }
      if (pull) {
        const parsed = pullCredentialRequestSchema.safeParse(await readBody(request));
        const held = registry.pulls.get(id);
        if (!parsed.success || parsed.data.leaseEpoch !== held?.leaseEpoch) {
          send(response, 409, { error: { code: "stale-lease", message: "stale" } });
          return;
        }
        if (held.credential === null) {
          send(response, 409, { error: { code: "no-image", message: "the registry is pulled with the cluster's own identity: there's no pull credential" } });
          return;
        }
        send(response, 200, pullCredentialResponseSchema.parse(held.credential));
        return;
      }
      const parsed = pushCredentialRequestSchema.safeParse(await readBody(request));
      const credential = registry.pushes.get(id);
      if (!parsed.success || credential === undefined) {
        send(response, 409, { error: { code: "not-the-builder", message: "not this runner's build" } });
        return;
      }
      send(response, 200, pushCredentialResponseSchema.parse(credential));
      return;
    }
    const taskMatch = /^\/runner\/v1\/tasks\/([^/?]+)\/(spec|credentials)(?:\?(.*))?$/.exec(path);
    if (taskMatch !== null) {
      const bearer = bearerOf(request);
      if (bearer === undefined || !accessTokens.has(bearer)) {
        ostraError(response, 401, "unauthorized", "a valid access token is required");
        return;
      }
      const taskId = decodeURIComponent(taskMatch[1] ?? "");
      const task = tasks.get(taskId);
      if (task === undefined) {
        ostraError(response, 404, "not-found", "no such task");
        return;
      }
      if (taskMatch[2] === "spec" && request.method === "GET") {
        while (holdSpecs.has(taskId) && !response.destroyed) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const epoch = Number(new URLSearchParams(taskMatch[3] ?? "").get("leaseEpoch"));
        if (epoch !== task.spec.leaseEpoch) {
          send(response, 409, { error: { code: "stale-lease", message: "stale", currentEpoch: task.spec.leaseEpoch } });
          return;
        }
        send(response, 200, task.spec);
        return;
      }
      if (taskMatch[2] === "credentials" && request.method === "POST") {
        const parsed = taskCredentialsRequestSchema.safeParse(await readBody(request));
        if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.leaseEpoch !== task.spec.leaseEpoch) {
          send(response, 409, { error: { code: "stale-lease", message: "stale", currentEpoch: task.spec.leaseEpoch } });
          return;
        }
        credentialsIssued.set(taskId, (credentialsIssued.get(taskId) ?? 0) + 1);
        send(response, 200, task.credentials);
        return;
      }
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
    tokenRefusals,
    tokenRequests,
    requests,
    tasks,
    credentialsIssued,
    blobs,
    memory,
    team,
    bulkFaults,
    bulkCalls,
    putBlob: (taskId, bytes, contentType, given) => {
      const blobId = given ?? randomUUID();
      blobs.set(blobId, { taskId, bytes, sha256: digest(bytes), contentType, purpose: "ticket-file" });
      return blobId;
    },
    httpServer: server,
    setInfo: (next) => {
      infoOverride = next;
    },
    holdSpecs,
    registry,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
