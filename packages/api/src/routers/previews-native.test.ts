import { createHash, randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { previewCheckMark, recordPreviewFraming } from "@ostra/domain";
import type { PreviewDomainProbe } from "@ostra/domain";
import { previewViewIdSchema } from "@ostra/protocol";
import type { OrganizationId, PreviewLinkId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, PREVIEW_SECRET, seedConnectionAndModel, seedPreviewableTask, seedProject, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller, PreviewableTask } from "../testing/index.ts";
import type { ApiDeps } from "../trpc/context.ts";

// Milestone 8, ticket 26 (F-144, F-142, ADR 0068): the native preview's procedures and the instance's
// settings page, on real Postgres. `previews.enter` and `previews.link.enter` mint the handshake's
// one-time code (ticket 25's `enterNativePreview`) for a member who can open the task and a link that
// allows input, and for nobody who may only watch; the pane's list says whether the domain's last
// check passed and which framing header core replaced; `instance.previewDomainCheck` keeps its result
// for Instance › Previews, which also names the DNS record and the certificate to add. The probe is a
// fake: no name under a real domain is resolved here.

let harness: ApiHarness;
let organizationId: OrganizationId;
let projectId: ProjectId;
/** The project's member: drives the tasks. */
let driver: SeededMember;
/** An organization member the restricted project doesn't list, whom a preview names. */
let named: SeededMember;

let unique = 0;
const label = (prefix: string): string => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

/** The harness's deps with `OSTRA_PREVIEW_DOMAIN` (and the panel's and core's addresses) set. */
const withDomain = (domain: string | null, over: { readonly publicUrl?: string; readonly corePublicUrl?: string; readonly probe?: PreviewDomainProbe } = {}): ApiDeps => ({
  ...harness.deps,
  settings: {
    ...harness.deps.settings,
    publicUrl: over.publicUrl ?? harness.deps.settings.publicUrl,
    corePublicUrl: over.corePublicUrl ?? harness.deps.settings.corePublicUrl,
    previews: { ...harness.deps.settings.previews, domain },
  },
  previews: { ...harness.deps.previews, ...(over.probe === undefined ? {} : { domainProbe: over.probe }) },
});

const asMember = async (member: SeededMember, deps: ApiDeps): Promise<AppCaller> => harness.callerFor({ ...(await harness.contextOf(member)), deps });

/** A signed-out visitor from an address of its own, as the viewer page calls its procedures. */
const visitor = (deps: ApiDeps): AppCaller =>
  harness.callerFor({ deps, headers: new Headers({ "x-forwarded-for": `198.51.100.${String((unique += 1) % 250)}` }), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });

const seedMember = async (): Promise<SeededMember> => {
  const name = label("person");
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name}@example.com`, username: name } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } }));
};

const task = (): Promise<PreviewableTask> => seedPreviewableTask(harness, { organizationId, projectId, ownerMemberId: harness.fixture.a.admin.id, driverMemberId: driver.id });

/** A link to the task's primary preview, made by the driver: its token from its URL. */
const linkTo = async (target: PreviewableTask, allowInput: boolean): Promise<{ readonly linkId: PreviewLinkId; readonly token: string }> => {
  const made = await (await harness.as(driver)).previews.createLink({ taskId: target.taskId, key: target.key, kind: "expiring", allowInput, expiresInHours: null });
  if (!made.ok) {
    throw new Error(`no link: ${made.reason}`);
  }
  return { linkId: made.linkId, token: made.url.split("/p/")[1] ?? "" };
};

/** The task's one-time codes for the native preview, as stored. */
const codesOf = (target: PreviewableTask) =>
  harness.test.db.previewCode.findMany({ where: { taskId: target.taskId, kind: "enter" }, select: { codeHash: true, memberId: true, linkId: true, authSessionId: true, port: true } });

/** A probe where every name under the domain and core's host resolve, and core's proxy answers with its mark. */
const workingProbe: PreviewDomainProbe = {
  resolve: () => Promise.resolve(["127.0.0.1"]),
  fetch: (url) => Promise.resolve({ ok: true, status: 200, mark: previewCheckMark(PREVIEW_SECRET, url.hostname), certificate: null }),
  upgrade: () => Promise.resolve({ ok: true, status: 101 }),
};

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  organizationId = harness.fixture.a.organization.id;
  ({ projectId } = await seedProject(harness, world, label("native")));
  // The organization's admin is the install's instance admin, as on a one-organization install.
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
  const admin = await harness.as(harness.fixture.a.admin);
  await admin.projects.setAccess({ projectId, access: "restricted" });
  driver = await seedMember();
  named = await seedMember();
  await admin.projects.setMember({ projectId, memberId: driver.id, role: "member" });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

/** Runs the instance admin's check on `deps` and keeps its result, as the settings page does. */
const runCheck = async (deps: ApiDeps) => (await asMember(harness.fixture.a.admin, deps)).instance.previewDomainCheck();

describe("previews.enter (ticket 26)", () => {
  it("F-144/c1, c3: a member who can open the task gets a one-time code for the preview's own host, bound to their panel login session and kept only as its hash", async () => {
    const target = await task();
    const deps = withDomain("preview.localhost", { corePublicUrl: "http://127.0.0.1:3102" });
    const entered = await (await asMember(driver, deps)).previews.enter({ taskId: target.taskId, key: target.key, path: "/history" });
    if (!entered.ok) {
      throw new Error(`refused: ${entered.reason}`);
    }
    // `<port>-<previewId>.<domain>` on core's public scheme and port, its handshake path and the path.
    expect(entered.origin).toMatch(/^http:\/\/5173-[a-z2-7]{26}\.preview\.localhost:3102$/);
    expect(entered.host).toBe(new URL(entered.origin).host);
    const url = new URL(entered.url);
    expect(`${url.protocol}//${url.host}`).toBe(entered.origin);
    expect(url.pathname).toBe("/.ostra/enter");
    expect(url.searchParams.get("path")).toBe("/history");
    const code = url.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(20);
    expect(entered.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    const rows = await codesOf(target);
    expect(rows).toEqual([{ codeHash: createHash("sha256").update(code).digest("hex"), memberId: driver.id, linkId: null, authSessionId: `session-of-${driver.id}`, port: 5173 }]);
    // "Open in a new tab" makes its own handshake: a second call, a second code.
    const again = await (await asMember(driver, deps)).previews.enter({ taskId: target.taskId, key: target.key });
    expect(again.ok && again.url !== entered.url).toBe(true);
    expect(await codesOf(target)).toHaveLength(2);
  });

  it("F-144/c2: with no preview domain there's no code, and the pane keeps the browser view", async () => {
    const target = await task();
    const deps = withDomain(null);
    expect(await (await asMember(driver, deps)).previews.enter({ taskId: target.taskId, key: target.key })).toEqual({ ok: false, reason: "no-preview-domain" });
    expect(await codesOf(target)).toHaveLength(0);
    expect((await (await asMember(driver, deps)).previews.list({ taskId: target.taskId })).native).toBe("not-set");
  });

  it("F-142/c1: a person the preview names may only watch, so gets no code; someone outside the project gets NOT_FOUND", async () => {
    const target = await task();
    const deps = withDomain("preview.localhost");
    await (await harness.as(driver)).previews.setLevel({ taskId: target.taskId, key: target.key, level: "named", memberIds: [named.id] });
    expect(await (await asMember(named, deps)).previews.enter({ taskId: target.taskId, key: target.key })).toEqual({ ok: false, reason: "watch-only" });
    const stranger = await seedMember();
    expect(await trpcFailure((await asMember(stranger, deps)).previews.enter({ taskId: target.taskId, key: target.key }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await codesOf(target)).toHaveLength(0);
  });

  it("F-144/c9: a runner on the HTTP carrier gets no code, with the reason", async () => {
    const target = await task();
    await harness.test.db.runner.update({ where: { id: target.runnerId }, data: { preview: { stream: true, tunnel: false } } });
    const deps = withDomain("preview.localhost");
    expect(await (await asMember(driver, deps)).previews.enter({ taskId: target.taskId, key: target.key })).toEqual({ ok: false, reason: "runner-cannot-tunnel" });
  });
});

describe("a link and the native preview (ticket 26)", () => {
  it("F-142/c1: a watch-only link gets no code, from the viewer page's open or its enter, and a link that allows input does", async () => {
    const target = await task();
    const watching = await linkTo(target, false);
    const using = await linkTo(target, true);
    await runCheck(withDomain("preview.localhost", { probe: workingProbe }));
    const deps = withDomain("preview.localhost");
    // Watch-only: the viewer page streams the box's browser, and no code is ever minted for it.
    expect(await visitor(deps).previews.link.enter({ token: watching.token })).toEqual({ ok: false, reason: "watch-only" });
    expect(await visitor(deps).previews.link.open({ token: watching.token })).toMatchObject({ state: "live", input: false });
    expect((await codesOf(target)).filter((row) => row.linkId === watching.linkId)).toHaveLength(0);
    // With input: the viewer page frames the preview host, through a code bound to the link.
    const page = await visitor(deps).previews.link.open({ token: using.token });
    expect(page).toMatchObject({ state: "native", input: true, label: "Web", port: 5173 });
    expect(page.state === "native" && new URL(page.url).pathname).toBe("/.ostra/enter");
    const entered = await visitor(deps).previews.link.enter({ token: using.token });
    expect(entered.ok).toBe(true);
    const rows = (await codesOf(target)).filter((row) => row.linkId === using.linkId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.memberId === null && row.authSessionId === null)).toBe(true);
  });

  it("F-142/c1: until the preview domain's check passes, a link that allows input gets the browser view on the viewer page", async () => {
    const target = await task();
    const using = await linkTo(target, true);
    // A domain this install never checked: the browser view, as with none.
    expect(await visitor(withDomain("never-checked.localhost")).previews.link.open({ token: using.token })).toMatchObject({ state: "live", input: true });
    expect(await visitor(withDomain(null)).previews.link.open({ token: using.token })).toMatchObject({ state: "live", input: true });
  });

  it("F-142/c4: a revoked link gets no code and says so, and its state reads revoked, as an unknown token reads unknown", async () => {
    const target = await task();
    const using = await linkTo(target, true);
    const deps = withDomain("preview.localhost");
    expect(await visitor(deps).previews.link.state({ token: using.token })).toEqual({ state: "active" });
    await (await harness.as(driver)).previews.revokeLink({ linkId: using.linkId });
    expect(await visitor(deps).previews.link.enter({ token: using.token })).toEqual({ ok: false, reason: "link-revoked" });
    expect(await visitor(deps).previews.link.state({ token: using.token })).toEqual({ state: "revoked" });
    expect(await visitor(deps).previews.link.state({ token: "not-a-token-anyone-made" })).toEqual({ state: "unknown" });
    expect(await visitor(deps).previews.link.enter({ token: "not-a-token-anyone-made" })).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("the pane's list (ticket 26)", () => {
  it("F-144/c1: says whether the native preview is on, by the domain's last check, and each preview's replaced framing header", async () => {
    const target = await task();
    const list = async (deps: ApiDeps) => (await asMember(driver, deps)).previews.list({ taskId: target.taskId });
    expect((await list(withDomain("unchecked.localhost"))).native).toBe("unchecked");
    await runCheck(withDomain("preview.localhost", { probe: workingProbe }));
    const listed = await list(withDomain("preview.localhost"));
    expect(listed.native).toBe("passed");
    expect(listed.previews.find((item) => item.key === target.key)?.framing).toBeNull();
    // Core's proxy replaced the app's `X-Frame-Options` on a native view: the pane's notice names it once.
    const view = await harness.test.db.previewView.create({
      data: { organizationId, projectId, taskId: target.taskId, key: target.key, mode: "native", openedByMemberId: driver.id, leaseEpoch: 1, state: "open" },
      select: { id: true },
    });
    const viewId = previewViewIdSchema.parse(view.id);
    await recordPreviewFraming(harness.test.db, viewId, { header: "x-frame-options", value: "DENY" });
    await recordPreviewFraming(harness.test.db, viewId, { header: "frame-ancestors", value: "frame-ancestors 'none'" });
    expect((await list(withDomain("preview.localhost"))).previews.find((item) => item.key === target.key)?.framing).toEqual({ header: "x-frame-options", value: "DENY" });
  });
});

describe("Instance › Previews (ticket 26)", () => {
  it("F-144/c8: names the record and the certificate to add, warns on the panel's own site, and keeps the check's result, with a missing record, for the instance admin", async () => {
    const admin = (deps: ApiDeps) => asMember(harness.fixture.a.admin, deps);
    // Unset: nothing to add, and nothing checked.
    const unset = await (await admin(withDomain(null))).instance.previews();
    expect(unset).toMatchObject({ domain: null, record: null, sharedSite: null, sameSite: null, status: { state: "not-set" }, organization: { admin: true, publicPreviewLinks: false } });
    // A subdomain of the panel's site: a CNAME to core, a warning, and `Lax`.
    const acme = { publicUrl: "https://ostra.acme.dev", corePublicUrl: "https://core.acme.dev" };
    const set = await (await admin(withDomain("preview.acme.dev", acme))).instance.previews();
    expect(set).toMatchObject({
      domain: "preview.acme.dev",
      localhost: false,
      panelHost: "ostra.acme.dev",
      coreHost: "core.acme.dev",
      sharedSite: "acme.dev",
      sameSite: "lax",
      record: { name: "*.preview.acme.dev", type: "CNAME", value: "core.acme.dev" },
      status: { state: "unchecked", domain: "preview.acme.dev" },
    });
    // A domain of its own: no warning, a partitioned cookie; core on an IP address: an A record.
    const own = await (await admin(withDomain("acme-preview.dev", { publicUrl: "https://ostra.acme.dev", corePublicUrl: "https://203.0.113.24" }))).instance.previews();
    expect(own).toMatchObject({ sharedSite: null, sameSite: "none-partitioned", record: { name: "*.acme-preview.dev", type: "A", value: "203.0.113.24" } });
    // The check, where the record is missing: its result is kept, by whom, and audited without its text.
    const missing: PreviewDomainProbe = { ...workingProbe, resolve: () => Promise.resolve([]) };
    const checked = await (await admin(withDomain("preview.acme.dev", { ...acme, probe: missing }))).instance.previewDomainCheck();
    expect(checked).toMatchObject({ state: "checked", passed: false, dns: { state: "failed" }, certificate: { state: "skipped" } });
    expect(checked.state === "checked" && checked.dns.state === "failed" ? checked.dns.reason : "").toMatch(/\.preview\.acme\.dev doesn't resolve\.$/);
    const kept = await (await admin(withDomain("preview.acme.dev", acme))).instance.previews();
    const name = (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId }, select: { name: true } })).name;
    expect(kept.status).toMatchObject({ state: "checked", domain: "preview.acme.dev", passed: false, byName: name, check: { dns: { state: "failed" } } });
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { organizationId, action: "instance.preview_domain_checked" }, orderBy: { createdAt: "desc" }, select: { data: true, entityId: true } });
    expect(audit).toEqual({ data: { passed: false }, entityId: organizationId });
    // The domain changed: the old result is no result.
    expect((await (await admin(withDomain("acme-preview.dev", acme))).instance.previews()).status).toEqual({ state: "unchecked", domain: "acme-preview.dev" });
  });

  it("F-144/c8: is the instance admin's alone", async () => {
    const member = await asMember(driver, withDomain("preview.localhost"));
    expect(await trpcFailure(member.instance.previews())).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(member.instance.previewDomainCheck())).toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-144/c10: names a one-machine install's preview.localhost as the default, with nothing to add, and an admin's preview.localhost as the setting", async () => {
    const admin = (deps: ApiDeps) => asMember(harness.fixture.a.admin, deps);
    const local = { publicUrl: "http://localhost:3000", corePublicUrl: "http://localhost:8787" };
    const byDefault = withDomain("preview.localhost", local);
    const defaulted = await (await admin({ ...byDefault, settings: { ...byDefault.settings, previews: { ...byDefault.settings.previews, localDefault: true } } })).instance.previews();
    expect(defaulted).toMatchObject({ domain: "preview.localhost", defaulted: true, localhost: true, record: null });
    expect((await (await admin(withDomain("preview.localhost", local))).instance.previews()).defaulted).toBe(false);
    expect((await (await admin(withDomain(null))).instance.previews()).defaulted).toBe(false);
  });
});
