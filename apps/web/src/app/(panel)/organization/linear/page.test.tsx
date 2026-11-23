import { beforeEach, describe, expect, it, vi } from "vitest";

// Milestone 11, ticket 12 (F-152/c1, choice 13): Organization › Linear became Trackers. Its old
// address leads to the organization's first Linear connection's page, or to Trackers with none, and
// keeps the query Linear's callback adds.

type Row = { readonly id: string; readonly kind: "linear" | "jira" };

const state: { connections: readonly Row[]; signedIn: boolean } = { connections: [], signedIn: true };

/** What `redirect` throws here: the address, as Next's own throws to end the render. */
const REDIRECT = "redirected:";

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`${REDIRECT}${to}`);
  },
}));
vi.mock("@/server/api", () => ({
  getServerApi: () => Promise.resolve({ signedIn: state.signedIn, caller: { trackers: { list: () => Promise.resolve({ canManage: true, connections: state.connections }) } } }),
}));

const { default: LinearPage } = await import("./page");

const landing = async (query: Record<string, string> = {}): Promise<string> => {
  try {
    await LinearPage({ searchParams: Promise.resolve(query) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(REDIRECT)) return error.message.slice(REDIRECT.length);
    throw error;
  }
  throw new Error("the page didn't redirect");
};

describe("/organization/linear", () => {
  beforeEach(() => {
    state.connections = [];
    state.signedIn = true;
  });

  it("F-152/c1: lands on the first Linear connection's page, past a Jira one listed before it", async () => {
    state.connections = [
      { id: "11111111-1111-4111-8111-111111111111", kind: "jira" },
      { id: "22222222-2222-4222-8222-222222222222", kind: "linear" },
      { id: "33333333-3333-4333-8333-333333333333", kind: "linear" },
    ];
    expect(await landing()).toBe("/organization/trackers/22222222-2222-4222-8222-222222222222");
    expect(await landing({ connected: "1" })).toBe("/organization/trackers/22222222-2222-4222-8222-222222222222?connected=1");
  });

  it("F-152/c1: lands on Trackers when the organization has no Linear connection", async () => {
    state.connections = [{ id: "11111111-1111-4111-8111-111111111111", kind: "jira" }];
    expect(await landing()).toBe("/organization/trackers");
    state.connections = [];
    expect(await landing({ error: "Linear refused" })).toBe("/organization/trackers?error=Linear+refused");
  });
});
