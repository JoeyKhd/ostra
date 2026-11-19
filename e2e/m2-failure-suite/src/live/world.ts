import path from "node:path";

import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { startRunner } from "@ostra/e2e-m1/runner";
import type { RunningRunner } from "@ostra/e2e-m1/runner";
import type { DemoSettings } from "@ostra/e2e-m1/settings";
import { connectRunner, say, screenshot } from "@ostra/e2e-m1/setup";
import type { LinearTool } from "@ostra/e2e-m2/linear";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { organizationIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RunnerId } from "@ostra/protocol";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import type { CutProxy } from "../tools/cut-proxy.ts";
import type { FaultProxy } from "../tools/fault-proxy.ts";
import type { PanelApi } from "./api.ts";
import type { Stack } from "./stack.ts";

// What every case works with (ticket 38): the stack, the panel's API as the admin, the database
// the checks read, Linear and GitHub as the test tool sees them, the runners, and the suite's
// proxies. And the setup's own steps that milestone 1's and 2's helpers don't have.

/** The label of the suite's webhook on Linear: never the demo's, so neither deletes the other's. */
export const SUITE_WEBHOOK_LABEL = "ostra e2e m2 failure suite";

export type SuiteRunner = {
  readonly name: string;
  readonly dataDir: string;
  readonly logFile: string;
  /** Core's address as this runner reaches it: core itself, or a cut proxy in front of it. */
  readonly serverUrl: string;
  readonly cut: CutProxy | null;
  runnerId: RunnerId;
  process: RunningRunner;
};

export type World = {
  readonly m2: M2Settings;
  readonly db: Db;
  readonly api: PanelApi;
  readonly page: Page;
  readonly tool: LinearTool;
  readonly github: DemoGitHub;
  readonly stack: Stack;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly projectHref: string;
  readonly connectionId: string;
  readonly boardId: string;
  readonly faults: { readonly linear: FaultProxy; readonly github: FaultProxy };
  readonly runners: Map<string, SuiteRunner>;
  /** Tickets and branches the run made, for the clean-up. */
  readonly made: { readonly tickets: { readonly id: string; readonly identifier: string }[]; readonly taskIds: string[] };
};

/** Step 2 of milestone 2's demo: the team attached in the panel; the mapping drafts itself. */
export const attachBoard = async (page: Page, settings: M2Settings, projectHref: string): Promise<void> => {
  await page.goto(`${projectHref}/boards`);
  await page.getByText("Attach a team").first().waitFor({ timeout: 60_000 });
  const already = page.locator("li", { hasText: settings.linearTeamKey }).filter({ hasText: "Detach" });
  if ((await already.count()) > 0) return;
  say(`setup: attach ${settings.linearTeamKey}`);
  await page.getByRole("combobox", { name: "Attach a team" }).click();
  await page.getByRole("option", { name: new RegExp(`· ${settings.linearTeamKey}`) }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await already.first().waitFor({ timeout: 60_000 });
  await screenshot(page, settings, "board-attached");
};

const runnerSettings = (m2: M2Settings, runner: { readonly name: string; readonly dataDir: string; readonly serverUrl: string }): DemoSettings => ({
  ...m2,
  runnerName: runner.name,
  runnerDataDir: runner.dataDir,
  coreUrl: runner.serverUrl,
});

const runnerIdOf = async (db: Db, name: string): Promise<RunnerId> => {
  const row = await db.runner.findFirst({ where: { name, revokedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (row === null) throw new Error(`no runner named ${name}`);
  return runnerIdSchema.parse(row.id);
};

/** A personal runner signed in by device code in the panel, from its own folder. */
export const addRunner = async (
  world: Pick<World, "m2" | "page" | "db" | "runners" | "stack">,
  input: { readonly name: string; readonly dataDir: string; readonly cut: CutProxy | null; readonly logDir: string },
): Promise<SuiteRunner> => {
  const serverUrl = input.cut?.url ?? world.stack.coreUrl;
  const logFile = path.join(input.logDir, `runner-${input.name}.log`);
  const started = await connectRunner(world.page, runnerSettings(world.m2, { name: input.name, dataDir: input.dataDir, serverUrl }), logFile);
  const runner: SuiteRunner = { name: input.name, dataDir: input.dataDir, logFile, serverUrl, cut: input.cut, runnerId: await runnerIdOf(world.db, input.name), process: started };
  world.runners.set(input.name, runner);
  return runner;
};

/** The runner started again from its folder: already signed in, it connects at once. */
export const restartRunner = async (world: Pick<World, "m2">, runner: SuiteRunner): Promise<void> => {
  const started = await startRunner(runnerSettings(world.m2, { name: runner.name, dataDir: runner.dataDir, serverUrl: runner.serverUrl }), runner.logFile);
  if ((await started.deviceCode) !== null) throw new Error(`${runner.name} asked for a device code again: its identity was lost`);
  await started.online;
  runner.process = started;
};

const secretRows = (db: Db): SecretRowStore => ({
  insert: () => Promise.reject(new Error("the suite only reads secrets")),
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) return undefined;
    return { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: () => Promise.resolve(false),
});

/**
 * The Linear connection's webhook secret, from the stack's secret store: the replay case signs the
 * stored deliveries again with it, as Linear would. Held in memory only, never printed.
 */
export const linearWebhookSecret = async (db: Db, serverDataDir: string, connectionId: string): Promise<string> => {
  const key = parseSecretsKey((await readFile(path.join(serverDataDir, "secrets-key"), "utf8")).trim());
  if (!key.ok) throw new Error(`the stack's secrets key: ${key.error.message}`);
  const store = new BuiltinSecretStore({ rows: secretRows(db), key: key.value });
  const connection = await db.connection.findUniqueOrThrow({ where: { id: connectionId }, select: { organizationId: true, webhookSecretSecretRef: true } });
  const ref = secretRefSchema.parse(connection.webhookSecretSecretRef);
  const secret = await store.get(organizationIdSchema.parse(connection.organizationId), ref);
  if (!secret.ok) throw new Error(`the webhook secret: ${secret.error.message}`);
  return secret.value;
};
