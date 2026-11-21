import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { silentLogger } from "@ostra/adapter-sdk";
import {
  closeRefusedViewsInTx,
  createPanelPreviewTokens,
  createPanelStartAppTokens,
  loadPreviewShareNotice,
  markViewConnected,
  PANEL_START_APP_PATH,
  parsePanelPreviewPath,
  postgresChangeNotices,
  systemClock,
} from "@ostra/domain";
import type { PanelPreviewClaims, PanelStartAppClaims } from "@ostra/domain";
import { createPanelStreamReader, encodePanelStreamRecord, panelPreviewInputBodySchema, previewAccessIdSchema, previewKeySchema, previewViewIdSchema } from "@ostra/protocol";
import type { OrganizationId, PanelPreviewInputBody, PreviewInputEvent, PreviewViewId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { coreAppStarter } from "../services/core-app-start.ts";
import { PREVIEW_LINK_HEADER, PREVIEW_LINK_MISSES_PER_MINUTE } from "../services/preview-link-tries.ts";
import { servePreviewInput, servePreviewStream } from "../services/preview-relay.ts";
import { createApiHarness, PREVIEW_SECRET, seedConnectionAndModel, seedPreviewableTask, seedProject, seedTask, trpcFailure } from "../testing/index.ts";
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

type CoreCall = { readonly route: "stream" | "input"; readonly viewId: PreviewViewId; readonly claims: PanelPreviewClaims; readonly input?: PanelPreviewInputBody };
type FakeCore = { readonly url: string; readonly calls: CoreCall[]; readonly starts: PanelStartAppClaims[]; readonly refused: string[]; readonly close: () => Promise<void> };

const jpeg = (fill: number): Uint8Array => {
  const bytes = new Uint8Array(32).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

/**
 * Core's panel routes, as `apps/core/src/previews/` answers them: a view's stream and input with the
 * panel's token for the view, and "Start the app" with its token for the member and the task, whose
 * body (`startAppForMember`) the harness runs; else 401.
 */
const startFakeCore = async (): Promise<FakeCore> => {
  const tokens = createPanelPreviewTokens(PREVIEW_SECRET);
  const startTokens = createPanelStartAppTokens(PREVIEW_SECRET);
  const calls: CoreCall[] = [];
  const starts: PanelStartAppClaims[] = [];
  const refused: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://core.internal");
    const route = parsePanelPreviewPath(url.pathname);
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (url.pathname === PANEL_START_APP_PATH && request.method === "POST") {
      const start = startTokens.verify(bearer, Date.now());
      if (start === null) {
        refused.push(url.pathname);
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "unauthorized", message: "a valid panel token is required" } }));
        return;
      }
      starts.push(start);
      void harness.deps.appStart(start).then((answer) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      });
      return;
    }
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
      calls.push({ route: "input", viewId: route.viewId, claims, input: body });
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
    starts,
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

  it("F-141/c5: \"Start the app\" asks core with a token for the member and the task, and keeps core's refusals", async () => {
    // The panel as an install builds it: core at the fake's address, under the shared key.
    const toCore = (secret: string = PREVIEW_SECRET, coreUrl: string = fakeCore.url): ApiDeps => ({ ...harness.deps, appStart: coreAppStarter({ coreUrl, secret, logger: silentLogger }) });
    const as = async (member: SeededMember, deps: ApiDeps = toCore()): Promise<AppCaller> => harness.callerFor({ ...(await harness.contextOf(member)), deps });
    const asDriver = await as(driver);
    const target = await task();
    const before = fakeCore.starts.length;
    harness.fakes.outbox.clear();
    expect(await asDriver.previews.startApp({ taskId: target.taskId })).toEqual({ ok: true, state: "running" });
    expect(fakeCore.starts.slice(before).map((start) => [start.organizationId, start.memberId, start.taskId])).toEqual([[organizationId, driver.id, target.taskId]]);
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId: target.runnerId, kind: "app.start" }]);

    // Core's refusals come back as the pane's codes: a runner below minor 7, and no runner to take a box.
    const old = await seedPreviewableTask(harness, { organizationId, projectId, ownerMemberId: harness.fixture.a.admin.id, driverMemberId: driver.id, minor: 6 });
    expect(await asDriver.previews.startApp({ taskId: old.taskId })).toEqual({ ok: false, reason: "runner-needs-upgrade" });
    const stopped = await seedTask(harness, { organizationId, projectId, title: "A stopped task", state: "stopped", sessionState: "ended", driverMemberId: driver.id });
    expect(await asDriver.previews.startApp({ taskId: stopped.taskId })).toEqual({ ok: false, reason: "no-runner" });
    expect(await harness.test.db.lease.count({ where: { taskId: stopped.taskId } })).toBe(0);
    expect(await harness.test.db.session.count({ where: { taskId: stopped.taskId } })).toBe(1);
    expect(fakeCore.starts.slice(before).map((start) => start.taskId)).toEqual([target.taskId, old.taskId, stopped.taskId]);

    // Someone who can't open the task never reaches core.
    expect(await trpcFailure((await as(outsider)).previews.startApp({ taskId: target.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(fakeCore.starts.length).toBe(before + 3);
    // A core out of reach, or one that refuses the panel's token (another key): nothing started, and the pane says so.
    expect(await (await as(driver, toCore(PREVIEW_SECRET, "http://127.0.0.1:9"))).previews.startApp({ taskId: target.taskId })).toEqual({ ok: false, reason: "core-unreachable" });
    const refusedBefore = fakeCore.refused.length;
    expect(await (await as(driver, toCore(randomUUID()))).previews.startApp({ taskId: target.taskId })).toEqual({ ok: false, reason: "core-unreachable" });
    expect(fakeCore.refused.slice(refusedBefore)).toEqual([PANEL_START_APP_PATH]);
    expect(fakeCore.starts.length).toBe(before + 3);
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

  it("F-142/c3: a person newly named is told, in the panel and by mail, with the preview's own page; a name taken off tells no one", async () => {
    const target = await task();
    const asDriver = await harness.as(driver);
    const person = await seedMember();
    const named2 = await seedMember();
    const noticesOf = (member: SeededMember) =>
      harness.test.db.notification.findMany({
        where: { memberId: member.id, kind: "preview_shared", taskId: target.taskId },
        orderBy: { createdAt: "asc" },
        select: { id: true, createdAt: true, deliveries: { orderBy: { channel: "asc" }, select: { id: true, channel: true, idempotencyKey: true, dueAt: true } } },
      });
    const level = (memberIds: readonly SeededMember[], to: "named" | "members" = "named") =>
      asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: to, memberIds: memberIds.map((member) => member.id) });
    const sharer = await harness.test.db.member.findUniqueOrThrow({ where: { id: driver.id }, select: { user: { select: { name: true } } } });

    // Named: one notice each, on the panel at once and by mail after the delay; the member who named
    // themselves is told nothing.
    harness.fakes.jobs.clear();
    const before = Date.now();
    await level([person, driver]);
    const told = await noticesOf(person);
    expect(told).toHaveLength(1);
    expect(told[0]?.deliveries.map((delivery) => delivery.channel).sort()).toEqual(["email", "panel"]);
    const panel = told[0]?.deliveries.find((delivery) => delivery.channel === "panel");
    const mail = told[0]?.deliveries.find((delivery) => delivery.channel === "email");
    expect(panel?.dueAt.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThan(before + 60_000);
    expect(mail?.dueAt.getTime() ?? 0).toBeGreaterThanOrEqual(before + 60_000);
    expect(await noticesOf(driver)).toEqual([]);
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "notify.deliver").map((job) => JSON.stringify(job.payload)).sort()).toEqual(
      [panel?.id, mail?.id].map((deliveryId) => JSON.stringify({ organizationId, deliveryId })).sort(),
    );

    // The notice opens the preview's own page, and says what it is and who shared it: nothing of the task.
    const access = await harness.test.db.previewAccess.findUniqueOrThrow({ where: { taskId_key: { taskId: target.taskId, key: target.key } }, select: { id: true } });
    const notice = await loadPreviewShareNotice(harness.test.db, { organizationId, memberId: person.id, key: panel?.idempotencyKey ?? "", publicUrl: "https://ostra.example/" });
    expect(notice).toEqual({ label: "Web", port: 5173, sharedBy: sharer.user.name, organizationName: harness.fixture.a.organization.name, url: `https://ostra.example/previews/${access.id}` });
    const shares = await (await harness.as(person)).notifications.previewShares();
    expect(shares).toEqual([{ notificationId: told[0]?.id, previewId: access.id, label: "Web", port: 5173, sharedBy: sharer.user.name, read: false, createdAt: told[0]?.createdAt.getTime() }]);

    // The same people named again tell no one twice; a person added is told alone.
    harness.fakes.jobs.clear();
    await level([person, named2]);
    expect(await noticesOf(person)).toHaveLength(1);
    expect(await noticesOf(named2)).toHaveLength(1);
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "notify.deliver")).toHaveLength(2);

    // A name taken off tells no one; its notice says nothing once it's due, nor on Needs you.
    harness.fakes.jobs.clear();
    const all = () => harness.test.db.notification.count({ where: { kind: "preview_shared", taskId: target.taskId } });
    const madeSoFar = await all();
    await level([named2]);
    expect(await all()).toBe(madeSoFar);
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "notify.deliver")).toEqual([]);
    expect(await loadPreviewShareNotice(harness.test.db, { organizationId, memberId: person.id, key: mail?.idempotencyKey ?? "", publicUrl: "https://ostra.example/" })).toBeNull();
    expect(await (await harness.as(person)).notifications.previewShares()).toEqual([]);
    // Back to the project's members: the last person named is told nothing either, and their row goes.
    await level([], "members");
    expect(await all()).toBe(madeSoFar);
    expect(await (await harness.as(named2)).notifications.previewShares()).toEqual([]);

    // Named again later: a new naming, told anew.
    await level([person]);
    expect(await noticesOf(person)).toHaveLength(2);
    expect(await (await harness.as(person)).notifications.previewShares()).toMatchObject([{ previewId: access.id, read: false }]);
  });

  it("F-142/c3: the preview's own page opens for a person it names, watch-only, and for a member who can open the task; a stranger, a name taken off and a narrowed level each get the same not-shared", async () => {
    const target = await task();
    const asDriver = await harness.as(driver);
    await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id] });
    const previewId = previewAccessIdSchema.parse((await harness.test.db.previewAccess.findUniqueOrThrow({ where: { taskId_key: { taskId: target.taskId, key: target.key } }, select: { id: true } })).id);
    const pageAs = async (member: SeededMember, id = previewId): Promise<string> => {
      const page = await (await harness.as(member)).previews.shared.open({ previewId: id });
      return page.state === "live" ? (page.input ? "live, input" : "live, watch-only") : page.state;
    };

    expect(await pageAs(named)).toBe("live, watch-only");
    expect(await pageAs(driver)).toBe("live, input");
    expect(await pageAs(outsider)).toBe("not-shared");
    expect(await pageAs(harness.fixture.b.admin)).toBe("not-shared");
    expect(await pageAs(named, previewAccessIdSchema.parse(randomUUID()))).toBe("not-shared");
    // Signed out, there's no page at all.
    expect(await trpcFailure(visitor(address()).previews.shared.open({ previewId }))).toMatchObject({ code: "UNAUTHORIZED" });

    // The page holds the preview's label and port and the organization's name, and nothing else of the task.
    const asNamed = await harness.as(named);
    const page = await asNamed.previews.shared.open({ previewId });
    if (page.state !== "live") {
      throw new Error(`not live: ${page.state}`);
    }
    expect(Object.keys(page).sort()).toEqual(["expiresAt", "input", "label", "organizationName", "port", "state", "viewId"]);
    expect(page).toMatchObject({ label: "Web", port: 5173, organizationName: harness.fixture.a.organization.name, expiresAt: null, input: false });
    // Its view is the person's own, kept by the pane's heartbeat, and its input stops at the panel.
    expect(await asNamed.previews.heartbeat({ viewId: page.viewId })).toEqual({ state: "opening" });
    const input = await servePreviewInput(await memberContext(named), inputRequest(page.viewId), page.viewId);
    expect([input.status, await errorCode(input)]).toEqual([403, "watch-only"]);

    // Their name taken off: the open view ends, its heartbeat and the stream say so, and the page is not-shared.
    await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [outsider.id] });
    expect(await asNamed.previews.heartbeat({ viewId: page.viewId })).toEqual({ state: "closed" });
    const stream = await servePreviewStream(await memberContext(named), streamRequest(page.viewId), page.viewId);
    expect([stream.status, await errorCode(stream)]).toEqual([410, "view-closed"]);
    expect(await pageAs(named)).toBe("not-shared");
    expect(await pageAs(outsider)).toBe("live, watch-only");

    // The level narrowed to the project's members: the page shuts for the person it named, not for the project.
    await asDriver.previews.setLevel({ taskId: target.taskId, key: target.key, level: "members", memberIds: [] });
    expect(await pageAs(outsider)).toBe("not-shared");
    expect(await pageAs(driver)).toBe("live, input");
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
    expect(fakeCore.calls.filter((call) => call.viewId === viewId && call.route === "input").map((call) => call.input)).toEqual([{ events: [click] }]);

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

  it("F-142/c1: the pane's width preset, path and reload are relayed to core for a viewer who may give input, and a watch-only viewer's stop here, before core", async () => {
    const target = await task();
    const opened = await (await harness.as(driver)).previews.open({ taskId: target.taskId, key: target.key });
    if (!opened.ok) {
      throw new Error("not opened");
    }
    const controls: PanelPreviewInputBody[] = [{ control: { kind: "viewport", viewport: { width: 390, height: 844 } } }, { control: { kind: "navigate", path: "/history" } }, { control: { kind: "reload" } }];
    for (const body of controls) {
      expect((await servePreviewInput(await memberContext(driver), inputRequest(opened.viewId, {}, body), opened.viewId)).status).toBe(204);
    }
    expect(fakeCore.calls.filter((call) => call.viewId === opened.viewId && call.route === "input").map((call) => call.input)).toEqual(controls);
    // A control that isn't one of the three, or a path to another host: refused here.
    for (const body of [{ control: { kind: "print" } }, { control: { kind: "navigate", path: "https://evil.example/" } }]) {
      const bad = await servePreviewInput(await memberContext(driver), inputRequest(opened.viewId, {}, body), opened.viewId);
      expect([bad.status, await errorCode(bad)]).toEqual([400, "bad-request"]);
    }
    // From another origin, refused like input.
    const elsewhere = await servePreviewInput(await memberContext(driver), inputRequest(opened.viewId, { origin: "https://evil.example" }, { control: { kind: "reload" } }), opened.viewId);
    expect(elsewhere.status).toBe(403);
    // A watch-only link: each control stops here, and core is never asked.
    const watching = await linkTo(target);
    const page = await visitor(address()).previews.link.open({ token: watching.token });
    if (page.state !== "live") {
      throw new Error("no view");
    }
    for (const body of controls) {
      const dropped = await servePreviewInput(signedOutContext(), inputRequest(page.viewId, { [PREVIEW_LINK_HEADER]: watching.token, "x-forwarded-for": address() }, body), page.viewId);
      expect([dropped.status, await errorCode(dropped)]).toEqual([403, "watch-only"]);
    }
    expect(fakeCore.calls.filter((call) => call.viewId === page.viewId && call.route === "input")).toEqual([]);
  });

  it("F-141/c7: the stream of a view its box refused is one close record with the box's reason, and core isn't asked", async () => {
    const target = await task();
    const opened = await (await harness.as(driver)).previews.open({ taskId: target.taskId, key: target.key });
    if (!opened.ok) {
      throw new Error("not opened");
    }
    // The box refused the view's `preview.open`: core closes it with the reason, as its gateway's hook does.
    const sent = harness.fakes.outbox.commands.find((command) => command.kind === "preview.open" && Reflect.get(command.body, "viewId") === opened.viewId);
    if (sent === undefined) {
      throw new Error("no preview.open");
    }
    const closed = await harness.test.db.$transaction((tx) =>
      closeRefusedViewsInTx({ outbox: harness.fakes.outbox, notices: postgresChangeNotices, clock: systemClock }, tx, organizationId, [{ kind: "preview.open", body: sent.body, result: "rejected", reason: "not-a-preview" }]),
    );
    // No `preview.close` for a box that never held the view.
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "preview.close" && Reflect.get(command.body, "viewId") === opened.viewId)).toEqual([]);
    expect(closed).toEqual([{ viewId: opened.viewId, refusal: "not-a-preview" }]);
    const before = fakeCore.calls.length;
    const stream = await servePreviewStream(await memberContext(driver), streamRequest(opened.viewId), opened.viewId);
    expect([stream.status, stream.headers.get("content-type"), stream.headers.get("cache-control")]).toEqual([200, "application/octet-stream", "no-store"]);
    const records = createPanelStreamReader().push(new Uint8Array(await stream.arrayBuffer()));
    expect(records).toEqual([{ ok: true, message: { type: "close", close: { reason: "refused", refusal: "not-a-preview" } } }]);
    // Its input is a closed view's; nobody else's view says anything; core was never asked.
    const input = await servePreviewInput(await memberContext(driver), inputRequest(opened.viewId), opened.viewId);
    expect([input.status, await errorCode(input)]).toEqual([410, "view-closed"]);
    const admins = await servePreviewStream(await memberContext(harness.fixture.a.admin), streamRequest(opened.viewId), opened.viewId);
    expect([admins.status, await errorCode(admins)]).toEqual([404, "not-found"]);
    expect(fakeCore.calls.length).toBe(before);
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
    expect(fakeCore.calls.filter((call) => call.viewId === usePage.viewId && call.route === "input").map((call) => call.input)).toEqual([{ events: [click] }]);
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
