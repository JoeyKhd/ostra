// `pnpm dev:seed-member <username> [--email <address>] [--password <password>] [--role member|admin]`:
// adds a second account to the dev install's first organization (milestone 3, Q165), through the
// same account code the first admin's seed uses. Invites are milestone 4; until then the demo and
// the tests need another member. Development and test only: it refuses to run otherwise, and the
// production build doesn't include it. The password is never printed.

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { parseServerSettings, seedingAllowed, seedMember } from "@ostra/domain";

/** The password a seeded member gets when none is given: what docs/development.md names. */
const DEFAULT_PASSWORD = "seeded-member-password";

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const username = args[0];
  if (username === undefined || username.startsWith("--")) {
    process.stderr.write("Usage: pnpm dev:seed-member <username> [--email <address>] [--password <password>] [--role member|admin]\n");
    return 2;
  }
  if (!seedingAllowed(process.env)) {
    process.stderr.write("Seeding a member runs only when NODE_ENV is development or test.\n");
    return 1;
  }
  const settings = parseServerSettings(process.env);
  if (!settings.ok) {
    process.stderr.write(`${settings.errors.join("\n")}\n`);
    return 1;
  }
  const role = flag(args, "role") ?? "member";
  if (role !== "member" && role !== "admin") {
    process.stderr.write("--role is member or admin.\n");
    return 2;
  }
  const db = createDb(settings.settings.databaseUrl);
  try {
    const result = await seedMember(
      { db, hashPassword, env: process.env },
      { username, email: flag(args, "email") ?? `${username}@example.com`, password: flag(args, "password") ?? DEFAULT_PASSWORD, role },
    );
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      return 1;
    }
    process.stdout.write(`Seeded ${username} as a ${role} of the install's first organization. Sign in with their username and password.\n`);
    return 0;
  } finally {
    await db.$disconnect();
  }
};

process.exitCode = await main();
