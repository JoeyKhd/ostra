import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, ManualClock } from "@ostra/adapter-sdk/testing";
import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { startReplica } from "@ostra/jobs/testing";
import type { Replica } from "@ostra/jobs/testing";
import { connectionIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { bulletOutcome } from "./judge.ts";
import type { LinearAccess } from "./linear-api.ts";
import { openStore, readSessions, seedAgentModeBoard, seedAppConnection, stopFromPanel } from "./ostra-side.ts";
import type { OstraWorld } from "./ostra-side.ts";
import type { PhaseContext } from "./phases.ts";
import { readInstall, rotateAppToken, runBullets } from "./run.ts";
import { harnessSettings } from "./settings.ts";

// Ticket 38 (F-012): the harness's rehearsal. Every phase of the live run, through the same code,
// against ostra itself (core as its own process, `restart-child.ts`, on Postgres: its inbox, the
// claim, the queue, the outbox, the heartbeat) with the fake Linear server (ticket 02) standing in
// for Linear: its webhooks go to core's inbox, its GraphQL answers the harness and core, and a script
// presses "Send stop request". For the 35 silent minutes the fake's clock runs 10 times the wall
// clock and core's heartbeat is a minute (10 of Linear's), so the turn takes 3.5 minutes; the
// silent task waits queued (no runner). It proves the harness and ostra's side on the fake; it
// proves nothing about Linear, which only the live run does (ticket 38's log, F-012.md).

const here = path.dirname(fileURLToPath(import.meta.url));
const coreChild = path.resolve(here, "..", "..", "..", "apps", "core", "src", "testing", "restart-child.ts");
const SCALE = 10;
const AGENT_SCOPES = ["read", "write", "issues:create", "comments:create", "app:assignable", "app:mentionable"];

/** The fake Linear's clock: the wall clock, plus whatever the rehearsal sped it up by. */
const linkedClock = (): ManualClock & { readonly extra: () => number } => {
  let extra = 0;
  return {
    now: () => Date.now() + extra,
    set: (ms) => {
      extra = ms - Date.now();
    },
    advance: (ms) => {
      extra += ms;
    },
    extra: () => extra,
  };
};

let test: TestDatabase;
let fixture: IsolationFixture;
let github: FakeGitHub;
let linear: FakeLinear;
let jobs: Jobs;
let core: Replica | null = null;
let configDir = "";
let dataDir = "";
const clock = linkedClock();
const lines: string[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "test1", defaultBranch: "main", files: {}, branches: ["main"] }] });
  linear = await createFakeLinear({ clock });
  configDir = await mkdtemp(path.join(tmpdir(), "ostra-lam-config-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-lam-data-"));
}, 180_000);

afterAll(async () => {
  await core?.kill();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 }).catch(() => undefined);
  await github.close();
  await linear.close();
  await test.dispose();
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

describe("the Linear agent-mode harness's rehearsal (ticket 38)", () => {
  it(
    "F-012: the harness's four bullets pass against ostra's core on the fake Linear: the install, 50 delegations, a follow-up and a stop, and 35 silent minutes",
    async () => {
      const organizationId = fixture.a.organization.id;
      const projectId = fixture.a.openProject.id;
      const secretsKey = generateSecretsKey();
      const secretStore = openStore(test.db, secretsKey);
      const put = async (purpose: string, value: string): Promise<string> => {
        const stored = await secretStore.put({ organizationId, purpose }, value);
        if (!stored.ok) throw new Error("the store refused");
        return stored.value;
      };
      // The setup an organization's first run leaves: a model and the OpenCode profile, the App, a repo.
      const provider = await test.db.modelProvider.create({ data: { organizationId, name: "Dev", baseUrl: "https://models.example/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: await put("model-provider.token", "sk-rehearsal"), allowOnPersonalRunners: true } });
      await test.db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
      const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "dev-model-1" } });
      const profile = await test.db.agentProfile.create({ data: { organizationId, name: "OpenCode", adapter: "opencode", modelId: model.id, builtIn: true } });
      await test.db.project.update({ where: { id: projectId }, data: { defaultCodeProfileId: profile.id, name: "agent-mode-load" } });
      const app = await test.db.connection.create({ data: { organizationId, kind: "github", appId: github.appId, slug: github.appSlug, botName: "ostra-fake[bot]", botEmail: "1+ostra-fake[bot]@users.noreply.github.com", privateKeySecretRef: await put("github-app.private-key", github.privateKey) } });
      await seedInstallation(test.db, { organizationId, connectionId: app.id, installationId: github.installationId });
      await test.db.repo.create({ data: { organizationId, projectId, connectionId: app.id, installationId: github.installationId, hostRepoId: "101", fullName: "fake-org/test1", defaultBranch: "main", checkoutDir: "test1" } });

      // The Linear app, as Create and Authorize leave it, its webhook pointing at core's inbox.
      const port = await new Promise<number>((resolve, reject) => {
        void import("node:net").then(({ createServer }) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => {
              resolve(address !== null && typeof address === "object" ? address.port : 0);
            });
          });
        });
      });
      const connectionId = connectionIdSchema.parse(crypto.randomUUID());
      const linearApp = linear.createApp({ name: "ostra", redirectUris: ["https://ostra.example/oauth/linear/callback"], webhookUrl: `http://127.0.0.1:${String(port)}/webhooks/linear/${connectionId}` });
      const minted = linear.mintToken("app", AGENT_SCOPES);
      // The dev secrets' files, as the maintainer keeps them: the refresh token Authorize showed once.
      await writeFile(
        path.join(configDir, "linear.env"),
        [
          "# the test workspace",
          `LINEAR_API_KEY=${linear.adminApiKey}`,
          `LINEAR_CLIENT_ID=${linearApp.clientId}`,
          `LINEAR_CLIENT_SECRET=${linearApp.clientSecret}`,
          `LINEAR_WEBHOOK_SECRET=${linearApp.webhookSecret}`,
          `LINEAR_TEST_TEAM_ID=${linear.team.id}`,
          `LINEAR_REFRESH_TOKEN=${minted.refreshToken}`,
          `LINEAR_APP_CONNECTION_ID=${connectionId}`,
          "",
        ].join("\n"),
      );
      await writeFile(path.join(configDir, "tunnel.env"), `OSTRA_DEV_PUBLIC_URL=http://127.0.0.1:${String(port)}\n`);
      const settings = await harnessSettings({ OSTRA_DEV_CONFIG_DIR: configDir });
      if (settings.kind !== "live") throw new Error(`the settings: ${settings.kind}`);
      const live = settings.settings;

      // Before anything else: the refresh, and the rotated token written back in place.
      const rotated = await rotateAppToken({ clientId: live.LINEAR_CLIENT_ID, clientSecret: live.LINEAR_CLIENT_SECRET, refreshToken: live.LINEAR_REFRESH_TOKEN, linearEnvFile: live.linearEnvFile, tokenUrl: linear.tokenUrl });
      const written = await readFile(live.linearEnvFile, "utf8");
      expect(rotated.wroteBack).toBe(true);
      expect(written).toContain(`LINEAR_REFRESH_TOKEN=${rotated.tokens.refreshToken}\n`);
      expect(written).not.toContain(minted.refreshToken);
      expect(written).toContain("# the test workspace\n");

      const access: LinearAccess = { apiUrl: linear.apiUrl, apiKey: live.LINEAR_API_KEY, appToken: rotated.tokens.accessToken, teamId: live.LINEAR_TEST_TEAM_ID };
      const install = await readInstall(access, rotated.tokens.scopes);
      await seedAppConnection(
        { db: test.db, secretStore, organizationId },
        {
          connectionId: connectionIdSchema.parse(live.LINEAR_APP_CONNECTION_ID),
          clientId: live.LINEAR_CLIENT_ID,
          clientSecret: live.LINEAR_CLIENT_SECRET,
          webhookSecret: live.LINEAR_WEBHOOK_SECRET,
          accessToken: rotated.tokens.accessToken,
          refreshToken: rotated.tokens.refreshToken,
          expiresAt: rotated.tokens.expiresAt,
          scopes: rotated.tokens.scopes,
          appUser: { id: install.appUserId, name: install.appUserName },
          workspace: install.workspace,
        },
      );
      await seedAgentModeBoard({ db: test.db, organizationId, projectId }, { connectionId, team: { id: linear.team.id, key: linear.team.key, name: linear.team.name }, states: linear.states(linear.team.id) });

      core = await startReplica("core", {
        command: process.execPath,
        args: [coreChild],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && name !== "DATABASE_URL")),
          NODE_ENV: "test",
          DATABASE_URL: test.url,
          OSTRA_DATA_DIR: dataDir,
          OSTRA_SECRETS_KEY: secretsKey,
          OSTRA_CORE_PORT: String(port),
          OSTRA_PUBLIC_URL: "https://ostra.example",
          OSTRA_GITHUB_API_URL: github.apiUrl,
          OSTRA_CATALOG_FETCH: "false",
          OSTRA_LINEAR_HEARTBEAT_MINUTES: "1",
          CORE_TEST_LINEAR_API_URL: linear.apiUrl,
        },
        ready: (line) => typeof Reflect.get(Object(line), "listening") === "number",
        logFile: path.join(dataDir, "core.log"),
      });
      jobs = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
      await jobs.start();
      const world: OstraWorld = {
        db: test.db,
        jobs,
        secretStore,
        publicUrl: "https://ostra.example",
        organizationId,
        projectId,
        member: { memberId: fixture.a.member.id, userId: (await test.db.member.findUniqueOrThrow({ where: { id: fixture.a.member.id }, select: { userId: true } })).userId },
      };
      const made: string[] = [];
      const context: PhaseContext = {
        world,
        connectionId,
        access,
        appUserId: install.appUserId,
        keyUserEmail: install.adminEmail,
        delegations: 50,
        note: (line) => {
          lines.push(line);
        },
        made,
        // The script that stands in for a person: "Send stop request", by the admin.
        pressStop: async ({ externalSessionId }) => {
          await linear.promptSession(externalSessionId, "stop", { stop: true, byUserId: linear.admin.id });
        },
        stopWaitMs: 60_000,
        workingTurn: { description: "", runner: false },
        silentTurn: {
          description: "",
          linearElapsed: (startedAt) => clock.now() - startedAt,
          wait: async (linearMs) => {
            const steps = Math.max(1, Math.ceil(linearMs / 10_000));
            for (let step = 0; step < steps; step += 1) {
              const slice = linearMs / steps;
              await new Promise((resolve) => setTimeout(resolve, slice / SCALE));
              clock.advance(slice - slice / SCALE);
            }
          },
          end: async (taskId) => {
            await stopFromPanel(world, taskId);
          },
        },
      };
      const results = await runBullets(context, install);
      const outcomes = results.map((result) => `${result.bullet}: ${bulletOutcome(result.checks)}`);
      // Every check passes but one the rehearsal can't run: with no runner the follow-up's task waits
      // queued, and a queued task takes no message, so the follow-up has no turn to reach (live has one).
      const failing = results.flatMap((result) => result.checks.filter((one) => one.outcome === "fail").map((one) => `${one.name}: ${one.detail}`));
      expect(failing, lines.join("\n")).toEqual([]);
      const notRun = results.flatMap((result) => result.checks.filter((one) => one.outcome === "not-run").map((one) => one.name));
      expect(notRun).toEqual(["and reached the task as the member's message"]);
      expect(outcomes).toHaveLength(5);
      // 53 sessions in all: the 50, the follow-up's, the stop's and the silent one; every one but the follow-up's ended.
      const sessions = await readSessions(test.db, connectionId);
      expect(sessions).toHaveLength(53);
      expect(sessions.filter((session) => session.state !== "ended")).toHaveLength(1);
      // The log holds IDs, counts and times only: no token, no key, no ticket text.
      const log = lines.join("\n");
      for (const secret of [linear.adminApiKey, minted.refreshToken, rotated.tokens.refreshToken, rotated.tokens.accessToken, linearApp.clientSecret, linearApp.webhookSecret]) {
        expect(log.includes(secret)).toBe(false);
      }
      expect(z.string().parse(live.linearEnvFile)).toBe(path.join(configDir, "linear.env"));
    },
    10 * 60_000,
  );
});
