// @ostra/db: the Prisma schema's client and its types. Prisma's types are the source: nothing
// here is typed again by hand.
export * from "./client.ts";
export * from "./dev/dev-database.ts";
export { migrateDeploy } from "./dev/prisma-cli.ts";

export { Prisma } from "./generated/prisma/client.ts";
