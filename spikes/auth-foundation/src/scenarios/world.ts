import { randomBytes } from "node:crypto";
import type { OstraAuth } from "../auth/create-auth.ts";
import { createAuth, defaultAuthSettings } from "../auth/create-auth.ts";
import type { AuthSettings } from "../auth/create-auth.ts";
import type { PrismaClient } from "../db/prisma-client.ts";
import { createPrismaClient } from "../db/prisma-client.ts";
import { migrateDeploy } from "../db/migrate.ts";
import type { ProvisionedDatabase } from "../db/provision-database.ts";
import { findFreePort, startAuthServer } from "../http/auth-server.ts";
import type { AuthServer } from "../http/auth-server.ts";
import type { OrganizationId } from "../ids.ts";
import type { WorkStore } from "../ostra/work-store.ts";
import { createWorkStore } from "../ostra/work-store.ts";
import type { Actor } from "./support.ts";
import { runTag } from "./support.ts";

/**
 * One installed instance of ostra's auth: a migrated database, better-auth over
 * it, and the same better-auth served on a loopback port. Scenarios share one,
 * in order, because each builds on the people and organizations before it.
 */
export type World = {
  readonly auth: OstraAuth;
  readonly prisma: PrismaClient;
  readonly server: AuthServer;
  readonly store: WorkStore;
  readonly secret: string;
  /** A suffix that keeps names unique when the database is reused. */
  readonly tag: string;
  readonly actors: Map<string, Actor>;
  readonly organizations: Map<string, OrganizationId>;
  readonly databaseUrl: string;
};

export type WorldOptions = {
  readonly database: ProvisionedDatabase;
  readonly settings?: AuthSettings;
  readonly deviceInterval?: "1s" | "5s";
  readonly secret?: string;
  readonly logLevel?: "warn" | "error";
};

export type OpenedWorld = {
  readonly world: World;
  readonly close: () => Promise<void>;
};

export const randomSecret = (): string => randomBytes(32).toString("base64url");

export const openWorld = async (options: WorldOptions): Promise<OpenedWorld> => {
  const migrated = await migrateDeploy(options.database.url);
  if (!migrated.ok) {
    throw new Error(`migrations did not apply: ${migrated.detail}`);
  }
  const prisma = createPrismaClient(options.database.url);
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${String(port)}`;
  const secret = options.secret ?? randomSecret();
  const auth = createAuth({
    prisma,
    baseURL,
    secret,
    settings: options.settings ?? defaultAuthSettings,
    logLevel: options.logLevel ?? "error",
    ...(options.deviceInterval === undefined ? {} : { deviceInterval: options.deviceInterval }),
  });
  const server = await startAuthServer(auth, port);
  return {
    world: {
      auth,
      prisma,
      server,
      store: createWorkStore(prisma),
      secret,
      tag: runTag(),
      actors: new Map(),
      organizations: new Map(),
      databaseUrl: options.database.url,
    },
    close: async () => {
      await server.close();
      await prisma.$disconnect();
    },
  };
};

// ---- Lookups that name the missing prerequisite --------------------------

export const actorOf = (world: World, key: string): Actor => {
  const found = world.actors.get(key);
  if (found === undefined) {
    throw new Error(`prerequisite missing: the account "${key}" was not created by an earlier scenario`);
  }
  return found;
};

export const organizationOf = (world: World, key: string): OrganizationId => {
  const found = world.organizations.get(key);
  if (found === undefined) {
    throw new Error(`prerequisite missing: the organization "${key}" was not created by an earlier scenario`);
  }
  return found;
};

/** A unique, valid account spec: lowercase username, a `.test` email. */
export const accountSpec = (world: World, key: string): {
  readonly key: string;
  readonly email: string;
  readonly username: string;
  readonly password: string;
} => ({
  key,
  email: `${key}.${world.tag}@example.test`,
  username: `${key}_${world.tag}`,
  password: "correct horse battery staple",
});
