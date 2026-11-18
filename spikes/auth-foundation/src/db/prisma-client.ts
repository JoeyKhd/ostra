import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

// Prisma 7 has no Rust query engine on this path: the generated client runs the
// query compiler in JavaScript and talks to Postgres through a driver adapter.
// Creating a client does not connect; the pool opens on the first query.
export const createPrismaClient = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export type { PrismaClient };
