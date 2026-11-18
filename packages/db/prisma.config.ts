import { defineConfig } from "prisma/config";

// Prisma 7 reads the connection URL from here, not from schema.prisma. `prisma generate` connects to
// nothing; the commands that do (`migrate deploy`, `migrate dev`) get DATABASE_URL from
// `scripts/migrate.ts`, which falls back to the dev database. An unset URL gets a placeholder that
// fails loudly the moment a command really connects (spike 9 found that `migrate diff` with no
// datasource prints an empty script and exits 0).
const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgresql://not-configured:not-configured@127.0.0.1:1/not-configured";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl },
});
