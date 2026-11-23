import { routeTo } from "@ostra/adapter-sdk";
import type { AdapterResult, BoardRef, TrackerWorkflow } from "@ostra/adapter-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { jiraConnect } from "./connect.ts";
import type { JiraConnectOptions, JiraProjectRef } from "./connect.ts";
import { JIRA_GATEWAY_URL, JiraAdapter } from "./jira-adapter.ts";

// Live, against the maintainer's Jira Cloud test site (spec section 3, ticket 19; ticket 18 runs
// it). It runs only with `jira.env` loaded (`set -a; . ~/.config/ostra-dev/jira.env; set +a`) and
// skips otherwise, so CI never runs it. It reads back the service account's token (the four
// checks; S-10), reads each project's workflow (S-12: whether a service account's scoped token
// reads the graph, on a company-managed and a team-managed project), and moves one throwaway issue
// along a route by its transitions, deleting it at the end whatever happened. It prints what it
// found for the ticket's Comments, and never the token or the email.

const env = z
  .object({
    OSTRA_JIRA_LIVE_SITE: z.string().min(1),
    OSTRA_JIRA_LIVE_EMAIL: z.string().min(1),
    OSTRA_JIRA_LIVE_TOKEN: z.string().min(1),
    /** The project the move runs in. Default `OJ` when the token sees it, else the first it sees. */
    OSTRA_JIRA_LIVE_PROJECT: z.string().min(1).optional(),
  })
  .safeParse(process.env);

const must = <T,>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

describe.skipIf(!env.success)("the Jira adapter, live on the maintainer's test site", () => {
  const live = env.data;
  const options: JiraConnectOptions = { apiUrl: null, fetch, timeoutMs: 30_000 };
  let site: { readonly cloudId: string; readonly host: string } | null = null;
  let projects: readonly JiraProjectRef[] = [];
  const throwaway: string[] = [];

  afterAll(async () => {
    if (live === undefined || site === null) return;
    // Jira's own call, as a person deletes an issue: the adapter has no delete.
    const authorization = `Basic ${Buffer.from(`${live.OSTRA_JIRA_LIVE_EMAIL}:${live.OSTRA_JIRA_LIVE_TOKEN}`).toString("base64")}`;
    for (const id of throwaway) {
      const response = await fetch(`${JIRA_GATEWAY_URL}/ex/jira/${site.cloudId}/rest/api/3/issue/${id}`, { method: "DELETE", headers: { authorization } });
      console.info(`live clean-up: issue ${id} ${response.ok ? "deleted" : `not deleted (HTTP ${String(response.status)}): delete it by hand`}`);
    }
  });

  it("F-008/c1: finds the site and reads back the service account's token: who it is, the projects, the permissions, the workflows and the scopes", async () => {
    if (live === undefined) return;
    const found = await jiraConnect.findSite(options, live.OSTRA_JIRA_LIVE_SITE);
    console.info(`live site: ${found.kind}${found.kind === "found" ? ` at ${found.host}, titled ${found.title}` : ""}`);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    site = { cloudId: found.cloudId, host: found.host };
    const read = await jiraConnect.checkToken(options, { cloudId: found.cloudId, email: live.OSTRA_JIRA_LIVE_EMAIL, token: live.OSTRA_JIRA_LIVE_TOKEN });
    if (read.kind !== "checked") {
      console.info(`live read-back: ${read.kind} (HTTP ${String(read.status)})`);
    }
    expect(read.kind).toBe("checked");
    if (read.kind !== "checked") return;
    projects = read.projects.projects;
    // S-10: a service account (`app`), or the bot user ADR 0047 falls back to (`atlassian`).
    console.info(`live read-back: account ${read.account.outcome} (accountType ${String(read.account.accountType)})`);
    console.info(`live read-back: projects ${read.projects.outcome}: ${projects.map((project) => project.key).join(", ")}`);
    console.info(`live read-back: permissions ${read.permissions.outcome}: ${read.permissions.projects.map((project) => `${project.key} lacks [${project.missing.join(", ")}]`).join("; ")}`);
    console.info(`live read-back: workflows ${read.workflows.outcome}, unreadable in [${read.workflows.unreadable.map((project) => project.key).join(", ")}]`);
    console.info(`live read-back: scopes ${read.scopes.map((one) => `${one.scope} ${one.state}`).join(", ")}`);
    expect(read.projects.outcome).toBe("ok");
    expect(read.scopes.find((one) => one.scope === "read:jira-work")?.state).toBe("confirmed");
  });

  it("F-008/c5: reads each project's workflow (S-12), and moves a throwaway issue along a route by its transitions, answering them in via", async () => {
    if (live === undefined || site === null) return;
    const adapter = new JiraAdapter({ siteUrl: `https://${site.host}`, auth: { email: live.OSTRA_JIRA_LIVE_EMAIL, token: live.OSTRA_JIRA_LIVE_TOKEN }, cloudId: site.cloudId });
    const workflows = new Map<string, TrackerWorkflow>();
    for (const project of projects) {
      const workflow = must(await adapter.readWorkflow({ externalId: project.id }), `readWorkflow ${project.key}`);
      workflows.set(project.id, workflow);
      const global = workflow.transitions.filter((transition) => transition.from === "any").length;
      console.info(`live S-12: ${project.key}: workflow ${workflow.readable ? "readable" : "not readable"}, ${String(workflow.statuses.length)} statuses, ${String(workflow.transitions.length)} transitions (${String(global)} global)`);
    }
    const project = projects.find((one) => one.key === (live.OSTRA_JIRA_LIVE_PROJECT ?? "OJ")) ?? projects[0];
    expect(project).toBeDefined();
    if (project === undefined) return;
    const board: BoardRef = { externalId: project.id };
    const statuses = must(await adapter.listStatuses(board), "listStatuses");
    const started = statuses.filter((status) => status.category === "started");
    const done = statuses.find((status) => status.category === "done");
    const first = started[0];
    expect(first).toBeDefined();
    if (first === undefined || done === undefined) return;
    const ticket = must(await adapter.createTicket(board, { title: "ostra live test: a throwaway issue, deleted after", description: "Made by ostra's live test of the Jira adapter." }), "createTicket");
    throwaway.push(ticket.externalId);
    // The started status farthest along a route from where a new issue starts (with the workflow), else the first.
    const workflow = workflows.get(project.id);
    const target =
      workflow?.readable === true
        ? (started
            .map((status) => ({ status, route: routeTo(workflow, ticket.status.id, status.id) }))
            .filter((one) => one.route !== null && one.route.length > 0)
            .sort((a, b) => (b.route?.length ?? 0) - (a.route?.length ?? 0))[0]?.status ?? first)
        : first;
    const moved = must(await adapter.moveTicket(board, { externalId: ticket.externalId }, "in-review", { started: first.id, inReview: target.id, done: done.id }), "moveTicket");
    console.info(`live move: ${ticket.key} from ${ticket.status.name} to ${moved.status.name} by ${moved.via.map((step) => step.name).join(" → ")}`);
    expect(moved).toMatchObject({ moved: true, status: { id: target.id } });
    expect(moved.via.length).toBeGreaterThan(0);
    expect(must(await adapter.getTicket(board, { externalId: ticket.externalId }), "getTicket").status.id).toBe(target.id);
  });
});
