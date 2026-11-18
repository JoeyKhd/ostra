import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LinearAdapter } from "./linear-adapter.ts";

// Live, read-only, against the test workspace (team OST). It runs only with `linear.env` loaded
// (`set -a; . ~/.config/ostra-dev/linear.env; set +a`) and skips otherwise. It prints no key, and
// it changes nothing in the workspace.

const env = z
  .object({ LINEAR_API_KEY: z.string().min(1), LINEAR_TEST_TEAM_ID: z.string().min(1) })
  .safeParse(process.env);

describe.skipIf(!env.success)("the Linear adapter, live on the test workspace", () => {
  it("is healthy, and lists the tickets of the test team", async () => {
    if (!env.success) {
      return;
    }
    const adapter = new LinearAdapter({ auth: { kind: "api-key", token: env.data.LINEAR_API_KEY } });
    expect(await adapter.health()).toEqual({ status: "ok" });
    const listed = await adapter.listTickets({ board: { externalId: env.data.LINEAR_TEST_TEAM_ID } });
    expect(listed.ok, listed.ok ? "" : `listing failed: ${listed.error.code}`).toBe(true);
    if (listed.ok && listed.value.tickets[0] !== undefined) {
      const first = listed.value.tickets[0];
      expect(first.key).toMatch(/^[A-Z]+-\d+$/);
      expect(await adapter.getTicket({ externalId: env.data.LINEAR_TEST_TEAM_ID }, first.key)).toMatchObject({ ok: true, value: { key: first.key } });
    }
  }, 30_000);
});
