import { defineConfig } from "prisma/config";

// Prisma 7 moved the connection URL out of schema.prisma and into this file.
//
// `prisma generate` and `prisma migrate diff` connect to nothing, but
// `migrate diff` prints an empty script (and exits 0) when the config has no
// datasource at all. So an unset DATABASE_URL gets a placeholder that fails
// loudly the moment a command really tries to connect.
const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgresql://not-configured:not-configured@127.0.0.1:1/not-configured";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl },
});
