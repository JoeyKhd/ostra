import { createHash } from "node:crypto";

import { createFakeJira, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { FakeJira } from "@ostra/adapter-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JIRA_CONNECT_PERMISSIONS, jiraConnect, jiraSiteHost } from "./connect.ts";
import type { JiraConnectOptions, JiraTokenReadBack } from "./connect.ts";
import { JiraAdapter } from "./jira-adapter.ts";

// Connecting a Jira Cloud site (spec section 5.3, ticket 04; jira-connect.md): step 1's site
// lookup and step 2's read-back of the service account's token, against the fake Jira, as the
// API's connect steps call them (ticket 09) with `OSTRA_JIRA_API_URL` pointed at it, and as they
// call Jira's own hosts without it.

const ALL_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"];

type Sent = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** A fetch that records each request's URL and headers before it goes. */
const recording = (sent: Sent[], route: (url: URL) => URL = (url) => url): typeof fetch => {
  const recorded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    sent.push({ url: url.href, headers: Object.fromEntries(headers.entries()) });
    const to = route(url);
    if (to.host !== url.host) headers.set("x-forwarded-host", url.hostname);
    return fetch(to, { ...init, headers });
  };
  return recorded;
};

describe("connecting a Jira site", () => {
  let fake: FakeJira;
  let sent: Sent[];
  let options: JiraConnectOptions;

  beforeEach(async () => {
    fake = await createFakeJira({ siteName: "globex" });
    sent = [];
    options = { apiUrl: fake.gatewayUrl, fetch: recording(sent), timeoutMs: 5000 };
  });
  afterEach(async () => {
    await fake.close();
  });

  const tokenOf = (input: { readonly email?: string; readonly token?: string } = {}) => ({ cloudId: fake.cloudId, email: input.email ?? fake.serviceAccount.email, token: input.token ?? fake.token });
  const checked = (result: JiraTokenReadBack) => {
    if (result.kind !== "checked") throw new Error(`the read-back was ${result.kind}`);
    return result;
  };

  it("F-008/c1: findSite answers a Jira Cloud site's cloud ID, host and title, from its name, its host or a pasted URL, asking with no credential", async () => {
    const found = { kind: "found", cloudId: fake.cloudId, host: "globex.atlassian.net", title: "Globex" };
    for (const input of ["globex", "  Globex ", "globex.atlassian.net", "https://globex.atlassian.net/jira/software/projects/PROJ/boards/1"]) {
      expect(await jiraConnect.findSite(options, input), input).toEqual(found);
    }
    expect(sent.every((one) => one.url === `${fake.gatewayUrl}/_edge/tenant_info` && one.headers["authorization"] === undefined && one.headers["x-forwarded-host"] === "globex.atlassian.net")).toBe(true);
    // A two-word site's title, for the connection's default name.
    expect(jiraSiteHost("acme-corp")).toBe("acme-corp.atlassian.net");
    const acme = await createFakeJira({ siteName: "acme-corp" });
    try {
      expect(await jiraConnect.findSite({ ...options, apiUrl: acme.gatewayUrl }, "acme-corp")).toMatchObject({ kind: "found", cloudId: acme.cloudId, title: "Acme Corp" });
    } finally {
      await acme.close();
    }
  });

  it("F-008/c1: findSite answers not-found where no Jira Cloud site answers, data-center for a Data Center server, and unreachable when the site doesn't answer", async () => {
    expect(await jiraConnect.findSite(options, "globex-shop")).toEqual({ kind: "not-found", host: "globex-shop.atlassian.net" });
    expect(await jiraConnect.findSite(options, "not a site")).toEqual({ kind: "not-found", host: null });
    expect(await jiraConnect.findSite(options, "https://user:pass@globex.atlassian.net")).toEqual({ kind: "not-found", host: null });
    // The fake's Data Center server has no tenant info, and its server info says what it is.
    expect(await jiraConnect.findSite(options, `https://${fake.dataCenterHost}/secure/Dashboard.jspa`)).toEqual({ kind: "data-center", host: fake.dataCenterHost });
    expect(sent.slice(-2).map((one) => one.url)).toEqual([`${fake.gatewayUrl}/_edge/tenant_info`, `${fake.gatewayUrl}/rest/api/2/serverInfo`]);

    // Jira's own hosts: a site is asked at `https://<name>.atlassian.net` (routed to the fake here)...
    const own: Sent[] = [];
    const jiraOwn: JiraConnectOptions = { apiUrl: null, fetch: recording(own, (url) => new URL(`${url.pathname}${url.search}`, fake.siteUrl)), timeoutMs: 5000 };
    expect(await jiraConnect.findSite(jiraOwn, "globex")).toEqual({ kind: "found", cloudId: fake.cloudId, host: "globex.atlassian.net", title: "Globex" });
    expect(own.map((one) => one.url)).toEqual(["https://globex.atlassian.net/_edge/tenant_info"]);
    // ...and any other host is Data Center, asked nothing: ostra calls no host but Atlassian's.
    for (const input of [fake.dataCenterHost, "https://jira.acme.example:8443/browse/OPS-1", "10.0.0.7"]) {
      expect((await jiraConnect.findSite(jiraOwn, input)).kind, input).toBe("data-center");
    }
    expect(own).toHaveLength(1);

    const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    expect(await jiraConnect.findSite({ ...jiraOwn, fetch: down }, "globex")).toEqual({ kind: "unreachable", host: "globex.atlassian.net" });
    const failing: typeof fetch = () => Promise.resolve(new Response("upstream error", { status: 503 }));
    expect(await jiraConnect.findSite({ ...jiraOwn, fetch: failing }, "globex")).toEqual({ kind: "unreachable", host: "globex.atlassian.net" });
  });

  it("F-008/c1: checkToken reads back a service account's token: who it signs in as, the projects it sees, all five permissions in each, that it reads their workflows, and its scopes", async () => {
    const shop = fake.addProject("SHOP", "Globex storefront");
    const ops = fake.addProject("OPS", "Operations");
    const result = await jiraConnect.checkToken(options, tokenOf());
    const projects = [fake.project, shop, ops].map((project) => ({ id: project.id, key: project.key, name: project.name }));
    expect(result).toEqual({
      kind: "checked",
      account: { outcome: "ok", accountId: fake.serviceAccount.accountId, name: "ostra-bot", accountType: "app" },
      projects: { outcome: "ok", projects },
      permissions: { outcome: "ok", projects: projects.map((project) => ({ ...project, missing: [] })) },
      workflows: { outcome: "ok", readable: true, unreadable: [] },
      scopes: [
        { scope: "read:jira-work", state: "confirmed" },
        { scope: "write:jira-work", state: "unchecked" },
        { scope: "read:jira-user", state: "confirmed" },
        { scope: "read:workflow:jira", state: "confirmed" },
      ],
    });
    // Each project's five permissions, through the gateway, and nothing written.
    const routes = fake.calls().map((call) => call.route);
    expect(routes.filter((route) => route === "GET /rest/api/3/mypermissions")).toHaveLength(3);
    expect(fake.calls().filter((call) => call.route === "GET /rest/api/3/mypermissions").map((call) => new URLSearchParams(call.query).get("permissions"))).toEqual(Array(3).fill(JIRA_CONNECT_PERMISSIONS.join(",")));
    expect(routes.filter((route) => route === "GET /rest/api/3/workflows/search")).toHaveLength(3);
    expect(routes.every((route) => route.startsWith("GET "))).toBe(true);
    expect(fake.calls().every((call) => call.via === "gateway")).toBe(true);
  });

  it("F-008/c1: checkToken fails a person's account and a token that sees no project, warns of a short permission naming the project and of no workflow access, and answers a refused token's 401 or 403", async () => {
    const ops = fake.addProject("OPS", "Operations");

    // A person's token: red, a person's account.
    const person = fake.mintToken(fake.person.accountId, ALL_SCOPES);
    expect(checked(await jiraConnect.checkToken(options, tokenOf({ email: fake.person.email, token: person }))).account).toEqual({
      outcome: "fail",
      accountId: fake.person.accountId,
      name: "Alex Kim",
      accountType: "atlassian",
    });

    // A service account given no project.
    const lonely = fake.addAccount({ displayName: "ostra-lonely", email: "ostra-lonely@serviceaccount.atlassian.com", accountType: "app" });
    for (const project of [fake.project, ops]) fake.revokePermissions(lonely.accountId, project.id, ["BROWSE_PROJECTS"]);
    const none = checked(await jiraConnect.checkToken(options, tokenOf({ email: lonely.email, token: fake.mintToken(lonely.accountId, ALL_SCOPES) })));
    expect(none.account.outcome).toBe("ok");
    expect(none.projects).toEqual({ outcome: "fail", projects: [] });

    // Short of two permissions in OPS: a warning naming OPS and the two.
    fake.revokePermissions(fake.serviceAccount.accountId, ops.id, ["TRANSITION_ISSUES", "ADD_COMMENTS"]);
    const short = checked(await jiraConnect.checkToken(options, tokenOf()));
    expect(short.permissions).toEqual({
      outcome: "warn",
      projects: [
        { id: fake.project.id, key: fake.project.key, name: fake.project.name, missing: [] },
        { id: ops.id, key: "OPS", name: "Operations", missing: ["TRANSITION_ISSUES", "ADD_COMMENTS"] },
      ],
    });
    expect([short.account.outcome, short.projects.outcome, short.workflows.outcome]).toEqual(["ok", "ok", "ok"]);

    // Without `read:workflow:jira`: a warning, the scope refused, the rest as before.
    const narrow = fake.mintToken(fake.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    const blind = checked(await jiraConnect.checkToken(options, tokenOf({ token: narrow })));
    expect(blind.workflows).toEqual({ outcome: "warn", readable: false, unreadable: [fake.project, ops].map((project) => ({ id: project.id, key: project.key, name: project.name })) });
    expect(blind.scopes.find((one) => one.scope === "read:workflow:jira")?.state).toBe("refused");
    expect(blind.projects.outcome).toBe("ok");
    // With the scope, but shown none of one project's workflows: a warning naming that project.
    fake.revokePermissions(fake.serviceAccount.accountId, ops.id, ["VIEW_READONLY_WORKFLOW"]);
    const hidden = checked(await jiraConnect.checkToken(options, tokenOf()));
    expect(hidden.workflows).toEqual({ outcome: "warn", readable: false, unreadable: [{ id: ops.id, key: "OPS", name: "Operations" }] });
    expect(hidden.scopes.find((one) => one.scope === "read:workflow:jira")?.state).toBe("confirmed");

    // A token Jira refuses: its status, and nothing else.
    expect(await jiraConnect.checkToken(options, tokenOf({ token: "ATATTnot-a-token" }))).toEqual({ kind: "refused", status: 401 });
    const revoked = fake.mintToken(fake.serviceAccount.accountId, ALL_SCOPES);
    fake.refuseToken(revoked, 401);
    expect(await jiraConnect.checkToken(options, tokenOf({ token: revoked }))).toEqual({ kind: "refused", status: 401 });
    const noAccess = fake.mintToken(fake.serviceAccount.accountId, ALL_SCOPES);
    fake.refuseToken(noAccess, 403);
    expect(await jiraConnect.checkToken(options, tokenOf({ token: noAccess }))).toEqual({ kind: "refused", status: 403 });
    // Jira failing is not a refusal: the admin can check again.
    fake.injectFaults([{ kind: "unavailable" }]);
    expect(await jiraConnect.checkToken(options, tokenOf())).toEqual({ kind: "unreachable", status: 503 });
  });

  it("F-008/c1: checkToken warns when Jira doesn't say what kind of account the token is", async () => {
    const answers: Readonly<Record<string, unknown>> = {
      "/myself": { accountId: "5b10a2844c20165700ede21g", displayName: "ostra-bot" },
      "/project/search": { values: [{ id: "10000", key: "PROJ", name: "Globex shop" }], isLast: true },
      "/mypermissions": { permissions: Object.fromEntries(JIRA_CONNECT_PERMISSIONS.map((key) => [key, { havePermission: true }])) },
      "/workflows/search": { values: [{ name: "Software workflow" }], statuses: [], isLast: true },
    };
    const stub: typeof fetch = (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname.replace(/^.*\/rest\/api\/3/, "");
      return Promise.resolve(Response.json(answers[path] ?? {}, { status: path in answers ? 200 : 404 }));
    };
    const read = checked(await jiraConnect.checkToken({ apiUrl: null, fetch: stub, timeoutMs: 5000 }, { cloudId: "a3f9c12e-0000-4000-8000-000000000000", email: "ostra-bot@serviceaccount.atlassian.com", token: "ATATTstub" }));
    expect(read.account).toEqual({ outcome: "warn", accountId: "5b10a2844c20165700ede21g", name: "ostra-bot", accountType: null });
    expect([read.projects.outcome, read.permissions.outcome, read.workflows.outcome]).toEqual(["ok", "ok", "ok"]);
  });

  it("F-008/c1: step 3's words: the four scopes, the six events, the JQL for the projects step 2 saw, and the site's WebHooks page", () => {
    expect(jiraConnect.scopes).toEqual(ALL_SCOPES);
    expect(jiraConnect.webhookEvents).toEqual(["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"]);
    expect(jiraConnect.suggestedJql(["PROJ", "SHOP", "OPS"])).toBe("project in (PROJ, SHOP, OPS)");
    expect(jiraConnect.suggestedJql([])).toBeNull();
    expect(jiraConnect.webhooksPage("globex.atlassian.net")).toBe("https://globex.atlassian.net/plugins/servlet/webhooks");
    expect(jiraConnect.webhooksPage("not a host")).toBeNull();
  });

  it("F-008/c2: no check's answer, error or log line holds the token, the email or Jira's body; the token goes only in the Basic header, to the gateway with the cloud ID", async () => {
    const answers = [
      await jiraConnect.checkToken(options, tokenOf()),
      await jiraConnect.checkToken(options, tokenOf({ token: `${fake.token}-wrong` })),
      await jiraConnect.findSite(options, "globex-shop"),
    ];
    fake.injectFaults([{ kind: "unavailable" }]);
    answers.push(await jiraConnect.checkToken(options, tokenOf()));
    // The workflow read with a token that can't, through the adapter: its log lines.
    const context = memoryAdapterContext();
    const narrow = fake.mintToken(fake.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    const adapter = new JiraAdapter({ siteUrl: fake.siteUrl, auth: { email: fake.serviceAccount.email, token: narrow }, cloudId: fake.cloudId, gatewayUrl: fake.gatewayUrl }, context);
    expect((await adapter.readWorkflow({ externalId: fake.project.id })).ok).toBe(true);
    const ticket = fake.createIssue({ summary: "Moved blind" });
    const moved = await adapter.moveTicket({ externalId: fake.project.id }, { externalId: ticket.id }, "in-review", {
      started: fake.statuses.find((one) => one.name === "In Progress")?.id ?? "",
      inReview: fake.statuses.find((one) => one.name === "In Review")?.id ?? "",
      done: fake.statuses.find((one) => one.name === "Done")?.id ?? "",
    });
    expect(moved.ok).toBe(true);
    expect(context.logger.records.some((record) => record.message === "jira.workflow.unread")).toBe(true);

    const said = JSON.stringify([answers, context.logger.records, moved]);
    for (const secret of [fake.token, narrow, fake.serviceAccount.email, "Client must be authenticated", "Service unavailable", "errorMessages"]) {
      expect(said).not.toContain(secret);
    }
    // Every credentialed request went to the gateway with the cloud ID, the token in its Basic header alone.
    const basic = `Basic ${Buffer.from(`${fake.serviceAccount.email}:${fake.token}`).toString("base64")}`;
    const withToken = sent.filter((one) => one.headers["authorization"] === basic);
    expect(withToken.length).toBeGreaterThan(3);
    expect(withToken.every((one) => one.url.startsWith(`${fake.gatewayUrl}/ex/jira/${fake.cloudId}/rest/api/3/`))).toBe(true);
    for (const one of sent) {
      expect(one.url).not.toContain(fake.token);
      expect(Object.entries(one.headers).filter(([name, value]) => name !== "authorization" && value.includes(fake.token))).toEqual([]);
    }
    const digest = createHash("sha256").update(fake.token).digest("hex").slice(0, 16);
    expect(fake.calls().filter((call) => call.credential === digest).every((call) => call.via === "gateway")).toBe(true);
  });
});
