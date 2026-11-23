// What the new repo's draft spec needs (F-112/c1, Q345 option (b), `28-environment-repo-draft.spec.ts`),
// in the throwaway e2e database only. Run as `node e2e/seed-repo-draft-world.ts '<json>'`; prints
// one JSON line.
//
// The target's world (environment-repo-draft.md, "Demo data"): an organization admin Alex Kim and a
// member Sam Rivera, and a project `calculator` whose environment a project admin saved 2 hours ago
// over two repos, `acme/calculator-web` and `acme/calculator-api`, each with its own branch of the
// setup's `case` (or, with `plain`, one plain script for both), their variables, secrets and file,
// and a ready snapshot built on `build-01`. Then Alex Kim added `acme/calculator-engine` 20 minutes
// ago, and its draft waits beside the saved setup: detection's own reading (`detectEnvironment`) of
// its `uv.lock`, `.python-version` and `.env.example`, as `projects.addRepo` stores it. `docs` adds
// `acme/calculator-docs`, where detection finds nothing, and `mobile` adds `acme/calculator-mobile`
// (a Node repo on pnpm) after it. The repos' GitHub is rows only: the spec reads nothing from it.

import { randomBytes } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { detectedEnvironmentSchema, detectEnvironment, seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  password: z.string(),
  tag: z.string().regex(/^[a-z0-9-]{1,24}$/),
  plain: z.boolean().default(false),
  docs: z.boolean().default(false),
  mobile: z.boolean().default(false),
});
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const first = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = first.organizationId;
const HOUR = 3_600_000;
const now = Date.now();

const memberOf = async (username: string, name: string, role: "admin" | "member") => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.update({ where: { username }, data: { name } });
  return db.member.findFirstOrThrow({ where: { userId: user.id, organizationId } });
};

const admin = await memberOf(`draft-${args.tag}`, "Alex Kim", "admin");
await memberOf(`draft-${args.tag}-member`, "Sam Rivera", "member");

const github =
  (await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } })) ??
  (await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-draft-${args.tag}`, slug: `e2e-draft-${args.tag}`, state: "active" } }));
const installation =
  (await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id }, orderBy: { createdAt: "asc" } })) ??
  (await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: `inst-draft-${args.tag}`, accountLogin: "acme", accountKind: "organization" } }));

const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `calculator-${args.tag}`, access: "open" } });
const repoOf = (fullName: string, position: number, createdAt: Date) =>
  db.repo.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: github.id,
      installationId: installation.installationId,
      hostRepoId: `e2e-draft-${args.tag}-${fullName}`,
      fullName,
      defaultBranch: "main",
      checkoutDir: fullName.split("/")[1] ?? fullName,
      position,
      createdAt,
    },
  });
const savedAt = new Date(now - 2 * HOUR);
const web = await repoOf("acme/calculator-web", 0, new Date(now - 30 * 24 * HOUR));
const api = await repoOf("acme/calculator-api", 1, new Date(now - 29 * 24 * HOUR));

const caseScript = [
  "set -euo pipefail",
  'case "$OSTRA_REPO" in',
  "  'acme/calculator-web')",
  "    corepack enable",
  "    pnpm install --frozen-lockfile",
  "    pnpm prisma generate",
  "    ;;",
  "  'acme/calculator-api')",
  "    corepack enable",
  "    pnpm install --frozen-lockfile",
  "    ;;",
  "esac",
  "",
].join("\n");
const plainScript = ["corepack enable", "pnpm install --frozen-lockfile", "pnpm prisma generate", ""].join("\n");
const environment = await db.environment.create({
  data: { organizationId, projectId: project.id, status: "saved", setupScript: args.plain ? plainScript : caseScript, savedAt, savedByMemberId: admin.id, createdAt: savedAt },
});
const base = { organizationId, projectId: project.id, environmentId: environment.id };
// 5 variables, 3 secrets and a file; a secret's reference names nothing stored (none is read here).
const secret = () => `builtin:e2e-draft-${randomBytes(6).toString("hex")}`;
await db.environmentEntry.createMany({
  data: [
    { ...base, repoId: web.id, kind: "variable", name: "NODE_ENV", value: "development" },
    { ...base, repoId: web.id, kind: "secret", name: "DATABASE_URL", secretRef: secret() },
    { ...base, repoId: web.id, kind: "variable", name: "PUBLIC_API_URL", value: "http://localhost:4000" },
    { ...base, repoId: web.id, kind: "secret", name: "SESSION_SECRET", secretRef: secret() },
    { ...base, repoId: web.id, kind: "file", path: "config/local.json", value: "{}\n" },
    { ...base, repoId: api.id, kind: "variable", name: "PORT", value: "4000" },
    { ...base, repoId: api.id, kind: "variable", name: "LOG_LEVEL", value: "debug" },
    { ...base, repoId: api.id, kind: "variable", name: "CORS_ORIGIN", value: "http://localhost:3000" },
    { ...base, repoId: api.id, kind: "secret", name: "REDIS_URL", secretRef: secret() },
  ],
});

// A ready snapshot built on `build-01`, a `docker` runner of the project's pool.
const poolId = (await db.runnerPool.findFirstOrThrow({ where: { organizationId, isDefault: true }, select: { id: true } })).id;
await db.projectPool.create({ data: { organizationId, projectId: project.id, poolId, position: 0 } });
const builder =
  (await db.runner.findFirst({ where: { organizationId, name: "build-01" }, select: { id: true } })) ??
  (await db.runner.create({ data: { organizationId, kind: "pool", poolId, name: "build-01", publicKey: randomBytes(32).toString("base64url"), executor: "docker", capacity: 4, version: "0.0.0", state: "online" }, select: { id: true } }));
await db.snapshot.create({
  data: { ...base, reason: "environment-changed", state: "ready", runnerId: builder.id, digest: `sha256:7b21c0d${"3".repeat(57)}`, imageRef: "ostra-snapshot/calculator", buildDurationMs: 148_000, secretScan: "passed", readyAt: savedAt, createdAt: new Date(savedAt.getTime() - 148_000) },
});

/** A repo added after the save, and its draft as `projects.addRepo` stores it: detection's reading of its files. */
const added = async (fullName: string, position: number, minutesAgo: number, files: ReadonlyMap<string, string>) => {
  const at = new Date(now - minutesAgo * 60_000);
  const repo = await repoOf(fullName, position, at);
  const detection = detectEnvironment({ tree: [...files.keys()], files });
  await db.environmentRepoDraft.create({ data: { ...base, repoId: repo.id, createdByMemberId: admin.id, createdAt: at, detection: detectedEnvironmentSchema.parse(detection) } });
  return repo.id;
};
const engine = await added("acme/calculator-engine", 2, 20, new Map([["uv.lock", "version = 1\n"], [".python-version", "3.12\n"], [".env.example", "ENGINE_LOG_LEVEL=info\nENGINE_API_KEY=\n"]]));
const docs = args.docs ? await added("acme/calculator-docs", 3, 15, new Map([["README.md", "# docs\n"]])) : null;
const mobile = args.mobile ? await added("acme/calculator-mobile", 4, 10, new Map([["package.json", '{"name":"mobile","packageManager":"pnpm@10.4.1"}'], ["pnpm-lock.yaml", "lockfileVersion: 9\n"]])) : null;

process.stdout.write(`${JSON.stringify({ username: `draft-${args.tag}`, memberUsername: `draft-${args.tag}-member`, projectId: project.id, engineRepoId: engine, docsRepoId: docs, mobileRepoId: mobile })}\n`);
await db.$disconnect();
