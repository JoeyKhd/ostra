import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SmtpEmailAdapter } from "@ostra/adapter-email-smtp";
import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { renderInvitationMail } from "@ostra/domain";
import { seedMember, seedOrganization } from "@ostra/domain/testing";
import { organizationIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { linkGitHubForDev } from "./link-github.ts";
import { newestMailTo } from "./mail-box.ts";
import { startMailSink } from "./mail-sink.ts";

// Ticket 40: the dev mail sink and the dev GitHub link, the demo's tools (F-002, F-104, F-115).

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const temporaryDirs: string[] = [];
const tempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `ostra-${label}-`));
  temporaryDirs.push(dir);
  return dir;
};

afterAll(async () => {
  for (const dir of temporaryDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the dev mail sink", () => {
  it("F-115: stores a mail milestone 3's SMTP adapter sent, and the helper finds its link", async () => {
    const dir = await tempDir("mail-sink");
    const sink = await startMailSink({ dir, port: 0 });
    const adapter = new SmtpEmailAdapter({ host: sink.host, port: sink.port, secure: "none", from: "ostra@mail.localhost" }, { logger: silentLogger, clock: { now: () => Date.now() } });
    const link = "http://localhost:3812/invite/inv-0123456789abcdef0123456789abcdef";
    try {
      const rendered = renderInvitationMail({ organizationName: "Acme", inviterName: "Ada", address: "new.member@example.com", link, expiresAt: Date.now() + 7 * 86_400_000, publicUrl: "http://localhost:3812" });
      const sent = await adapter.send({
        category: "account",
        kind: "invitation",
        organizationId: organizationIdSchema.parse("org-sink"),
        title: rendered.subject,
        body: rendered.subject,
        url: link,
        idempotencyKey: "account-mail:invitation:inv-1",
        subject: "Acme",
        to: { email: "sam@example.com", memberId: null },
        rendered,
      });
      expect(sent).toMatchObject({ ok: true });
      await sink.flushed();
      expect((await readdir(dir)).filter((name) => name.endsWith(".eml"))).toHaveLength(1);
      const mail = await newestMailTo("Sam@Example.com", dir);
      expect(mail?.subject).toBe(rendered.subject);
      expect(mail?.links).toContain(link);
      // Another address finds nothing.
      expect(await newestMailTo("rae@example.com", dir)).toBeNull();
    } finally {
      adapter.close();
      await sink.close();
    }
  });

  it("F-115: the newest of two mails to one address is the one the helper returns", async () => {
    const dir = await tempDir("mail-sink-two");
    const sink = await startMailSink({ dir, port: 0 });
    const adapter = new SmtpEmailAdapter({ host: sink.host, port: sink.port, secure: "none", from: "ostra@mail.localhost" }, { logger: silentLogger, clock: { now: () => Date.now() } });
    try {
      for (const id of ["first-0123456789", "second-0123456789"]) {
        const link = `http://localhost:3812/invite/${id}`;
        const rendered = renderInvitationMail({ organizationName: "Acme", inviterName: "Ada", address: "new.member@example.com", link, expiresAt: Date.now() + 86_400_000, publicUrl: "http://localhost:3812" });
        const sent = await adapter.send({
          category: "account",
          kind: "invitation",
          organizationId: organizationIdSchema.parse("org-sink"),
          title: rendered.subject,
          body: rendered.subject,
          url: link,
          idempotencyKey: `account-mail:invitation:${id}`,
          subject: "Acme",
          to: { email: "sam@example.com", memberId: null },
          rendered,
        });
        expect(sent).toMatchObject({ ok: true });
        await sink.flushed();
      }
      const mail = await newestMailTo("sam@example.com", dir);
      expect(mail?.links).toContain("http://localhost:3812/invite/second-0123456789");
      expect(mail?.links).not.toContain("http://localhost:3812/invite/first-0123456789");
    } finally {
      adapter.close();
      await sink.close();
    }
  });
});

describe("the dev GitHub link", () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await createTestDatabase();
  });
  afterAll(async () => {
    await test.dispose();
  });

  it("F-104: writes the account's GitHub link as F-119's callback would, with an audit entry naming the dev tool", async () => {
    const organization = await seedOrganization(test.db, { name: "Dev link" });
    const seeded = await seedMember(test.db, { username: "rae", email: "rae@example.com", password: "a-password", role: "member", organizationId: organization.organizationId });
    if (!seeded.ok) {
      throw new Error(seeded.message);
    }
    const asked: { url: string; authorization: string | null }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      asked.push({ url: input instanceof Request ? input.url : String(input), authorization: headers.get("authorization") });
      return Promise.resolve(Response.json({ id: 4_242_001, login: "Rae-Reviewer" }));
    };
    const result = await linkGitHubForDev(
      { db: test.db, env: { NODE_ENV: "test" }, fetch: fakeFetch, apiUrl: "https://github.example/api", token: "ghp_test_token_0123456789", now: () => Date.UTC(2026, 10, 19) },
      { username: "rae", githubLogin: "rae-reviewer" },
    );
    expect(result).toEqual({ ok: true, githubUserId: "4242001", githubLogin: "Rae-Reviewer", audited: 1 });
    expect(asked).toEqual([{ url: "https://github.example/api/users/rae-reviewer", authorization: "Bearer ghp_test_token_0123456789" }]);
    const account = await test.db.user.findUniqueOrThrow({ where: { id: seeded.seeded.userId }, select: { githubUserId: true, githubLogin: true, githubLinkedAt: true } });
    expect(account).toEqual({ githubUserId: "4242001", githubLogin: "Rae-Reviewer", githubLinkedAt: new Date(Date.UTC(2026, 10, 19)) });
    const entries = await test.db.auditEntry.findMany({ where: { organizationId: organization.organizationId, action: "github.linked" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityId).toBe(seeded.seeded.memberId);
    expect(entries[0]?.data).toEqual({ githubUserId: "4242001", via: "dev:link-github" });
    // The token reached GitHub's request only, never a row.
    expect(JSON.stringify(entries)).not.toContain("ghp_test_token");
  });

  it("F-104: refuses outside development and test, and writes nothing", async () => {
    const organization = await seedOrganization(test.db, { name: "Dev link prod" });
    const seeded = await seedMember(test.db, { username: "sam", email: "sam@example.com", password: "a-password", role: "member", organizationId: organization.organizationId });
    if (!seeded.ok) {
      throw new Error(seeded.message);
    }
    const result = await linkGitHubForDev(
      { db: test.db, env: { NODE_ENV: "production" }, fetch: () => Promise.reject(new Error("never asked")), apiUrl: "https://github.example/api", token: null, now: () => Date.now() },
      { username: "sam", githubLogin: "sam" },
    );
    expect(result).toMatchObject({ ok: false, error: "not-development" });
    expect((await test.db.user.findUniqueOrThrow({ where: { id: seeded.seeded.userId } })).githubUserId).toBeNull();
  });
});

describe("both tools stay out of production", () => {
  it("F-104: dev:link-github and dev:mail-sink refuse to run with NODE_ENV=production", async () => {
    for (const script of ["dev-link-github.ts", "dev-mail-sink.ts"]) {
      const outcome = await run(process.execPath, [path.join(here, script), "rae", "rae-reviewer"], { env: { ...process.env, NODE_ENV: "production" } }).then(
        () => ({ code: 0, stderr: "" }),
        (error: unknown) => ({ code: Number(Reflect.get(Object(error), "code")), stderr: String(Reflect.get(Object(error), "stderr")) }),
      );
      expect(outcome.code, script).toBe(1);
      expect(outcome.stderr, script).toMatch(/runs only when NODE_ENV is development or test/);
    }
  });

  it("F-104: neither script is in the production build's file list", async () => {
    // The server image is built from `turbo prune @ostra/core @ostra/web --docker` (deploy/Dockerfile.server).
    const out = await tempDir("prune");
    // turbo's own launcher, run by this Node: no shell, so no quoting of the arguments.
    await run(process.execPath, [path.join(repoRoot, "node_modules", "turbo", "bin", "turbo"), "prune", "@ostra/core", "@ostra/web", "--docker", "--out-dir", out], { cwd: repoRoot });
    const files = (await readdir(out, { recursive: true })).map((file) => file.replaceAll("\\", "/"));
    expect(files.some((file) => file.includes("apps/core/src"))).toBe(true);
    expect(files.filter((file) => /dev-mail-sink|dev-link-github|mail-sink|link-github|dev-tools/.test(file))).toEqual([]);
  }, 120_000);
});
