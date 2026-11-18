// `pnpm db:migrate`: applies prisma/migrations to DATABASE_URL, or to the dev database when it's
// unset (start it first with `pnpm db:dev`). The URL is never printed.

import { migrateDeploy, resolveDatabaseUrl } from "@ostra/db/dev";

const usingDev = process.env["DATABASE_URL"] === undefined || process.env["DATABASE_URL"] === "";
console.log(usingDev ? "Migrating the dev database..." : "Migrating the database DATABASE_URL names...");

const result = await migrateDeploy(resolveDatabaseUrl(process.env));
console.log(result.output.trim());
if (!result.ok) {
  console.error(usingDev ? "Migration failed. Is `pnpm db:dev` running?" : "Migration failed.");
  process.exitCode = 1;
}
