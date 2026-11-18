// Config for better-auth's schema generator (see README, "The schema").
// The generator reads the plugin list only, so the client it gets never connects.
import { createAuth } from "./src/auth/create-auth.ts";
import { createPrismaClient } from "./src/db/prisma-client.ts";

export const auth = createAuth({
  prisma: createPrismaClient("postgresql://schema-generation-only:unused@127.0.0.1:1/unused"),
  baseURL: "http://localhost:3000",
  secret: "schema-generation-only-secret-not-used-at-runtime",
});
