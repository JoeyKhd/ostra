import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { parseServerSettings } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPeer } from "../testing/fake-peer.ts";
import { accessToken, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { loadRunnerTokenKey } from "./keys.ts";

// Q136, item 1 (milestone 2's ticket 45): two core replicas with data folders of their own, over
// one database, as a cluster runs them (ADR 0034: any replica serves any request). Each loads its
// runner-token key the way `startCore` does, from the settings.

let test: TestDatabase;
let fixture: IsolationFixture;
const folders: string[] = [];
const harnesses: GatewayHarness[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.stop();
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
  await test.dispose();
});

/** A core replica with its own data folder, from these settings. */
const replica = async (env: Record<string, string>): Promise<GatewayHarness> => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-replica-"));
  folders.push(dataDir);
  const parsed = parseServerSettings({ ...env, OSTRA_DATA_DIR: dataDir, DATABASE_URL: test.url });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  const harness = await startGateway(test.db, test.url, { signingKey: await loadRunnerTokenKey(parsed.settings) });
  harnesses.push(harness);
  return harness;
};

describe("the runner-token key (Q136)", () => {
  it("F-001: two cores with separate data folders and the same OSTRA_RUNNER_TOKEN_KEY accept each other's tokens", async () => {
    const shared = { OSTRA_RUNNER_TOKEN_KEY: randomBytes(32).toString("base64") };
    const a = await replica(shared);
    const b = await replica(shared);
    const runner = await registerPersonal(a, test.db, fixture.a.member);
    const fromA = await accessToken(a, runner);
    const fromB = await accessToken(b, runner);
    // Each replica takes the token the other issued at the upgrade.
    const onB = await connectPeer(b.url, fromA.accessToken, runner.runnerId);
    await onB.next("welcome");
    onB.close();
    const onA = await connectPeer(a.url, fromB.accessToken, runner.runnerId);
    await onA.next("welcome");
    onA.close();
  });

  it("F-001: without the setting, each core makes its own key and refuses the other's tokens", async () => {
    const a = await replica({});
    const b = await replica({});
    const runner = await registerPersonal(a, test.db, fixture.a.member);
    const fromA = await accessToken(a, runner);
    await expect(connectPeer(b.url, fromA.accessToken, runner.runnerId)).rejects.toThrow("401");
    // The control's own replica takes it.
    const onA = await connectPeer(a.url, fromA.accessToken, runner.runnerId);
    await onA.next("welcome");
    onA.close();
  });

  it("F-001: OSTRA_RUNNER_TOKEN_KEY takes 64 hex characters or 32 bytes of base64, and refuses another length", () => {
    const bytes = randomBytes(32);
    for (const text of [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")]) {
      const parsed = parseServerSettings({ OSTRA_RUNNER_TOKEN_KEY: text });
      expect(parsed.ok && parsed.settings.runnerTokenKey?.equals(bytes)).toBe(true);
    }
    const short = parseServerSettings({ OSTRA_RUNNER_TOKEN_KEY: randomBytes(16).toString("base64") });
    expect(short.ok).toBe(false);
    expect(short.ok ? "" : short.errors.join("\n")).toContain("OSTRA_RUNNER_TOKEN_KEY");
  });
});
