// @ostra/db/dev: the dev database and the Prisma CLI, for the scripts and the dev stack (ticket 05,
// ticket 29). Kept apart from the package's main entry so it loads before the client is generated.
export * from "./dev-database.ts";
export * from "./prisma-cli.ts";
