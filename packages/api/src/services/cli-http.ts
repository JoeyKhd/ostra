import { randomBytes, randomUUID } from "node:crypto";

import { installationStateSelect, installationUsable, requireProjectAccess, resolveCliSession, startCliSession } from "@ostra/domain";
import type { CliSessionCaller } from "@ostra/domain";
import {
  CLI_PATH_PREFIX,
  cliDeviceRequestSchema,
  cliDeviceTokenRequestSchema,
  cliTaskBranchesResponseSchema,
  memberIdSchema,
  organizationIdSchema,
  projectIdSchema,
  userIdSchema,
} from "@ostra/protocol";
import type {
  CliDeviceResponse,
  CliDeviceTokenError,
  CliDeviceTokenResponse,
  CliHttpError,
  CliHttpErrorCode,
  CliSessionDeleteResponse,
} from "@ostra/protocol";
import { secretRefSchema } from "@ostra/adapter-sdk";

import { memberContextOf } from "../auth/scope.ts";
import type { ApiDeps } from "../trpc/context.ts";

// The `ostra` CLI's HTTP on the web app (F-103, ADR 0051; ticket 39), at `/api/cli/v1/`. A plain
// `Request` in and a `Response` out, so the web app's route is one line and the tests call it
// directly. Every route but the two device ones needs `Authorization: Bearer <CLI session token>`
// and refuses a missing, revoked or expired session with 401 and the words the CLI prints. A CLI
// session reads branch names and clone URLs and nothing else: ostra hands out no token (git uses
// the member's own access), and no tRPC procedure accepts the session.
//
// The device-code grant is the panel's `/device` page, as for a runner (milestone 1), with the
// purpose `cli` and its own client ID, so a runner's flow and the CLI's never meet: the grant's code
// is exchanged here for a CLI session and never for a login session.

/** The device grant's client ID for the CLI; a runner's is `ostra-runner`. */
export const CLI_CLIENT_ID = "ostra-cli";

const DEVICE_CODE_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
/** An unauthenticated route that writes rows is capped: no more open CLI grants than this at once. */
const MAX_OPEN_GRANTS = 500;
/** The characters of a user code: no 0, 1, I or O to misread. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const fail = (status: number, code: CliHttpErrorCode, message: string): Response => json({ error: { code, message } } satisfies CliHttpError, status);

const deviceFail = (code: CliDeviceTokenError["error"]["code"], message: string): Response => json({ error: { code, message } } satisfies CliDeviceTokenError, 400);

const newUserCode = (): string => {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length)).join("");
};

const readJson = async (request: Request): Promise<unknown> => {
  try {
    const body: unknown = await request.json();
    return body;
  } catch {
    return undefined;
  }
};

// ---------- the device-code grant ----------

/** `POST /device`: starts a grant for a CLI session. Nobody is signed in yet. */
const startDevice = async (deps: ApiDeps, request: Request): Promise<Response> => {
  const parsed = cliDeviceRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return fail(400, "bad-request", "That isn't a sign-in request: it needs the machine's name and the CLI's version");
  }
  const { db, ports, settings } = deps;
  const now = ports.clock.now();
  await db.deviceCode.deleteMany({ where: { purpose: "cli", expiresAt: { lt: new Date(now) } } });
  if ((await db.deviceCode.count({ where: { purpose: "cli" } })) >= MAX_OPEN_GRANTS) {
    return fail(429, "rate-limited", "Too many sign-ins are waiting. Try again in a few minutes");
  }
  const deviceCode = randomBytes(30).toString("base64url");
  const expiresAt = now + DEVICE_CODE_TTL_MS;
  let userCode = newUserCode();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.deviceCode.create({
        data: {
          id: randomUUID(),
          deviceCode,
          userCode,
          expiresAt: new Date(expiresAt),
          status: "pending",
          pollingInterval: POLL_INTERVAL_MS,
          clientId: CLI_CLIENT_ID,
          scope: "cli",
          purpose: "cli",
          machineName: parsed.data.name,
        },
      });
      break;
    } catch (error) {
      // A user code that is taken: draw another.
      if (attempt >= 4) {
        throw error;
      }
      userCode = newUserCode();
    }
  }
  const page = new URL("/device", settings.publicUrl);
  const complete = new URL(page);
  complete.searchParams.set("user_code", userCode);
  return json({
    deviceCode,
    userCode,
    verificationUrl: page.toString(),
    verificationUrlComplete: complete.toString(),
    expiresAt,
    intervalSeconds: POLL_INTERVAL_MS / 1000,
  } satisfies CliDeviceResponse);
};

/** `POST /device/token`: the grant's answer; once a member approved the code, the session and its token, this once. */
const pollDevice = async (deps: ApiDeps, request: Request): Promise<Response> => {
  const parsed = cliDeviceTokenRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return fail(400, "bad-request", "That isn't a token request: it needs the device code");
  }
  const { db, ports, settings } = deps;
  const now = ports.clock.now();
  const grant = await db.deviceCode.findFirst({ where: { deviceCode: parsed.data.deviceCode, purpose: "cli" } });
  if (grant === null) {
    return deviceFail("expired-token", "That sign-in isn't waiting any more. Run `ostra login` again");
  }
  if (grant.expiresAt.getTime() <= now) {
    await db.deviceCode.deleteMany({ where: { id: grant.id } });
    return deviceFail("expired-token", "The code expired before it was approved. Run `ostra login` again");
  }
  if (grant.status === "denied") {
    await db.deviceCode.deleteMany({ where: { id: grant.id } });
    return deviceFail("access-denied", "The sign-in was denied in the browser");
  }
  if (grant.lastPolledAt !== null && now - grant.lastPolledAt.getTime() < (grant.pollingInterval ?? POLL_INTERVAL_MS)) {
    return deviceFail("slow-down", "Polling too fast: wait for the interval");
  }
  await db.deviceCode.updateMany({ where: { id: grant.id }, data: { lastPolledAt: new Date(now) } });
  if (grant.status !== "approved" || grant.userId === null) {
    return deviceFail("authorization-pending", "Waiting for the approval in the browser");
  }
  // One session per approval: the poll that deletes the grant is the one that makes it.
  const claimed = await db.deviceCode.deleteMany({ where: { id: grant.id, status: "approved" } });
  if (claimed.count !== 1) {
    return deviceFail("expired-token", "That sign-in was used already. Run `ostra login` again");
  }
  const user = await db.user.findUnique({ where: { id: grant.userId }, select: { id: true, name: true } });
  // The member of the organization the approver was signed into; a grant approved before that was recorded falls back to the oldest membership.
  const member = await db.member.findFirst({
    where: grant.organizationId === null ? { userId: grant.userId } : { userId: grant.userId, organizationId: grant.organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (user === null || member === null) {
    return deviceFail("access-denied", "This account belongs to no organization");
  }
  const started = await startCliSession(
    { db, ...ports },
    { userId: userIdSchema.parse(user.id), memberId: memberIdSchema.parse(member.id), machineName: grant.machineName ?? "unnamed machine", sessionDays: settings.cliSessionDays },
  );
  if (!started.ok) {
    return fail(400, "bad-request", started.message);
  }
  return json({ sessionId: started.sessionId, token: started.token, expiresAt: started.expiresAt, username: user.name } satisfies CliDeviceTokenResponse);
};

// ---------- the branches of a task ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a ref names: a task's ID or a ticket's key, from the ID, the key or the task's URL. */
const refOf = (raw: string): { readonly kind: "task"; readonly id: string } | { readonly kind: "key"; readonly key: string } | null => {
  const text = raw.trim();
  const fromUrl = /^https?:\/\/[^\s]+\/tasks\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(text);
  const candidate = fromUrl?.[1] ?? text;
  if (UUID.test(candidate)) {
    return { kind: "task", id: candidate.toLowerCase() };
  }
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(candidate) ? { kind: "key", key: candidate } : null;
};

const branches = async (deps: ApiDeps, caller: CliSessionCaller, rawRef: string): Promise<Response> => {
  const { db, ports } = deps;
  const ref = refOf(rawRef);
  const notFound = () => fail(404, "not-found", "No task by that key, ID or URL is open to you");
  if (ref === null) {
    return notFound();
  }
  // A session belongs to one member of one organization (ADR 0051): it reads the tasks of the projects that member can open, never another organization's the same account is in.
  const member = await db.member.findFirst({ where: { id: caller.memberId, organizationId: caller.organizationId, userId: caller.userId } });
  if (member === null) {
    return notFound();
  }
  const context = await memberContextOf(db, caller.userId, member);
  const candidates = await db.task.findMany({
    where:
      ref.kind === "task"
        ? { id: ref.id, organizationId: caller.organizationId }
        : { ticket: { key: { equals: ref.key, mode: "insensitive" } }, organizationId: caller.organizationId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, organizationId: true, projectId: true, ticket: { select: { key: true } }, project: { select: { access: true } } },
  });
  const found = candidates.find((task) => requireProjectAccess(context.scope, { id: projectIdSchema.parse(task.projectId), organizationId: context.scope.organizationId, access: task.project.access }, "read").ok);
  if (found === undefined) {
    return notFound();
  }
  const rows = await db.taskRepo.findMany({
    where: { taskId: found.id, organizationId: found.organizationId },
    orderBy: { createdAt: "asc" },
    select: { branchName: true, baseBranch: true, headSha: true, repo: { select: { fullName: true, hostRepoId: true, installationId: true, connection: { select: { appId: true, privateKeySecretRef: true } }, ...installationStateSelect } } },
  });
  // The clone URL is the code host's own, from its listing; one listing per installation.
  const listings = new Map<string, Awaited<ReturnType<typeof ports.adapters.codeHost.listRepos>>>();
  const repos: unknown[] = [];
  for (const row of rows) {
    // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
    if (!installationUsable(row.repo.installation)) {
      return fail(409, "bad-request", "One of the task's repos is reached through a GitHub installation that isn't linked to ostra. Ask an organization admin to link it");
    }
    const ref = secretRefSchema.safeParse(row.repo.connection.privateKeySecretRef);
    const key = ref.success ? await ports.adapters.secretStore.get(organizationIdSchema.parse(found.organizationId), ref.data) : null;
    if (key?.ok !== true) {
      return fail(502, "bad-request", "The code host's App couldn't be read, so the clone address isn't known. Ask an admin to check the GitHub connection");
    }
    const listKey = `${row.repo.connection.appId}:${row.repo.installationId}`;
    if (!listings.has(listKey)) {
      listings.set(listKey, await ports.adapters.codeHost.listRepos({ appId: row.repo.connection.appId, privateKey: key.value }, row.repo.installationId));
    }
    const listed = listings.get(listKey);
    const hostRepo = listed?.ok === true ? listed.value.find((candidate) => candidate.hostRepoId === row.repo.hostRepoId) : undefined;
    if (hostRepo === undefined) {
      return fail(502, "bad-request", "The code host doesn't list one of the task's repos, so its clone address isn't known");
    }
    repos.push({ fullName: row.repo.fullName, cloneUrl: hostRepo.cloneUrl, branch: row.branchName, baseBranch: row.baseBranch, headSha: row.headSha });
  }
  // The protocol's own schema checks what leaves: a host that answers an address git cannot use is refused here.
  const response = cliTaskBranchesResponseSchema.safeParse({ taskId: found.id, key: found.ticket?.key ?? null, repos });
  return response.success ? json(response.data) : fail(502, "bad-request", "The code host answered an address the CLI cannot use");
};

// ---------- the dispatcher ----------

/**
 * Handles one request under `/api/cli/v1/`. The web app's route passes the request through; a path
 * it does not know is a 404 in the CLI's own error shape.
 */
export const handleCliRequest = async (deps: ApiDeps, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(CLI_PATH_PREFIX) ? url.pathname.slice(CLI_PATH_PREFIX.length) : null;
  if (path === null) {
    return fail(404, "not-found", "No such address");
  }
  if (path === "/device" && request.method === "POST") {
    return startDevice(deps, request);
  }
  if (path === "/device/token" && request.method === "POST") {
    return pollDevice(deps, request);
  }
  const branchesOf = /^\/tasks\/(.+)\/branches$/.exec(path);
  const session = path === "/session" && request.method === "DELETE";
  const ref = request.method === "GET" ? branchesOf?.[1] : undefined;
  if (!session && ref === undefined) {
    return fail(404, "not-found", "No such address");
  }
  const resolved = await resolveCliSession({ db: deps.db, clock: deps.ports.clock }, request.headers.get("authorization"));
  if (!resolved.ok) {
    return fail(401, resolved.code, resolved.message);
  }
  if (session) {
    await deps.db.cliSession.updateMany({ where: { id: resolved.caller.sessionId, revokedAt: null }, data: { revokedAt: new Date(deps.ports.clock.now()) } });
    return json({ revoked: true } satisfies CliSessionDeleteResponse);
  }
  return ref === undefined ? fail(404, "not-found", "No such address") : branches(deps, resolved.caller, safeDecode(ref));
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

