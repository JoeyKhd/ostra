import { readFile } from "node:fs/promises";

import { GitHubAdapter } from "@ostra/adapter-github";
import { contentPaths, lockfilePaths } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// The gated live case of ticket 31: `github.connectExisting` with the test App lists the
// `ostra-test` installation and `test1`. It runs only with `github.env` and `github-test.env`
// loaded (`set -a; . ~/.config/ostra-dev/github.env; set +a`), against the real GitHub adapter, and
// prints no key, token or secret. The webhook secret is a throwaway: nothing here receives hooks.

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_TEST_ORG: z.string().min(1),
  GITHUB_TEST_REPO: z.string().min(1),
});
const env = envSchema.safeParse(process.env);

describe.skipIf(!env.success)("the GitHub routers, live on the test App", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await createApiHarness();
    // The real adapter in place of the fake: everything else in the harness is unchanged.
    const adapter = new GitHubAdapter({ userAgent: "ostra-api-live-test/0.0.0" });
    Object.assign(harness.deps.ports.adapters, { codeHost: adapter });
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("connects the existing App, and lists its installation and test1", async () => {
    if (!env.success) {
      return;
    }
    const privateKey = await readFile(env.data.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    const admin = await harness.as(harness.fixture.a.admin);
    const connected = await admin.github.connectExisting({ appId: env.data.GITHUB_APP_ID, privateKey, webhookSecret: "live-test-webhook-secret" });
    expect(connected.permissions["checks"]).toBe("write");
    expect(connected.permissions["actions"]).toBe("read");

    const installations = await admin.github.installations();
    const installation = installations.find((candidate) => candidate.accountLogin === env.data.GITHUB_TEST_ORG);
    expect(installation).toBeDefined();
    if (installation === undefined) {
      return;
    }
    const repos = await admin.github.repos({ installationId: installation.installationId });
    expect(repos.map((repo) => repo.fullName)).toContain(`${env.data.GITHUB_TEST_ORG}/${env.data.GITHUB_TEST_REPO}`);
    expect(JSON.stringify([connected, installations, repos])).not.toContain("PRIVATE KEY");

    // Ticket 32's live case: a project on the test repo, with its environment drafted from the files
    // GitHub holds. Every reason names a file detection knows to read; what test1 holds is its own.
    const created = await admin.projects.create({
      name: "Live test",
      slug: "live-test",
      access: "open",
      repo: { connectionId: connected.connectionId, installationId: installation.installationId, fullName: `${env.data.GITHUB_TEST_ORG}/${env.data.GITHUB_TEST_REPO}` },
    });
    const known = new Set<string>([...contentPaths, ...lockfilePaths, "(the repo)"]);
    for (const reason of created.detection.reasons) {
      expect(known.has(reason.file), reason.file).toBe(true);
    }
    expect(created.detection.reasons.map((reason) => reason.file)).not.toContain("(the repo)");
    const environment = await admin.environments.get({ projectId: created.projectId });
    expect(environment.status).toBe("draft");
  });
});
