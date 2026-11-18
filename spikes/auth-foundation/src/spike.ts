import os from "node:os";
import * as z from "zod";
import { runContractTest } from "./checks/contract-test.ts";
import { noProcessLeftBehind } from "./checks/leftovers.ts";
import { eslintCheck, installedVersion, pinnedVersions, scanSource, typecheck } from "./checks/static-checks.ts";
import type { Skipped } from "./checks/static-checks.ts";
import { beyond, passBar } from "./criteria.ts";
import type { CriterionTitle } from "./criteria.ts";
import { generateClient } from "./db/migrate.ts";
import { startDatabaseServer } from "./db/provision-database.ts";
import type { DatabaseServer } from "./db/provision-database.ts";
import { readSpikeEnv } from "./env.ts";

// `pnpm spike`: runs every pass-bar criterion of spike 9 that can run here and
// prints PASS, FAIL or SKIPPED for each. A criterion that needs an input this
// machine lacks is SKIPPED, with the input named; it is never reported as PASS.
// A criterion that could not run because an earlier step failed is a FAIL that
// says so ("not run: ..."): every row of the pass bar is always in the table.
//
// Exit status: 1 if anything FAILED, else 0.
//
// `--mutation-run` is for `pnpm mutation-check` only: the source-rule rows (ESLint,
// the scan) are left out, because none of the mutations can change them.

type Outcome = "PASS" | "FAIL" | "SKIPPED";
type Section = "pass-bar" | "beyond";
type Row = {
  readonly section: Section;
  readonly title: CriterionTitle;
  readonly outcome: Outcome;
  readonly detail: string;
  readonly ms: number;
};

const mutationRun = process.argv.includes("--mutation-run");

const rows: Row[] = [];
const cleanups: (() => Promise<void>)[] = [];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const passBarTitles: readonly string[] = Object.values(passBar);
const sectionOf = (title: CriterionTitle): Section => (passBarTitles.includes(title) ? "pass-bar" : "beyond");

const record = (row: Row): void => {
  rows.push(row);
  console.log(`  ${row.outcome.padEnd(8)} ${row.title}  (${String(row.ms)} ms)`);
  for (const line of row.detail.split("\n")) {
    console.log(`           ${line}`);
  }
};

const check = async (title: CriterionTitle, work: () => Promise<string | Skipped>): Promise<void> => {
  const started = Date.now();
  const section = sectionOf(title);
  try {
    const result = await work();
    if (typeof result === "string") {
      record({ section, title, outcome: "PASS", detail: result, ms: Date.now() - started });
    } else {
      record({ section, title, outcome: "SKIPPED", detail: `needs ${result.skipped}`, ms: Date.now() - started });
    }
  } catch (error) {
    record({ section, title, outcome: "FAIL", detail: messageOf(error), ms: Date.now() - started });
  }
};

const skip = (title: CriterionTitle, needs: string): void => {
  record({ section: sectionOf(title), title, outcome: "SKIPPED", detail: `needs ${needs}`, ms: 0 });
};

/** A row that could not run because the step it stands on did not pass. It is a FAIL, never a gap in the table. */
const blocked = (title: CriterionTitle, by: string): void => {
  record({ section: sectionOf(title), title, outcome: "FAIL", detail: `not run: ${by} did not pass`, ms: 0 });
};

const recorded = (title: CriterionTitle): boolean => rows.some((row) => row.title === title);

const blockUnrecorded = (titles: readonly CriterionTitle[], by: string): void => {
  for (const title of titles) {
    if (!recorded(title)) {
      blocked(title, by);
    }
  }
};

/** The rows that need a database with the schema applied and better-auth over it. */
const needsWorld = [
  passBar.signUp,
  passBar.signIn,
  passBar.inviteLink,
  passBar.twoOrganizations,
  passBar.resetLink,
  passBar.deviceCode,
  passBar.isolation,
  beyond.roles,
  beyond.firstAccount,
] as const;

const heading = (text: string): void => {
  console.log("");
  console.log(text);
};

const shutdown = async (): Promise<void> => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.log(`  cleanup problem: ${messageOf(error)}`);
    }
  }
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => {
      process.exit(130);
    });
  });
}

const countRowsSchema = z.array(z.object({ n: z.bigint() }));

const main = async (): Promise<void> => {
  const env = readSpikeEnv(process.env);
  const versions = {
    betterAuth: await installedVersion("better-auth"),
    prisma: await installedVersion("prisma"),
    client: await installedVersion("@prisma/client"),
    adapterPg: await installedVersion("@prisma/adapter-pg"),
    pg: await installedVersion("pg"),
    typescript: await installedVersion("typescript"),
  };

  console.log("ostra spike 9: auth-foundation");
  console.log("question: does better-auth give ostra organizations, usernames and runner sign-in on its stack?");
  console.log(
    `better-auth ${versions.betterAuth} | prisma ${versions.prisma} (client ${versions.client}, adapter-pg ${versions.adapterPg}) | pg ${versions.pg} | typescript ${versions.typescript}`,
  );
  console.log(`node ${process.version} | ${os.platform()} ${os.release()} | ${new Date().toISOString().slice(0, 10)}`);

  // ---- Build steps every later criterion needs ----------------------------------
  heading("Preparing");
  const generated = await generateClient();
  console.log(`  prisma generate: ${generated.ok ? "ok" : "FAILED"}`);
  if (!generated.ok) {
    record({
      section: "pass-bar",
      title: passBar.prismaOnPostgres,
      outcome: "FAIL",
      detail: `prisma generate failed: ${generated.detail}`,
      ms: 0,
    });
  }

  heading("Pass bar (context/build-order.md, milestone 0, spike 9)");

  // The typecheck needs the generated client; the pin does not.
  if (generated.ok) {
    await check(passBar.typecheck, typecheck);
  } else {
    blocked(passBar.typecheck, "prisma generate");
  }
  await check(passBar.pinned, pinnedVersions);

  // ---- One Postgres, one installed instance ---------------------------------------
  let server: DatabaseServer | undefined;
  if (generated.ok) {
    try {
      server = await startDatabaseServer(env);
    } catch (error) {
      record({
        section: "pass-bar",
        title: passBar.prismaOnPostgres,
        outcome: "FAIL",
        detail: `no database to run on: ${messageOf(error)}`,
        ms: 0,
      });
    }
  }

  if (server === undefined) {
    blockUnrecorded(needsWorld, passBar.prismaOnPostgres);
  } else {
    const runningServer = server;
    cleanups.push(() => runningServer.stop());
    const { openWorld } = await import("./scenarios/world.ts");
    const { signUpScenario, signInScenario } = await import("./scenarios/accounts.ts");
    const { inviteLinkScenario, twoOrganizationsScenario, rolesScenario } = await import("./scenarios/organizations.ts");
    const { resetLinkScenario } = await import("./scenarios/reset-link.ts");
    const { deviceCodeScenario } = await import("./scenarios/device-code.ts");
    const { isolationScenario } = await import("./scenarios/isolation.ts");
    const { firstAccountScenario } = await import("./scenarios/first-account.ts");

    const database = await runningServer.createDatabase();
    cleanups.push(() => database.dispose());

    let opened: Awaited<ReturnType<typeof openWorld>> | undefined;
    await check(passBar.prismaOnPostgres, async () => {
      for (const [name, version] of [
        ["prisma", versions.prisma],
        ["@prisma/client", versions.client],
        ["@prisma/adapter-pg", versions.adapterPg],
      ] as const) {
        if (!version.startsWith("7.")) {
          throw new Error(`${name} is ${version}, not Prisma 7`);
        }
      }
      opened = await openWorld({
        database,
        deviceInterval: "1s",
        ...(env.BETTER_AUTH_SECRET === undefined ? {} : { secret: env.BETTER_AUTH_SECRET }),
      });
      const { auth, prisma, tag } = opened.world;

      // A read through better-auth's Prisma adapter...
      const probe = await auth.api.isUsernameAvailable({ body: { username: "nobody_has_this" } });
      if (!probe.available) {
        throw new Error("better-auth could not read the database through its Prisma adapter");
      }
      // ...and a write: a row created, found and consumed (read and deleted) by better-auth itself.
      const { internalAdapter } = await auth.$context;
      const identifier = `spike-probe-${tag}`;
      await internalAdapter.createVerificationValue({
        identifier,
        value: "probe",
        expiresAt: new Date(Date.now() + 60_000),
      });
      if ((await internalAdapter.findVerificationValue(identifier)) === null) {
        throw new Error("better-auth wrote a row through its Prisma adapter and could not read it back");
      }
      if ((await internalAdapter.consumeVerificationValue(identifier)) === null) {
        throw new Error("better-auth could not consume the row it wrote");
      }
      if ((await internalAdapter.findVerificationValue(identifier)) !== null) {
        throw new Error("a consumed row is still there");
      }

      const tables = countRowsSchema.parse(
        await prisma.$queryRaw`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const migrations = countRowsSchema.parse(
        await prisma.$queryRaw`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
      );
      return `Postgres ${runningServer.serverVersion} (${runningServer.kind}): ${String(migrations[0]?.n ?? 0)} Prisma Migrate migration applied, ${String(tables[0]?.n ?? 0)} tables; better-auth reads (a username lookup) and writes (a row created, read back and consumed) through the Prisma ${versions.client} client and pg driver adapter ${versions.adapterPg}`;
    });

    if (opened === undefined) {
      blockUnrecorded(needsWorld, passBar.prismaOnPostgres);
    } else {
      const { world, close } = opened;
      cleanups.push(close);
      await check(passBar.signUp, () => signUpScenario(world));
      await check(passBar.signIn, () => signInScenario(world));
      await check(passBar.inviteLink, () => inviteLinkScenario(world));
      await check(passBar.twoOrganizations, () => twoOrganizationsScenario(world));
      await check(passBar.resetLink, () => resetLinkScenario(world));
      await check(passBar.deviceCode, () => deviceCodeScenario(world));
      await check(passBar.isolation, () => isolationScenario(world));

      heading("Beyond the pass bar (the decisions this spike tests: Q35, Q54, Q102, ADR 0003, ADR 0026)");
      await check(beyond.roles, () => rolesScenario(world));
      await check(beyond.firstAccount, async () => {
        const second = await runningServer.createDatabase();
        cleanups.push(() => second.dispose());
        return firstAccountScenario(second);
      });
    }
  }

  if (env.DATABASE_URL === undefined) {
    skip(beyond.ownPostgres, "DATABASE_URL set to a server the spike may create a database on");
  } else if (server === undefined) {
    blocked(beyond.ownPostgres, "starting the database server");
  } else {
    record({
      section: "beyond",
      title: beyond.ownPostgres,
      outcome: "PASS",
      detail: `every criterion above ran on ${server.kind} Postgres ${server.serverVersion}`,
      ms: 0,
    });
  }

  if (mutationRun) {
    skip(beyond.eslint, "a normal run: `pnpm mutation-check` leaves the source-rule rows out");
    skip(beyond.scan, "a normal run: `pnpm mutation-check` leaves the source-rule rows out");
  } else {
    // ESLint reads the generated client's types, so it stands on `prisma generate`.
    if (generated.ok) {
      await check(beyond.eslint, eslintCheck);
    } else {
      blocked(beyond.eslint, "prisma generate");
    }
    await check(beyond.scan, scanSource);
  }

  // Close what the scenarios opened before the contract test starts its own database.
  await shutdown();
  heading("Contract test");
  if (generated.ok) {
    await check(passBar.contractTest, runContractTest);
  } else {
    blocked(passBar.contractTest, "prisma generate");
  }

  heading("Housekeeping");
  await check(beyond.leftovers, noProcessLeftBehind);
};

const startedAt = Date.now();
try {
  await main();
} catch (error) {
  console.log(`\nthe harness itself failed: ${messageOf(error)}`);
} finally {
  await shutdown();
}

// Whatever the harness did not get to is in the table too, as a FAIL: a missing row must never read as a pass.
const expected: readonly CriterionTitle[] = [...Object.values(passBar), ...Object.values(beyond)];
const gaps = expected.filter((title) => !recorded(title));
if (gaps.length > 0) {
  console.log("");
  console.log("Rows the harness never reached");
  for (const title of gaps) {
    blocked(title, "an earlier step of the harness");
  }
}

const count = (outcome: Outcome, section?: Section): number =>
  rows.filter((row) => row.outcome === outcome && (section === undefined || row.section === section)).length;

console.log("");
console.log(
  `pass bar: ${String(count("PASS", "pass-bar"))} PASS, ${String(count("FAIL", "pass-bar"))} FAIL, ${String(count("SKIPPED", "pass-bar"))} SKIPPED (of ${String(Object.keys(passBar).length)})`,
);
console.log(
  `beyond:   ${String(count("PASS", "beyond"))} PASS, ${String(count("FAIL", "beyond"))} FAIL, ${String(count("SKIPPED", "beyond"))} SKIPPED (of ${String(Object.keys(beyond).length)})`,
);
console.log(`took ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
process.exitCode = count("FAIL") > 0 ? 1 : 0;
