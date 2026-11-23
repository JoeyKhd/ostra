import type { AppRouter } from "@ostra/api";
import { boardIdSchema, connectionIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, userIdSchema } from "@ostra/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { KindTiles } from "./tracker-picker";
import { agoText, capabilityChips, keptApartText, rowStatus, statusWord } from "./tracker-words";
import type { PickerKinds, TrackerCapabilities, TrackerItem } from "./tracker-words";
import { TrackerPanel } from "./trackers-panel";

// Milestone 11, ticket 12 (F-152, F-008; app-targets/m11-trackers/trackers.md): Organization ›
// Trackers as the page renders it, every query answered from the cache the way `trackers.list`
// (ticket 09) gives it: four connections of two kinds with their marks, names, sites, modes, last
// events, states and the selected one's panel; a member's view; the picker's Coming-soon tiles; and
// Jira's "What Jira does here", where agent mode is only `– not in Jira`.

vi.mock("next/navigation", () => ({
  usePathname: () => "/organization/trackers",
  useRouter: () => ({ replace: () => undefined, push: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

const { TrackersView } = await import("./trackers-view");

const now = Date.UTC(2026, 10, 23, 12, 0, 0);
const organizationId = organizationIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000a1");

// What the two adapters declare (`LINEAR_CAPABILITIES`, `JIRA_CAPABILITIES`), as `trackers.list` sends them.
const linearCaps: TrackerCapabilities = {
  agentSessions: true,
  subIssues: true,
  statusGraph: false,
  webhooks: true,
  commentEdit: true,
  attachments: true,
  transitions: false,
  mentions: true,
  agentScopes: ["app:assignable", "app:mentionable"],
  agentSessionLink: true,
  ticketFields: { acceptanceCriteria: false },
  ticketFiles: "all",
  magicWords: true,
  richText: "markdown",
  jqlFilter: false,
};
const jiraCaps: TrackerCapabilities = {
  ...linearCaps,
  agentSessions: false,
  agentScopes: [],
  agentSessionLink: false,
  statusGraph: true,
  transitions: true,
  magicWords: false,
  richText: "adf",
  jqlFilter: true,
};
const kinds: PickerKinds = { linear: linearCaps, jira: jiraCaps };

const id = (n: number) => connectionIdSchema.parse(`01a1f6b2-0000-7000-8000-00000000c0${String(n).padStart(2, "0")}`);
const calculator = projectIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000c1");
const shop = projectIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000c2");

const base = {
  site: null,
  state: "active",
  webhookMode: "webhooks",
  lastEventAt: null,
  failedReason: null,
  silentSince: null,
  tokenExpiresAt: null,
  tokenExpiry: null,
  signsInAs: null,
  agentModeAt: null,
  boards: [],
  createdAt: now - 30 * 86_400_000,
} as const satisfies Partial<TrackerItem>;

const acme: TrackerItem = { ...base, id: id(1), kind: "linear", name: "Acme Linear", site: "acme", lastEventAt: now - 2 * 60_000, signsInAs: "ostra", capabilities: linearCaps };
const globex: TrackerItem = {
  ...base,
  id: id(2),
  kind: "jira",
  name: "Globex Jira",
  site: "globex.atlassian.net",
  lastEventAt: now - 6 * 60_000,
  signsInAs: "ostra-bot",
  tokenExpiresAt: Date.UTC(2027, 8, 14),
  tokenExpiry: { state: "healthy" },
  boards: [
    { id: boardIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000d1"), name: "Globex Calculator", key: "PROJ", project: { id: calculator, name: "calculator" } },
    { id: boardIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000d2"), name: "Globex Shop", key: "SHOP", project: { id: shop, name: "globex-shop" } },
  ],
  capabilities: jiraCaps,
};
const acmeOps: TrackerItem = { ...base, id: id(3), kind: "jira", name: "Acme Ops Jira", site: "acme-ops.atlassian.net", state: "pending", capabilities: jiraCaps };
const northwind: TrackerItem = {
  ...base,
  id: id(4),
  kind: "linear",
  name: "Northwind Linear",
  site: "northwind",
  state: "failed",
  webhookMode: "polling",
  lastEventAt: now - 3 * 3_600_000,
  failedReason: "Linear refused the refresh token: authorize the Linear app again",
  capabilities: linearCaps,
};
const four = [acme, globex, acmeOps, northwind];

const meOf = (role: "admin" | "member"): RouterOutputs["me"]["get"] => ({
  userId: userIdSchema.parse("user-alex"),
  name: "Alex Kim",
  username: "alex",
  email: "alex@example.com",
  instanceAdmin: false,
  passwordChange: "none",
  theme: "dark",
  memberId: memberIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000b1"),
  organization: { id: organizationId, name: "Acme Corp", slug: "acme", role },
  noMembership: null,
});

/** Organization › Trackers as the page renders it, with `trackers.list`'s answer in the cache. */
const renderTrackers = (connections: readonly TrackerItem[], canManage: boolean): string => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
  // Never called: every query this render reads is in the cache, or waits.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
  queryClient.setQueryData(trpc.me.get.queryKey(), meOf(canManage ? "admin" : "member"));
  queryClient.setQueryData(trpc.trackers.list.queryKey(), { canManage, connections: [...connections] }, { updatedAt: now });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <TrackersView kinds={kinds} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

/** The table's row for one connection. */
const rowOf = (html: string, connection: TrackerItem): string => {
  const match = new RegExp(`<tr[^>]*data-connection="${connection.id}"[^>]*>.*?</tr>`).exec(html);
  if (match === null) throw new Error(`no row for ${connection.name}`);
  return match[0];
};

/** The properties panel. */
const panelOf = (html: string): string => {
  const at = html.indexOf('data-testid="tracker-panel"');
  if (at < 0) throw new Error("no panel");
  return html.slice(at);
};

const count = (html: string, text: string): number => html.split(text).length - 1;

const escaped = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe("Organization › Trackers", () => {
  it("F-152/c1: lists four connections of two kinds with their marks, names, sites, modes, last events and states, and the selected one's panel", () => {
    const html = renderTrackers(four, true);
    expect(html).toContain(t("trackers.title"));
    expect(html).toContain(`>${t("trackers.connections")}</h2><span class="font-mono text-[12.5px] text-faint">4</span>`);

    const acmeRow = rowOf(html, acme);
    expect(acmeRow).toContain('data-tracker-mark="linear"');
    expect(acmeRow).toContain('data-treatment="brand"');
    expect(acmeRow).toContain('width="20"');
    expect(acmeRow).toContain("Acme Linear");
    expect(acmeRow).toContain(">Linear<");
    expect(acmeRow).toContain(">acme<");
    expect(acmeRow).toContain(t("trackers.mode.webhooks"));
    expect(acmeRow).toContain(agoText(acme.lastEventAt ?? 0, now));
    expect(acmeRow).toContain(t("trackers.status.connected"));

    const globexRow = rowOf(html, globex);
    expect(globexRow).toContain('data-tracker-mark="jira"');
    expect(globexRow).toContain(t("trackers.kind.jira"));
    expect(globexRow).toContain("globex.atlassian.net");

    const opsRow = rowOf(html, acmeOps);
    expect(opsRow).toContain(t("trackers.status.pending"));
    expect(opsRow).toContain(t("trackers.why.noDelivery"));
    expect(opsRow).toContain(">–<");

    const northwindRow = rowOf(html, northwind);
    expect(northwindRow).toContain(t("trackers.mode.polling"));
    expect(northwindRow).toContain(t("trackers.status.failed"));
    expect(northwindRow).toContain(t("trackers.why.tokenRefused"));

    // The first row is selected, and its detail fills the panel, with Open <name> → to its page.
    expect(acmeRow).toContain('aria-selected="true"');
    expect(globexRow).toContain('aria-selected="false"');
    const panel = panelOf(html);
    expect(panel).toContain(`data-connection="${acme.id}"`);
    expect(panel).toContain(t("trackers.panel.signsInAs"));
    expect(panel).toContain(t("trackers.panel.healthy"));
    expect(panel).toContain(`href="/organization/trackers/${acme.id}"`);
    expect(panel).toContain(t("trackers.panel.open", { name: "Acme Linear" }));

    // The admin's one primary, and the line under the table naming two clients.
    expect(html).toContain(t("trackers.connect"));
    expect(html).not.toContain(t("trackers.member"));
    expect(html).toContain(escaped(keptApartText(four.map((one) => one.name))));
    expect(keptApartText(four.map((one) => one.name))).toBe(t("trackers.keptApart", { first: "Globex", second: "Acme" }));
    expect(keptApartText(["ostra-test Linear", "ostra-test Jira"])).toBe(t("trackers.keptApartPlain"));

    // On a phone each connection is a card that opens its page.
    expect(html).toContain('data-testid="tracker-cards"');
    expect(html).toMatch(new RegExp(`<a [^>]*href="/organization/trackers/${northwind.id}"`));
  });

  it("F-152/c1: every row status the targets draw, from the connection's state", () => {
    expect(statusWord(rowStatus(acme))).toBe(t("trackers.status.connected"));
    expect(rowStatus({ ...acmeOps })).toEqual({ kind: "pending", why: t("trackers.why.noDelivery") });
    expect(rowStatus({ ...acme, state: "pending" })).toEqual({ kind: "pending", why: t("trackers.why.notAuthorized") });
    expect(rowStatus({ ...globex, state: "failed", failedReason: "token-refused" })).toEqual({ kind: "failed", why: t("trackers.why.tokenRefused") });
    expect(rowStatus({ ...globex, state: "failed", failedReason: "token-expired" })).toEqual({ kind: "failed", why: t("trackers.why.tokenExpired") });
    expect(rowStatus({ ...globex, state: "failed", failedReason: "site-not-found" })).toEqual({ kind: "failed", why: t("trackers.why.siteNotFound") });
    expect(statusWord(rowStatus({ ...globex, silentSince: now - 52 * 60_000 }))).toBe(t("trackers.status.silent"));
    expect(statusWord(rowStatus({ ...globex, tokenExpiry: { state: "expires-soon", days: 9 } }))).toBe(t("trackers.status.expiring"));
    expect(rowStatus({ ...globex, tokenExpiry: { state: "expired" } })).toEqual({ kind: "failed", why: t("trackers.why.tokenExpired") });
    expect(agoText(now - 40_000, now)).toBe("40s ago");
    expect(agoText(now - 6 * 60_000, now)).toBe("6m ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("F-152/c3: a member sees the list without Connect a tracker and with the member line", () => {
    const html = renderTrackers(four, false);
    for (const connection of four) expect(rowOf(html, connection)).toContain(escaped(connection.name));
    expect(html).not.toContain(t("trackers.connect"));
    expect(html).toContain(escaped(t("trackers.member")));
    // The panel without the sign-in and the token, which `trackers.list` sends to admins only.
    const panel = panelOf(html);
    expect(panel).not.toContain(t("trackers.panel.signsInAs"));
    expect(panel).not.toContain(t("trackers.panel.token"));

    // With no connection yet, a member gets the member line, not the picker.
    const none = renderTrackers([], false);
    expect(none).toContain(escaped(t("trackers.member")));
    expect(none).toContain(t("trackers.memberEmpty"));
    expect(none).not.toContain('role="radio"');
  });

  it("F-152/c8: the picker's Trello and Notion are disabled, unfocusable and say Coming soon", () => {
    const html = renderToStaticMarkup(<KindTiles kinds={kinds} picked="jira" onPick={() => undefined} onContinue={() => undefined} />);
    for (const kind of ["trello", "notion"]) {
      const tile = new RegExp(`<div [^>]*aria-disabled="true"[^>]*data-kind="${kind}"[^>]*>(.*?)</div>`).exec(html);
      expect(tile, kind).not.toBeNull();
      const inner = tile?.[0] ?? "";
      expect(inner).toContain(t("trackers.picker.soon"));
      expect(inner).toContain(`data-tracker-mark="${kind}"`);
      // Nothing in it takes the focus or goes anywhere: no tabindex, no link, no button, no field.
      expect(inner).not.toMatch(/tabindex|<a |<button|<input|href=/);
    }
    // Linear and Jira are the two to pick, as radios; Jira picked.
    expect(html).toMatch(/<button type="button" role="radio" aria-checked="false" data-kind="linear"/);
    expect(html).toMatch(/<button type="button" role="radio" aria-checked="true" data-kind="jira"/);

    // The empty page shows the same tiles, Coming soon included, with Continue.
    const empty = renderTrackers([], true);
    expect(empty).toContain('data-testid="trackers-empty"');
    expect(count(empty, "data-coming-soon")).toBe(2);
    expect(empty).toContain(t("trackers.empty.continue"));
    expect(empty).toContain(t("trackers.how.title"));
  });

  it("F-008/c9: Jira's panel lists Agent mode – not in Jira and nothing else of agent mode", () => {
    const jira = renderToStaticMarkup(<TrackerPanel connection={globex} detail={undefined} canManage now={now} />);
    const does = jira.slice(jira.indexOf(t("trackers.panel.does", { kind: "Jira" })));
    expect(does).toContain(t("trackers.panel.notIn", { kind: "Jira" }));
    expect(count(jira, t("trackers.panel.agentMode"))).toBe(1);
    expect(jira).not.toContain(`>${t("trackers.panel.on")}<`);
    expect(jira).not.toContain(`>${t("trackers.panel.off")}<`);
    expect(jira).toContain(t("trackers.panel.byTransitions"));
    expect(jira).toContain(t("trackers.panel.subTasks"));
    expect(jira).toContain(t("trackers.panel.adf"));
    // Its boards, each its project and the board's name and key.
    expect(jira).toContain("globex-shop");
    expect(jira).toContain("Globex Calculator · <span class=\"font-mono\">PROJ</span>");
    // Jira's tile offers no agent mode either: its chips are what its adapter declares.
    expect(capabilityChips("jira", jiraCaps)).toEqual([t("trackers.cap.transitions"), t("trackers.cap.subTasks"), t("trackers.cap.jql")]);
    expect(capabilityChips("linear", linearCaps)).toEqual([t("trackers.cap.agentMode"), t("trackers.cap.subIssues"), t("trackers.cap.magicWords")]);

    // Linear's panel says whether agent mode is on.
    const linear = renderToStaticMarkup(<TrackerPanel connection={{ ...acme, agentModeAt: now - 86_400_000 }} detail={undefined} canManage now={now} />);
    expect(linear).not.toContain(t("trackers.panel.notIn", { kind: "Linear" }));
    expect(linear).toContain(`>${t("trackers.panel.on")}<`);
    expect(linear).toContain(t("trackers.panel.directly"));
  });
});
