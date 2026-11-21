import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { createPanelPreviewTokens, markViewConnected, parsePanelPreviewPath } from "@ostra/domain";
import type { PanelPreviewClaims } from "@ostra/domain";
import { createPanelStreamReader, encodePanelStreamRecord, panelPreviewInputBodySchema, previewKeySchema, previewViewIdSchema } from "@ostra/protocol";
import type { OrganizationId, PreviewInputEvent, PreviewViewId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { PREVIEW_LINK_HEADER, PREVIEW_LINK_MISSES_PER_MINUTE } from "../services/preview-link-tries.ts";
import { servePreviewInput, servePreviewStream } from "../services/preview-relay.ts";
import { createApiHarness, PREVIEW_SECRET, seedConnectionAndModel, seedPreviewableTask, seedProject, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller, PreviewableTask } from "../testing/index.ts";
import type { ApiDeps, Context } from "../trpc/context.ts";

// Milestone 8, ticket 20 (F-141, F-142, ADR 0068): the API of a task's previews, their views and
// their sharing, on real Postgres. A restricted project holds the tasks; its member, an organization
// admin, an organization member it doesn't list, a person a preview names, another organization's
// admin and a link's holder each try every level. The stream and input routes run against a fake
// core that checks the panel's token for the view, as core's own routes do.

let harness: ApiHarness;
let organizationId: OrganizationId;
let projectId: ProjectId;
/** The restricted project's member: drives the tasks. */
let driver: SeededMember;
/** An organization member the project doesn't list. */
let outsider: SeededMember;
/** An organization member the project doesn't list, whom a preview names. */
let named: SeededMember;
let fakeCore: FakeCore;

let unique = 0;
const label = (prefix: string): string => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

const seedMember = async (): Promise<SeededMember> => {
  const name = label("person");
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name}@example.com`, username: name } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } }));
};

const task = (): Promise<PreviewableTask> => seedPreviewableTask(harness, { organizationId, projectId, ownerMemberId: harness.fixture.a.admin.id, driverMemberId: driver.id });

/** A signed-out visitor from one address, as the viewer page calls its procedures. */
const visitor = (address: string, deps: ApiDeps = harness.deps): AppCaller =>
  harness.callerFor({ deps, headers: new Headers({ "x-forwarded-for": address }), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });

/** A fresh address for each visitor, so one test's misses never count against another's. */
const address = (): string => `203.0.113.${String((unique += 1) % 250)}`;

const tokenOf = (url: string): string => {
  const token = url.split("/p/")[1];
  if (token === undefined) {
    throw new Error("no token in the link's URL");
  }
  return token;
};

/** A link to the task's primary preview, made by the driver. */
const linkTo = async (target: PreviewableTask, options: { readonly allowInput?: boolean; readonly kind?: "expiring" | "public"; readonly hours?: number | null } = {}) => {
  const made = await (await harness.as(driver)).previews.createLink({
    taskId: target.taskId,
    key: target.key,
    kind: options.kind ?? "expiring",
    allowInput: options.allowInput ?? false,
    expiresInHours: options.kind === "public" ? null : (options.hours ?? null),
  });
  if (!made.ok) {
    throw new Error(`no link: ${made.reason}`);
  }
  return { ...made, token: tokenOf(made.url) };
};

/** What a member's `previews.open` gives: open with input or not, or the tRPC code it was refused with. */
const openAs = async (member: SeededMember, target: PreviewableTask): Promise<string> => {
  try {
    const opened = await (await harness.as(member)).previews.open({ taskId: target.taskId, key: target.key });
    return opened.ok ? (opened.input ? "open, input" : "open, watch-only") : `refused: ${opened.reason}`;
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    throw error;
  }
};

/** What a link's holder gets: the viewer page's state, and input or not. */
const openWith = async (token: string): Promise<string> => {
  const page = await visitor(address()).previews.link.open({ token });
  return page.state === "live" ? (page.input ? "live, input" : "live, watch-only") : page.state;
};

const setLinksAllowed = async (enabled: boolean): Promise<void> => {
  await (await harness.as(harness.fixture.a.admin)).organization.setPublicPreviewLinks({ enabled });
};

// ---------- the fake core ----------

type CoreCall = { readonly route: "stream" | "input"; readonly viewId: PreviewViewId; readonly claims: PanelPreviewClaims; readonly events?: readonly PreviewInputEvent[] };
type FakeCore = { readonly url: string; readonly calls: CoreCall[]; readonly refused: string[]; readonly close: () => Promise<void> };

const jpeg = (fill: number): Uint8Array => {
  const bytes = new Uint8Array(32).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

/** Core's two panel routes, as `apps/core/src/previews/previews.ts` answers them: the panel's token for the view, or 401. */
const startFakeCore = async (): Promise<FakeCore> => {
  const tokens = createPanelPreviewTokens(PREVIEW_SECRET);
  const calls: CoreCall[] = [];
  const refused: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://core.internal");
    const route = parsePanelPreviewPath(url.pathname);
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const claims = route === null ? null : tokens.verify(bearer, Date.now(), route.viewId);
    if (route === null || claims === null) {
      refused.push(url.pathname);
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "the panel's token for this view is required" } }));
      return;
    }
    if (route.route === "stream") {
      calls.push({ route: "stream", viewId: route.viewId, claims });
      response.writeHead(200, { "content-type": "application/octet-stream" });
      for (const seq of [1, 2]) {
        response.write(encodePanelStreamRecord({ type: "frame", header: { seq, at: Date.now(), width: 1440, height: 900 }, jpeg: jpeg(seq) }));
      }
      response.end(encodePanelStreamRecord({ type: "close", close: { reason: "closed" } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = panelPreviewInputBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      calls.push({ route: "input", viewId: route.viewId, claims, events: body.events });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the fake core didn't bind");
  }
  return {
    url: `http://127.0.0.1:${String(bound.port)}`,
    calls,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** The harness's dependencies with core at the fake's address. */
const relayDeps = (): ApiDeps => ({ ...harness.deps, previews: { ...harness.deps.previews, coreUrl: fakeCore.url } });

const memberContext = async (member: SeededMember): Promise<Context> => ({ ...(await harness.contextOf(member)), deps: relayDeps() });

const signedOutContext = (): Context => ({ deps: relayDeps(), headers: new Headers(), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });

const streamRequest = (viewId: string, headers: Record<string, string> = {}): Request => new Request(`http://localhost:3000/api/previews/${viewId}/stream`, { headers });

const click: PreviewInputEvent = { kind: "mouse", action: "down", x: 120, y: 48, button: "left", clickCount: 1, modifiers: 0 };

const inputRequest = (viewId: string, headers: Record<string, string> = {}, body: unknown = { events: [click] }): Request =>
  new Request(`http://localhost:3000/api/previews/${viewId}/input`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

const errorCode = async (response: Response): Promise<string> => errorBodySchema.parse(await response.json()).error.code;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  organizationId = harness.fixture.a.organization.id;
  ({ projectId } = await seedProject(harness, world, label("previews")));
  const admin = await harness.as(harness.fixture.a.admin);
  await admin.projects.setAccess({ projectId, access: "restricted" });
  driver = await seedMember();
  outsider = await seedMember();
  named = await seedMember();
  await admin.projects.setMember({ projectId, memberId: driver.id, role: "member" });
  fakeCore = await startFakeCore();
}, 120_000);

afterAll(async () => {
  await fakeCore.close();
  await harness.dispose();
});

// ---------- the pane ----------

describe("a task's previews in the pane (F-141)", () => {
  it("F-141: lists the task's previews with their sharing, and a member opens, keeps warm and closes a view of their own", async () => {
    const target = await task();
    const asDriver = await harness.as(driver);
    const listed = await asDriver.previews.list({ taskId: target.taskId });
    expect(listed).toMatchObject({ box: "running", can: { stream: true, tunnel: true, native: false }, carrier: "websocket", publicLinks: false, linkMaxDays: 7, lastScreenshot: null });
    expect(listed.previews).toEqual([
      expect.objectContaining({ key: target.key, label: "Web", port: 5173, primary: true, source: "declared", watchers: 0, sharing: { level: "members", memberIds: [], links: [] } }),
    ]);

    harness.fakes.outbox.clear();
    const opened = await asDriver.previews.open({ taskId: target.taskId, key: target.key });
    expect(opened).toMatchObject({ ok: true, input: true, label: "Web", port: 5173 });
    if (!opened.ok) {
      throw new Error("not opened");
    }
    // `preview.open` to the box's runner; the panel's token for core isn't in the answer.
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId: target.runnerId, kind: "preview.open" }]);
    expect(JSON.stringify(opened)).not.toContain("ostra-view-");
    expect((await asDriver.previews.list({ taskId: target.taskId })).previews[0]?.watchers).toBe(1);

    // Opening until the box's connection arrives; then each heartbeat keeps the box warm.
    expect(await asDriver.previews.heartbeat({ viewId: opened.viewId })).toEqual({ state: "opening" });
    await markViewConnected(harness.test.db, opened.viewId, "http://replica.internal:8787", Date.now());
    expect(await asDriver.previews.heartbeat({ viewId: opened.viewId })).toEqual({ state: "open" });
    expect((await harness.test.db.box.findUniqueOrThrow({ where: { id: target.boxId } })).previewWatchedAt).not.toBeNull();

    // Only its viewer closes it, or beats it: another member of the project gets NOT_FOUND.
    const colleague = await harness.as(harness.fixture.a.admin);
    expect(await trpcFailure(colleague.previews.close({ viewId: opened.viewId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(colleague.previews.heartbeat({ viewId: opened.viewId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await asDriver.previews.close({ viewId: opened.viewId })).toEqual({ closed: true });
    expect(await asDriver.previews.close({ viewId: opened.viewId })).toEqual({ closed: false });
    expect(await asDriver.previews.heartbeat({ viewId: opened.viewId })).toEqual({ state: "closed" });
  });

  it("F-141: a member's screenshot and \"Start the app\" go to the box, and each refusal is a code", async () => {
    const target = await task();
    const asDriver = await harness.as(driver);
    harness.fakes.outbox.clear();
    const taken = await asDriver.previews.takeScreenshot({ taskId: target.taskId, key: target.key, path: "/", width: "phone" });
    expect(taken).toMatchObject({ ok: true });
    expect(harness.fakes.outbox.commands).toMatchObject([{ kind: "screenshot.take", body: { key: target.key, path: "/", width: "phone", memberId: driver.id } }]);
    expect(await asDriver.previews.takeScreenshot({ taskId: target.taskId, key: previewKeySchema.parse("port-4100"), path: "/", width: "desktop" })).toEqual({ ok: false, reason: "port-not-allowed" });
    // The box still runs: "Start the app" starts what isn't running in it.
    expect(await asDriver.previews.startApp({ taskId: target.taskId })).toEqual({ ok: true, state: "running" });
    // A runner below minor 7 shows the reason instead.
    const old = await seedPreviewableTask(harness, { organizationId, projectId, ownerMemberId: harness.fixture.a.admin.id, minor: 6 });
    expect(await asDriver.previews.open({ taskId: old.taskId, key: old.key })).toEqual({ ok: false, reason: "runner-needs-upgrade" });
    expect(await asDriver.previews.takeScreenshot({ taskId: old.taskId, key: old.key, path: "/", width: "desktop" })).toEqual({ ok: false, reason: "runner-needs-upgrade" });
    // An outsider learns nothing of either.
    const asOutsider = await harness.as(outsider);
    expect(await trpcFailure(asOutsider.previews.startApp({ taskId: target.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(asOutsider.previews.takeScreenshot({ taskId: target.taskId, key: target.key, path: "/", width: "desktop" }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------- the levels ----------

describe("who can open a preview (F-142)", () => {
  it("F-142/c2: each level, for each kind of viewer: members, named people, an expiring link and a public one, with input only for a member who can open the task or a link that allows it", async () => {
    const target = await task();
    const viewers = { "organization admin": harness.fixture.a.admin, "project member": driver, outsider, "named person": named, "another organization's admin": harness.fixture.b.admin } as const;
    const everyone = async (): Promise<Record<string, string>> => {
      const seen: Record<string, string> = {};
      for (const [who, member] of Object.entries(viewers)) {
        seen[who] = await openAs(member, target);
      }
      return seen;
    };
    const asDriver = await harness.as(driver);

    // The project's members, the default: nobody outside it, named or not.
    expect(await everyone()).toEqual({
      "organization admin": "open, input",
      "project member": "open, input",
      outsider: "NOT_FOUND",
      "named person": "NOT_FOUND",
      "another organization's admin": "NOT_FOUND",
    });

    // Named people: that person watches, and gives no input (Q301); nobody else outside it.
    expect(await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id] })).toEqual({ ok: true, level: "named", linksEnded: 0, viewsClosed: 0 });
    expect(await everyone()).toEqual({
      "organization admin": "open, input",
      "project member": "open, input",
      outsider: "NOT_FOUND",
      "named person": "open, watch-only",
      "another organization's admin": "NOT_FOUND",
    });
    // Another organization's member can't be named.
    expect(await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id, harness.fixture.b.admin.id] })).toEqual({ ok: false, reason: "not-a-member" });

    // An expiring link: watch-only unless it allows input. The members' levels stay as they were.
    const watching = await linkTo(target);
    const using = await linkTo(target, { allowInput: true, hours: 1 });
    expect(using.expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(await openWith(watching.token)).toBe("live, watch-only");
    expect(await openWith(using.token)).toBe("live, input");
    expect(await everyone()).toMatchObject({ "named person": "open, watch-only", outsider: "NOT_FOUND" });
    // Up to OSTRA_PREVIEW_LINK_MAX_DAYS, and never longer.
    expect(await asDriver.previews.createLink({ taskId: target.taskId, key: target.key, kind: "expiring", allowInput: false, expiresInHours: 8 * 24 })).toEqual({ ok: false, reason: "too-long" });

    // Public: only where an organization admin allows public links, off by default.
    expect(await asDriver.previews.createLink({ taskId: target.taskId, key: target.key, kind: "public", allowInput: false, expiresInHours: null })).toEqual({ ok: false, reason: "public-links-off" });
    expect(await trpcFailure((await harness.as(driver)).organization.setPublicPreviewLinks({ enabled: true }))).toMatchObject({ code: "FORBIDDEN" });
    await setLinksAllowed(true);
    try {
      const open = await linkTo(target, { kind: "public" });
      expect(open.expiresAt).toBeNull();
      expect(await openWith(open.token)).toBe("live, watch-only");
      expect((await asDriver.previews.list({ taskId: target.taskId })).previews[0]?.sharing.links.map((link) => [link.kind, link.allowInput, link.state])).toEqual([
        ["public", false, "active"],
        ["expiring", true, "active"],
        ["expiring", false, "active"],
      ]);

      // Back to the project's members: every link ends, and every view of someone who no longer qualifies closes.
      const namedView = await (await harness.as(named)).previews.open({ taskId: target.taskId, key: target.key });
      if (!namedView.ok) {
        throw new Error("the named person's view didn't open");
      }
      const narrowed = await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "members", memberIds: [] });
      expect(narrowed).toMatchObject({ ok: true, level: "members", linksEnded: 3 });
      expect(await openWith(open.token)).toBe("revoked");
      expect(await openWith(using.token)).toBe("revoked");
      expect(await everyone()).toMatchObject({ "named person": "NOT_FOUND", "project member": "open, input" });
      expect((await harness.test.db.previewView.findUniqueOrThrow({ where: { id: namedView.viewId } })).state).toBe("closed");
      // The level change, the links and their revokes are audit entries, and events of the task.
      const actions = (await harness.test.db.auditEntry.findMany({ where: { entityId: target.taskId }, select: { action: true } })).map((entry) => entry.action);
      expect(actions.filter((action) => action === "preview.level_changed")).toHaveLength(2);
      expect(actions.filter((action) => action === "preview.link_created")).toHaveLength(3);
      expect(actions.filter((action) => action === "preview.link_revoked")).toHaveLength(3);
      expect(await harness.test.db.event.count({ where: { taskId: target.taskId, kind: { in: ["preview.level_changed", "preview.link_created", "preview.link_revoked"] } } })).toBe(8);
    } finally {
      await setLinksAllowed(false);
    }
  });

  it("F-142/c3: a named person sees that preview and nothing else of the task", async () => {
    const target = await task();
    await (await harness.as(driver)).previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id] });
    const asNamed = await harness.as(named);
    const opened = await asNamed.previews.open({ taskId: target.taskId, key: target.key });
    expect(opened).toMatchObject({ ok: true, input: false, label: "Web" });
    if (!opened.ok) {
      throw new Error("not opened");
    }
    expect(await asNamed.previews.heartbeat({ viewId: opened.viewId })).toEqual({ state: "opening" });
    // Every other procedure of the task refuses them, as it refuses anyone outside the project.
    for (const call of [
      () => asNamed.previews.list({ taskId: target.taskId }),
      () => asNamed.tasks.get({ taskId: target.taskId }),
      () => asNamed.tasks.history({ taskId: target.taskId }),
      () => asNamed.diff.get({ taskId: target.taskId }),
      () => asNamed.previews.startApp({ taskId: target.taskId }),
      () => asNamed.previews.takeScreenshot({ taskId: target.taskId, key: target.key, path: "/", width: "desktop" }),
      () => asNamed.previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id, outsider.id] }),
      () => asNamed.previews.createLink({ taskId: target.taskId, key: target.key, kind: "expiring", allowInput: true, expiresInHours: null }),
    ]) {
      expect(await trpcFailure(call())).toMatchObject({ code: "NOT_FOUND" });
    }
    // Nothing they tried was written.
    expect(await harness.test.db.previewLink.count({ where: { taskId: target.taskId } })).toBe(0);
    expect(await harness.test.db.previewAccessMember.count({ where: { previewAccess: { taskId: target.taskId } } })).toBe(1);
    // A watch-only viewer's input stops at the panel, before core and the runner.
    const response = await servePreviewInput(await memberContext(named), inputRequest(opened.viewId), opened.viewId);
    expect([response.status, await errorCode(response)]).toEqual([403, "watch-only"]);
    expect(fakeCore.calls.filter((call) => call.viewId === opened.viewId)).toEqual([]);
  });

  it("F-142/c4: an expired, a revoked and a forbidden public link each give no view, with the reason", async () => {
    const target = await task();
    const later = (ms: number): ApiDeps => ({ ...harness.deps, ports: { ...harness.deps.ports, clock: { now: () => Date.now() + ms } } });

    // Expired: an hour's link, two hours on. Its open view ends at its next heartbeat.
    const hour = await linkTo(target, { hours: 1 });
    const live = await visitor(address()).previews.link.open({ token: hour.token });
    if (live.state !== "live") {
      throw new Error(`the link opened ${live.state}`);
    }
    const expired = await visitor(address(), later(2 * 3_600_000)).previews.link.open({ token: hour.token });
    expect(expired).toMatchObject({ state: "expired", label: "Web", organizationName: harness.fixture.a.organization.name });
    expect(await visitor(address(), later(2 * 3_600_000)).previews.link.heartbeat({ token: hour.token, viewId: live.viewId })).toEqual({ state: "expired" });
    expect((await harness.test.db.previewView.findUniqueOrThrow({ where: { id: live.viewId } })).state).toBe("closed");

    // Revoked: its open views close at once, and the stream route refuses it.
    const day = await linkTo(target);
    const watching = await visitor(address()).previews.link.open({ token: day.token });
    if (watching.state !== "live") {
      throw new Error(`the link opened ${watching.state}`);
    }
    expect(await (await harness.as(driver)).previews.revokeLink({ linkId: day.linkId })).toEqual({ revoked: true, viewsClosed: 1 });
    expect(await (await harness.as(driver)).previews.revokeLink({ linkId: day.linkId })).toEqual({ revoked: false, viewsClosed: 0 });
    expect(await visitor(address()).previews.link.open({ token: day.token })).toMatchObject({ state: "revoked", label: "Web" });
    const response = await servePreviewStream(signedOutContext(), streamRequest(watching.viewId, { [PREVIEW_LINK_HEADER]: day.token }), watching.viewId);
    expect([response.status, await errorCode(response)]).toEqual([410, "view-closed"]);
    // An outsider can't revoke a link of a task they can't open.
    const other = await linkTo(target);
    expect(await trpcFailure((await harness.as(outsider)).previews.revokeLink({ linkId: other.linkId }))).toMatchObject({ code: "NOT_FOUND" });

    // Forbidden: a public link, once an organization admin turns public links off. Its views close at once.
    await setLinksAllowed(true);
    const open = await linkTo(target, { kind: "public" });
    const publicView = await visitor(address()).previews.link.open({ token: open.token });
    expect(publicView.state).toBe("live");
    expect(await (await harness.as(harness.fixture.a.admin)).organization.setPublicPreviewLinks({ enabled: false })).toEqual({ enabled: false, viewsClosed: 1 });
    expect(await visitor(address()).previews.link.open({ token: open.token })).toEqual({ state: "not-allowed", organizationName: harness.fixture.a.organization.name });
    expect(await (await harness.as(harness.fixture.a.admin)).organization.get()).toMatchObject({ publicPreviewLinks: false });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "organization.public_preview_links_changed" } })).toBeGreaterThanOrEqual(2);

    // An unknown token says nothing of whether it existed, nor does a token of another form.
    expect(await visitor(address()).previews.link.open({ token: `ostra-preview-${"A".repeat(43)}` })).toEqual({ state: "unknown" });
    expect(await visitor(address()).previews.link.open({ token: "not-a-token" })).toEqual({ state: "unknown" });
  });

  it("F-142/c5: a link's token is in its URL once, and the row keeps only its SHA-256", async () => {
    const target = await task();
    const made = await linkTo(target, { allowInput: true });
    expect(made.url).toMatch(/^http:\/\/localhost:3000\/p\/ostra-preview-[A-Za-z0-9_-]{43}$/);
    const row = await harness.test.db.previewLink.findUniqueOrThrow({ where: { id: made.linkId } });
    expect(row.tokenHash).toBe(createHash("sha256").update(made.token, "utf8").digest("hex"));
    expect(JSON.stringify(row)).not.toContain(made.token);
    // No read gives it again, and no audit entry, event or log line holds it.
    const listed = await (await harness.as(driver)).previews.list({ taskId: target.taskId });
    expect(listed.previews[0]?.sharing.links).toEqual([expect.objectContaining({ linkId: made.linkId, kind: "expiring", allowInput: true, state: "active" })]);
    expect(JSON.stringify(listed)).not.toContain(made.token);
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { entityId: target.taskId } }))).not.toContain(made.token);
    expect(JSON.stringify(await harness.test.db.event.findMany({ where: { taskId: target.taskId } }))).not.toContain(made.token);
    await visitor(address()).previews.link.open({ token: made.token });
    expect(JSON.stringify(harness.logs)).not.toContain(made.token);
  });

  it("F-142/c6: a link's first use is audited once, however often it's used", async () => {
    const target = await task();
    const made = await linkTo(target);
    const firstUses = () => harness.test.db.auditEntry.count({ where: { entityId: target.taskId, action: "preview.link_first_used" } });
    expect(await firstUses()).toBe(0);
    const page = await visitor(address()).previews.link.open({ token: made.token });
    if (page.state !== "live") {
      throw new Error(`the link opened ${page.state}`);
    }
    expect(await visitor(address()).previews.link.heartbeat({ token: made.token, viewId: page.viewId })).toEqual({ state: "opening" });
    await visitor(address()).previews.link.open({ token: made.token });
    await visitor(address()).previews.link.open({ token: made.token });
    expect(await firstUses()).toBe(1);
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { entityId: target.taskId, action: "preview.link_first_used" } });
    expect(entry).toMatchObject({ actorKind: "system", projectId });
    const row = await harness.test.db.previewLink.findUniqueOrThrow({ where: { id: made.linkId } });
    expect(row.firstUsedAt).not.toBeNull();
    expect(row.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(row.firstUsedAt?.getTime() ?? 0);
    // The share menu sees its use and its opens.
    const link = (await (await harness.as(driver)).previews.list({ taskId: target.taskId })).previews[0]?.sharing.links[0];
    expect(link).toMatchObject({ linkId: made.linkId, opens: 3, firstUsedAt: row.firstUsedAt?.getTime() });
  });

  it("F-142/c7: the viewer page's data holds the preview's label and port, the organization's name, the expiry and the mode, and nothing else of the task", async () => {
    const target = await task();
    const taskRow = await harness.test.db.task.findUniqueOrThrow({ where: { id: target.taskId } });
    const project = await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const repo = await harness.test.db.repo.findFirstOrThrow({ where: { projectId } });
    const runner = await harness.test.db.runner.findUniqueOrThrow({ where: { id: target.runnerId } });
    const driverAccount = await harness.test.db.user.findUniqueOrThrow({ where: { id: driver.userId } });
    const made = await linkTo(target);
    const page = await visitor(address()).previews.link.open({ token: made.token });
    expect(page.state).toBe("live");
    expect(Object.keys(page).sort()).toEqual(["expiresAt", "input", "label", "organizationName", "port", "state", "viewId"]);
    expect(page).toMatchObject({ label: "Web", port: 5173, organizationName: harness.fixture.a.organization.name, expiresAt: made.expiresAt, input: false });
    await (await harness.as(driver)).previews.revokeLink({ linkId: made.linkId });
    const ended = await visitor(address()).previews.link.open({ token: made.token });
    expect(Object.keys(ended).sort()).toEqual(["at", "label", "organizationName", "port", "state"]);
    for (const shown of [page, ended]) {
      const text = JSON.stringify(shown);
      for (const secret of [
        target.taskId,
        target.sessionId,
        target.boxId,
        target.runnerId,
        runner.name,
        projectId,
        project.name,
        project.slug,
        repo.fullName,
        taskRow.title,
        taskRow.prompt,
        taskRow.branchName,
        driver.id,
        driverAccount.name,
        driverAccount.email,
        made.linkId,
        made.token,
      ].filter((value): value is string => value !== null)) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

// ---------- the stream and input routes ----------

describe("the stream and input routes (F-141)", () => {
  it("F-141/c7: the stream and input routes relay a member's view to core with a token for that view, and refuse without a session or a link", async () => {
    const target = await task();
    const opened = await (await harness.as(driver)).previews.open({ taskId: target.taskId, key: target.key });
    if (!opened.ok) {
      throw new Error("not opened");
    }
    const viewId = opened.viewId;

    // The member's stream: core's records, relayed as they are.
    const stream = await servePreviewStream(await memberContext(driver), streamRequest(viewId), viewId);
    expect([stream.status, stream.headers.get("content-type"), stream.headers.get("cache-control")]).toEqual([200, "application/octet-stream", "no-store"]);
    const records = createPanelStreamReader().push(new Uint8Array(await stream.arrayBuffer()));
    expect(records.map((record) => (record.ok ? record.message.type : record.reason))).toEqual(["frame", "frame", "close"]);
    // Core was asked with the panel's token for this one view and this member.
    const asked = fakeCore.calls.filter((call) => call.viewId === viewId);
    expect(asked.map((call) => [call.route, call.claims.organizationId, call.claims.viewId, call.claims.viewer])).toEqual([["stream", organizationId, viewId, { kind: "member", memberId: driver.id }]]);
    expect(asked[0]?.claims.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);

    // The member's input: a batch, relayed in order.
    const input = await servePreviewInput(await memberContext(driver), inputRequest(viewId), viewId);
    expect(input.status).toBe(204);
    expect(fakeCore.calls.filter((call) => call.viewId === viewId && call.route === "input").map((call) => call.events)).toEqual([[click]]);

    // No session and no link: refused, and core never asked.
    const before = fakeCore.calls.length;
    for (const response of [
      await servePreviewStream(signedOutContext(), streamRequest(viewId), viewId),
      await servePreviewInput(signedOutContext(), inputRequest(viewId), viewId),
    ]) {
      expect([response.status, await errorCode(response)]).toEqual([401, "unauthorized"]);
    }
    // Another member, even one who can open the task, can't use someone else's view.
    const admins = await servePreviewStream(await memberContext(harness.fixture.a.admin), streamRequest(viewId), viewId);
    expect([admins.status, await errorCode(admins)]).toEqual([404, "not-found"]);
    // Input only as JSON from the panel's own origin.
    const form = await servePreviewInput(await memberContext(driver), inputRequest(viewId, { "content-type": "text/plain" }), viewId);
    const elsewhere = await servePreviewInput(await memberContext(driver), inputRequest(viewId, { origin: "https://evil.example" }), viewId);
    expect([form.status, elsewhere.status]).toEqual([403, 403]);
    const bad = await servePreviewInput(await memberContext(driver), inputRequest(viewId, {}, { events: [] }), viewId);
    expect([bad.status, await errorCode(bad)]).toEqual([400, "bad-request"]);
    expect(fakeCore.calls.length).toBe(before);
    // A core that answers nothing is a code too.
    const down = await servePreviewStream({ ...(await harness.contextOf(driver)), deps: { ...harness.deps, previews: { ...harness.deps.previews, coreUrl: "http://127.0.0.1:9" } } }, streamRequest(viewId), viewId);
    expect([down.status, await errorCode(down)]).toEqual([502, "core-unreachable"]);

    // A view that isn't, and one closed.
    const missing = previewViewIdSchema.parse(randomUUID());
    expect((await servePreviewStream(await memberContext(driver), streamRequest(missing), missing)).status).toBe(404);
    await (await harness.as(driver)).previews.close({ viewId });
    const closed = await servePreviewStream(await memberContext(driver), streamRequest(viewId), viewId);
    expect([closed.status, await errorCode(closed)]).toEqual([410, "view-closed"]);
  });

  it("F-141/c7: the viewer page's link token opens its own view's stream and input, watch-only unless the link allows input, and a wrong token is refused and limited", async () => {
    const target = await task();
    const watching = await linkTo(target);
    const using = await linkTo(target, { allowInput: true });
    const watchPage = await visitor(address()).previews.link.open({ token: watching.token });
    const usePage = await visitor(address()).previews.link.open({ token: using.token });
    if (watchPage.state !== "live" || usePage.state !== "live") {
      throw new Error("no views");
    }
    const withToken = (token: string): Record<string, string> => ({ [PREVIEW_LINK_HEADER]: token, "x-forwarded-for": address() });

    const stream = await servePreviewStream(signedOutContext(), streamRequest(watchPage.viewId, withToken(watching.token)), watchPage.viewId);
    expect(stream.status).toBe(200);
    await stream.arrayBuffer();
    expect(fakeCore.calls.find((call) => call.viewId === watchPage.viewId)?.claims.viewer).toEqual({ kind: "link", linkId: watching.linkId });

    // Watch-only: its input is dropped here, before core and the runner.
    const dropped = await servePreviewInput(signedOutContext(), inputRequest(watchPage.viewId, withToken(watching.token)), watchPage.viewId);
    expect([dropped.status, await errorCode(dropped)]).toEqual([403, "watch-only"]);
    expect(fakeCore.calls.filter((call) => call.viewId === watchPage.viewId && call.route === "input")).toEqual([]);
    // A link that allows input: relayed.
    expect((await servePreviewInput(signedOutContext(), inputRequest(usePage.viewId, withToken(using.token)), usePage.viewId)).status).toBe(204);
    expect(fakeCore.calls.filter((call) => call.viewId === usePage.viewId && call.route === "input").map((call) => call.events)).toEqual([[click]]);
    // One link's token never opens another link's view.
    const crossed = await servePreviewStream(signedOutContext(), streamRequest(usePage.viewId, withToken(watching.token)), usePage.viewId);
    expect([crossed.status, await errorCode(crossed)]).toEqual([404, "not-found"]);

    // A token that opens nothing: refused like no credential at all, and an address that keeps
    // trying is turned away for the rest of the minute, with the right token too.
    const from = address();
    const wrong = { [PREVIEW_LINK_HEADER]: `ostra-preview-${"B".repeat(43)}`, "x-forwarded-for": from };
    for (let tries = 0; tries < PREVIEW_LINK_MISSES_PER_MINUTE; tries += 1) {
      const response = await servePreviewStream(signedOutContext(), streamRequest(usePage.viewId, wrong), usePage.viewId);
      expect([response.status, await errorCode(response)]).toEqual([401, "unauthorized"]);
    }
    const limited = await servePreviewStream(signedOutContext(), streamRequest(usePage.viewId, { ...wrong, [PREVIEW_LINK_HEADER]: using.token }), usePage.viewId);
    expect([limited.status, await errorCode(limited)]).toEqual([429, "too-many-tries"]);
    expect(await trpcFailure(visitor(from).previews.link.open({ token: using.token }))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Another address isn't held back by it.
    expect((await visitor(address()).previews.link.open({ token: using.token })).state).toBe("live");
  });
});
