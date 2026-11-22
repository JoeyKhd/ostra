import type { AppRouter } from "@ostra/api";
import { memberIdSchema, needsYouItemIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema, userIdSchema } from "@ostra/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";
import { TRPCProvider } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// F-062/c2 (home.md, "Purpose"): Home answers, in this order, what waits on the member (Needs you,
// amber, first), how each project is doing (the Projects table: what's running, queued and needs
// you), and what just happened (Recent activity). The whole `HomeView`, as the page renders it,
// with its queries' answers in the cache the way the API gives them.

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: () => undefined, push: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

const { HomeView } = await import("./home-view");

type Overview = RouterOutputs["home"]["overview"];

const now = Date.now();
const projectId = projectIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000c1");
const organizationId = organizationIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000a1");

const me: RouterOutputs["me"]["get"] = {
  userId: userIdSchema.parse("user-alex"),
  name: "Alex Kim",
  username: "alex",
  email: "alex@example.com",
  instanceAdmin: false,
  passwordChange: "none",
  theme: "dark",
  memberId: memberIdSchema.parse("01a1f6b2-0000-7000-8000-0000000000b1"),
  organization: { id: organizationId, name: "Acme Corp", slug: "acme", role: "admin" },
  noMembership: null,
};

const setup: RouterOutputs["setup"]["status"] = { steps: [], next: null, complete: true, completedAt: now - 86_400_000, runnerOnline: true };

const overview: Overview = {
  summary: { projects: 1, running: 2, queued: 1, prsToday: 0, mergedToday: 0 },
  needsYou: {
    total: 2,
    rows: [
      {
        itemId: needsYouItemIdSchema.parse("01a1f6b3-0000-7000-8000-000000000001"),
        reason: "approval",
        state: "open",
        taskId: taskIdSchema.parse("01a1f6b2-8878-76a8-9a31-e7d9ed269801"),
        key: "CALC-142",
        title: "Retry webhook delivery on 5xx",
        project: { id: projectId, name: "calculator" },
        detail: { reason: "approval", command: "pnpm add p-retry", subject: null, ruleName: null },
        since: now - 4 * 60_000,
        driver: null,
        answer: null,
        outcome: null,
      },
      {
        itemId: needsYouItemIdSchema.parse("01a1f6b3-0000-7000-8000-000000000002"),
        reason: "question",
        state: "open",
        taskId: taskIdSchema.parse("01a1f6b2-8878-76a8-9a31-e7d9ed269802"),
        key: "CALC-150",
        title: "Keep the old share API",
        project: { id: projectId, name: "calculator" },
        detail: { reason: "question", question: "Keep the old share API?" },
        since: now - 26 * 60_000,
        driver: null,
        answer: null,
        outcome: null,
      },
    ],
  },
  projects: { total: 1, rows: [{ id: projectId, name: "calculator", repos: ["ostra-test/test1"], running: 2, queued: 1, needsYou: 2, prsThisWeek: 3, spendMonth: 12.5 }] },
  activity: [{ id: "01a1f6b4-0000-7000-8000-000000000001", event: { kind: "project.created", project: "calculator" }, project: { id: projectId, name: "calculator" }, at: now - 60 * 60_000 }],
  prsOpened: { total: 3, days: [] },
  prsMerged: { total: 0, days: [], firstPrMedianMs: null },
  spendMonth: 12.5,
  spendCap: null,
  pools: [],
  runners: [],
};

/** Home as the page renders it, every query answered from the cache. */
const renderHome = (): string => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
  // Never called: every query this render reads is in the cache.
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:9/api/trpc" })] });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
  queryClient.setQueryData(trpc.me.get.queryKey(), me);
  queryClient.setQueryData(trpc.setup.status.queryKey(), setup);
  queryClient.setQueryData(trpc.home.overview.queryKey(), overview);
  queryClient.setQueryData(trpc.notifications.budgetNotices.queryKey(), []);
  queryClient.setQueryData(trpc.automations.pausedByLimit.queryKey(), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <HomeView />
      </TRPCProvider>
    </QueryClientProvider>,
  ).replaceAll("&#x27;", "'");
};

/** Each Home section's title, in the order the page draws them. */
const sectionTitles = (html: string): readonly string[] => [...html.matchAll(/<section\b[^>]*>.*?<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1] ?? "");

describe("Home's order (F-062, home.md)", () => {
  it("F-062/c2: leads with Needs you in amber, its approval, question and the rest, then what's running in each project, then what's recent", () => {
    const html = renderHome();
    expect(sectionTitles(html)).toEqual([t("home.needsYou.title"), t("home.projects"), t("home.activity.title")]);
    const needsYou = html.indexOf('data-testid="needs-you"');
    const projects = html.indexOf('data-testid="home-projects"');
    const activity = html.indexOf('data-testid="home-activity"');
    expect(needsYou).toBeGreaterThan(-1);
    expect(projects).toBeGreaterThan(needsYou);
    expect(activity).toBeGreaterThan(projects);

    // Needs you: its title's mark is amber, and its rows are what waits on the member.
    expect(html).toMatch(new RegExp(`<section[^>]*><div[^>]*><span[^>]*class="[^"]*\\bbg-amber\\b[^"]*"[^>]*></span><h2[^>]*>${t("home.needsYou.title")}</h2>`));
    const needsYouRows = html.slice(needsYou, projects);
    expect(needsYouRows.indexOf("Retry webhook delivery on 5xx")).toBeGreaterThan(-1);
    expect(needsYouRows.indexOf("Keep the old share API?")).toBeGreaterThan(-1);
    // Then what's running: each project's running, queued and needs-you counts.
    const projectRows = html.slice(projects, activity);
    expect(projectRows).toContain(`>${t("home.table.running")}</th>`);
    expect(projectRows).toMatch(/>calculator<\/span><\/a><\/td><td[^>]*>ostra-test\/test1<\/td><td[^>]*>2<\/td><td[^>]*>1<\/td>/);
    // Then what's recent.
    expect(html.slice(activity)).toContain("calculator");
  });
});
