import { defineConfig } from "prisma/config";

// `prisma generate` needs no database. Commands that do (migrate deploy) read DATABASE_URL.
const url = process.env["DATABASE_URL"] ?? "postgresql://unused:unused@127.0.0.1:5432/unused";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
});
