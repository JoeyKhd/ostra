import fs from "node:fs/promises";
import path from "node:path";
import { beyond, passBar } from "./criteria.ts";
import type { CriterionTitle } from "./criteria.ts";
import { dataDir, spikeRoot, toolEnv } from "./paths.ts";
import { killTree, processIsAlive, runProcess } from "./proc.ts";

// `pnpm mutation-check`: shows that the harness can fail. Each mutation breaks
// one protection the spike claims (removes a filter, a guard, a constraint, a
// pin), runs `pnpm spike` on it, and requires the criterion that depends on it
// to turn FAIL. A criterion that stayed PASS with its protection removed would be
// a PASS that proves nothing.
//
// Every mutation runs on a COPY of the spike (`.data/mutation-<pid>-<n>/`, with
// `node_modules` linked in), never on the real files: a commit, a typecheck or a
// session of anyone else sharing this checkout cannot see mutated code. The copy
// is deleted afterwards, and any left by a killed run are deleted at the next start.

type Mutation = {
  readonly name: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** The row that must FAIL. */
  readonly mustFail: CriterionTitle;
};

const FK_LINE =
  'ALTER TABLE "task" ADD CONSTRAINT "task_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;';
const MEMBER_UNIQUE = 'CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");';
const MIGRATION = "prisma/migrations/20261118000000_init/migration.sql";

const mutations: readonly Mutation[] = [
  // ---- A broken type, a loosened pin, a missing table ----------------------------
  {
    name: "a type error is introduced",
    file: "src/ids.ts",
    from: "export type TaskId = z.infer<typeof TaskId>;",
    to: 'export type TaskId = z.infer<typeof TaskId>;\nexport const brokenOnPurpose: number = "a";',
    mustFail: passBar.typecheck,
  },
  {
    name: "better-auth is pinned with a range",
    file: "package.json",
    from: '"better-auth": "1.7.25"',
    to: '"better-auth": "^1.7.25"',
    mustFail: passBar.pinned,
  },
  {
    name: "the user table is missing from the migration",
    file: MIGRATION,
    from: 'CREATE TABLE "user" (',
    to: 'CREATE TABLE "user_dropped_by_mutation" (',
    mustFail: passBar.prismaOnPostgres,
  },
  // ---- Accounts ------------------------------------------------------------------
  {
    name: "an account may be created without a username",
    file: "src/auth/create-auth.ts",
    from: `if (typeof name !== "string" || name.trim() === "") {`,
    to: `if (typeof name !== "string" && Number.isNaN(0)) {`,
    mustFail: passBar.signUp,
  },
  {
    name: "usernames are no longer normalised, so sign-in by username is case-sensitive",
    file: "src/auth/create-auth.ts",
    from: "        maxUsernameLength: 32,",
    to: "        maxUsernameLength: 32,\n        usernameNormalization: false,",
    mustFail: passBar.signIn,
  },
  // ---- Invitations ---------------------------------------------------------------
  {
    name: "sign-up is open to strangers",
    file: "src/auth/create-auth.ts",
    from: "        if (settings.openAccountSignup) {",
    to: "        if (settings.openAccountSignup || !Number.isNaN(0)) {",
    mustFail: passBar.inviteLink,
  },
  {
    name: "an invited address alone admits a sign-up, with no invitation ID",
    file: "src/auth/create-auth.ts",
    from: 'if (typeof email === "string" && invitationId.success) {',
    to: 'if (typeof email === "string") {',
    mustFail: passBar.inviteLink,
  },
  {
    name: "an invitation ID admits a sign-up whatever address it was made for",
    file: "src/auth/create-auth.ts",
    from: "              email: email.toLowerCase(),\n              status: \"pending\",",
    to: '              status: "pending",',
    mustFail: passBar.inviteLink,
  },
  {
    name: "an invitation may name the owner role",
    file: "src/auth/create-auth.ts",
    from: `          beforeCreateInvitation: ({ invitation }) => {
            assertOrganizationRole(invitation.role);`,
    to: `          beforeCreateInvitation: ({ invitation }) => {
            void invitation;`,
    mustFail: passBar.inviteLink,
  },
  // ---- Memberships ---------------------------------------------------------------
  {
    name: "the unique (organization, user) membership index is dropped",
    file: MIGRATION,
    from: MEMBER_UNIQUE,
    to: "SELECT 1;",
    mustFail: passBar.twoOrganizations,
  },
  // ---- Reset links ---------------------------------------------------------------
  {
    name: "any signed-in user may create a reset link",
    file: "src/ostra/admin-actions.ts",
    from: "  if (!permission.success) {",
    to: "  if (!permission.success && Number.isNaN(0)) {",
    mustFail: passBar.resetLink,
  },
  // ---- Runners -------------------------------------------------------------------
  {
    name: "any OAuth client may ask for a device code",
    file: "src/auth/create-auth.ts",
    from: "validateClient: (clientId) => clientId === RUNNER_CLIENT_ID,",
    to: "validateClient: () => true,",
    mustFail: passBar.deviceCode,
  },
  // ---- Isolation -----------------------------------------------------------------
  {
    name: "a scoped read forgets the organization filter",
    file: "src/ostra/work-store.ts",
    from: `where: { organizationId: scope.organizationId },
      select: { id: true, organizationId: true, name: true },
      orderBy: { createdAt: "asc" },`,
    to: `select: { id: true, organizationId: true, name: true },
      orderBy: { createdAt: "asc" },`,
    mustFail: passBar.isolation,
  },
  {
    name: "the guard no longer checks membership",
    file: "src/ostra/organization-scope.ts",
    from: "  if (member === null) {",
    to: "  if (member === null && Number.isNaN(0)) {",
    mustFail: passBar.isolation,
  },
  {
    name: "the composite foreign key is dropped from the database",
    file: MIGRATION,
    from: FK_LINE,
    to: "SELECT 1;",
    mustFail: passBar.isolation,
  },
  // ---- The contract and the first account ----------------------------------------
  {
    name: "a better-auth column is missing from the migration",
    file: MIGRATION,
    from: '    "banReason" TEXT,',
    to: "",
    mustFail: passBar.contractTest,
  },
  {
    name: "the first account is not made instance admin",
    file: "src/db/bootstrap.ts",
    from: "    if (admins === 0) {",
    to: "    if (admins === 0 && Number.isNaN(0)) {",
    mustFail: beyond.firstAccount,
  },
];

/** How many runs go at once. Each has its own copy, its own Postgres on its own port, and its own `.data`. */
const CONCURRENCY = 3;

const copiedEntries = [
  "src",
  "prisma",
  "test",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "prisma.config.ts",
  "auth-cli.ts",
  "eslint.config.mjs",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

const copyPrefix = "mutation-";

/** Deletes a copy. The `node_modules` link goes first, on its own, so nothing is ever deleted through it. */
const removeCopy = async (directory: string): Promise<void> => {
  await fs.rm(path.join(directory, "node_modules"), { force: true });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
};

/** Copies left by a run that was killed: their owner is gone. */
const removeStaleCopies = async (): Promise<void> => {
  let entries: string[];
  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const owner = Number.parseInt(/^mutation-(\d+)-/.exec(entry)?.[1] ?? "", 10);
    if (entry.startsWith(copyPrefix) && Number.isInteger(owner) && !processIsAlive(owner)) {
      await removeCopy(path.join(dataDir, entry));
      console.log(`removed ${entry}, left by a run that was killed`);
    }
  }
};

const makeCopy = async (slot: number): Promise<string> => {
  const directory = path.join(dataDir, `${copyPrefix}${String(process.pid)}-${String(slot)}`);
  await fs.mkdir(directory, { recursive: true });
  for (const entry of copiedEntries) {
    await fs.cp(path.join(spikeRoot, entry), path.join(directory, entry), { recursive: true });
  }
  await fs.symlink(path.join(spikeRoot, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return directory;
};

const failedTitles = (output: string): string[] =>
  output.split("\n").flatMap((line) => {
    const match = /^\s+FAIL\s+(.*?)\s+\(\d+ ms\)\s*$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });

type Outcome = { readonly mutation: Mutation; readonly caught: boolean; readonly failed: string[]; readonly finished: boolean };

/** The harness runs being waited on, so an interrupt can end them (and the Postgres each one started). */
const running = new Set<number>();

const runMutation = async (mutation: Mutation, directory: string): Promise<Outcome> => {
  const target = path.join(directory, mutation.file);
  const original = await fs.readFile(target, "utf8");
  if (!original.includes(mutation.from)) {
    throw new Error(`mutation "${mutation.name}" no longer matches ${mutation.file}; update src/mutation-check.ts`);
  }
  await fs.writeFile(target, original.replace(mutation.from, mutation.to));
  let started: number | undefined;
  const result = await runProcess(process.execPath, ["src/spike.ts", "--mutation-run"], {
    cwd: directory,
    env: toolEnv({}),
    timeoutMs: 400_000,
    onStart: (pid) => {
      started = pid;
      running.add(pid);
    },
  });
  if (started !== undefined) {
    running.delete(started);
  }
  const failed = failedTitles(result.stdout);
  return {
    mutation,
    caught: failed.includes(mutation.mustFail),
    failed,
    finished: result.stdout.includes("pass bar:"),
  };
};

const main = async (): Promise<void> => {
  // Every mutation must still match the file it edits, before anything is started.
  for (const mutation of mutations) {
    const content = await fs.readFile(path.join(spikeRoot, mutation.file), "utf8");
    if (!content.includes(mutation.from)) {
      throw new Error(`mutation "${mutation.name}" no longer matches ${mutation.file}; update src/mutation-check.ts`);
    }
  }
  await fs.mkdir(dataDir, { recursive: true });
  await removeStaleCopies();
  console.log(`mutation check: each protection is removed in turn, on a copy; the row that depends on it must FAIL`);

  const outcomes: Outcome[] = [];
  const queue = [...mutations];
  const copies: string[] = [];
  const worker = async (slot: number): Promise<void> => {
    const directory = await makeCopy(slot);
    copies.push(directory);
    for (let mutation = queue.shift(); mutation !== undefined; mutation = queue.shift()) {
      // Each mutation starts from untouched files.
      for (const entry of copiedEntries) {
        await fs.rm(path.join(directory, entry), { recursive: true, force: true });
        await fs.cp(path.join(spikeRoot, entry), path.join(directory, entry), { recursive: true });
      }
      const outcome = await runMutation(mutation, directory);
      outcomes.push(outcome);
      console.log(`  ${outcome.caught ? "CAUGHT" : "MISSED"}  ${mutation.name}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, mutations.length) }, (_, slot) => worker(slot)));
  } finally {
    for (const directory of copies) {
      await removeCopy(directory);
    }
  }

  console.log("");
  let uncaught = 0;
  for (const mutation of mutations) {
    const outcome = outcomes.find((candidate) => candidate.mutation === mutation);
    if (outcome === undefined) {
      continue;
    }
    console.log(`  ${outcome.caught ? "CAUGHT  " : "MISSED  "} ${mutation.name}`);
    console.log(
      `           expected FAIL: "${mutation.mustFail}"; failing rows: ${outcome.failed.length === 0 ? "none" : outcome.failed.map((title) => `"${title}"`).join(", ")}${outcome.finished ? "" : " (the harness did not reach its summary)"}`,
    );
    if (!outcome.caught) {
      uncaught += 1;
    }
  }
  console.log(`${String(mutations.length - uncaught)} of ${String(mutations.length)} mutations caught`);

  // The pass bar's rows that no mutation targets: a PASS there has not been shown able to fail.
  const targeted = new Set<string>(mutations.map((mutation) => mutation.mustFail));
  const passBarTitles = Object.values(passBar);
  const untargeted = passBarTitles.filter((title) => !targeted.has(title));
  console.log(`${String(passBarTitles.length - untargeted.length)} of ${String(passBarTitles.length)} pass-bar rows have a mutation`);
  for (const title of untargeted) {
    console.log(`  no mutation for: "${title}"`);
  }
  process.exitCode = uncaught === 0 && untargeted.length === 0 ? 0 : 1;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // The copies are left for the next start to remove: nothing in them is the real spike.
    void Promise.all([...running].map((pid) => killTree(pid))).finally(() => {
      process.exit(130);
    });
  });
}

await main();
