import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  coreReplicas,
  devApps,
  hasDevScript,
  isDatabaseUrlLine,
  firstAdminSignIn,
  isFirstAdminSeededLine,
  pnpmEntry,
  prefixLine,
  usesExternalDatabase,
} from "./dev-stack.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ostra-dev-stack-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writePackage = async (name: string, json: string): Promise<string> => {
  const packageDir = path.join(dir, name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), json);
  return packageDir;
};

describe("pnpm dev's pieces", () => {
  it("starts a server only when its package has a dev script", async () => {
    expect(await hasDevScript(await writePackage("with", '{"scripts":{"dev":"node --watch src/main.ts"}}'))).toBe(true);
    expect(await hasDevScript(await writePackage("without", '{"scripts":{"test":"vitest"}}'))).toBe(false);
    expect(await hasDevScript(await writePackage("empty", '{"scripts":{"dev":"  "}}'))).toBe(false);
    expect(await hasDevScript(await writePackage("broken", "{not json"))).toBe(false);
    expect(await hasDevScript(path.join(dir, "missing"))).toBe(false);
  });

  it("names core and web with their addresses, from the port settings", () => {
    const [core, web] = devApps("/repo");
    expect(core?.address({})).toBe("http://localhost:8787");
    expect(web?.address({})).toBe("http://localhost:3000");
    expect(core?.address({ OSTRA_CORE_PORT: "9999" })).toBe("http://localhost:9999");
    expect(web?.address({ OSTRA_WEB_PORT: "not a port" })).toBe("http://localhost:3000");
    // The panel's `next dev` listens on PORT, set from OSTRA_WEB_PORT.
    expect(web?.extraEnv({ OSTRA_WEB_PORT: "3401" })["PORT"]).toBe("3401");
    expect(web?.extraEnv({})).toEqual({ PORT: "3000", OSTRA_PUBLIC_URL: "http://localhost:3000", OSTRA_CORE_PUBLIC_URL: "http://localhost:8787" });
    expect(core?.extraEnv({ OSTRA_WEB_PORT: "3401" })["PORT"]).toBeUndefined();
  });

  it("F-013: OSTRA_DEV_CORE_REPLICAS starts that many cores, each on the next port and told it, and one panel", () => {
    expect(coreReplicas({})).toBe(1);
    expect(coreReplicas({ OSTRA_DEV_CORE_REPLICAS: "3" })).toBe(3);
    expect(coreReplicas({ OSTRA_DEV_CORE_REPLICAS: "0" })).toBeNull();
    expect(coreReplicas({ OSTRA_DEV_CORE_REPLICAS: "two" })).toBeNull();
    const apps = devApps("/repo", 3);
    expect(apps.map((app) => app.label)).toEqual(["core", "core2", "core3", "web"]);
    const env = { OSTRA_CORE_PORT: "9502" };
    expect(apps.map((app) => app.address(env))).toEqual(["http://localhost:9502", "http://localhost:9503", "http://localhost:9504", "http://localhost:3000"]);
    expect(apps.map((app) => app.extraEnv(env)["OSTRA_CORE_PORT"])).toEqual([undefined, "9503", "9504", undefined]);
    // Runners and the panel are told the first core's address: any replica takes them.
    expect(apps.every((app) => app.extraEnv(env)["OSTRA_CORE_PUBLIC_URL"] === "http://localhost:9502")).toBe(true);
    expect(devApps("/repo").map((app) => app.label)).toEqual(["core", "web"]);
  });

  it("F-001: a stack on other ports tells the panel and core their own public addresses, so sign-in accepts the panel's origin", () => {
    const [core, web] = devApps("/repo");
    const env = { OSTRA_WEB_PORT: "3710", OSTRA_CORE_PORT: "9310" };
    // Both pieces get both: the panel's origin is what sign-in trusts, and core sends runners there
    // to approve a device code; core's is what a runner is told to connect to.
    for (const app of [core, web]) {
      expect(app?.extraEnv(env)).toMatchObject({ OSTRA_PUBLIC_URL: "http://localhost:3710", OSTRA_CORE_PUBLIC_URL: "http://localhost:9310" });
    }
    expect(web?.extraEnv(env)["OSTRA_PUBLIC_URL"]).toBe(web?.address(env));
    expect(core?.extraEnv(env)["OSTRA_CORE_PUBLIC_URL"]).toBe(core?.address(env));
    // An address that's set (a tunnel, a proxy in front) is kept: `pnpm dev` puts these over the
    // stack's own environment, so it must not send one at all.
    const own = { ...env, OSTRA_PUBLIC_URL: "https://panel.example", OSTRA_CORE_PUBLIC_URL: "https://core.example" };
    expect(web?.extraEnv(own)).toEqual({ PORT: "3710" });
    expect(core?.extraEnv(own)).toEqual({});
    // The first admin is told to sign in where the panel is.
    expect(firstAdminSignIn(env).join(" ")).toContain("Sign in at http://localhost:3710");
  });

  it("prefixes each piece's lines, and picks out the seeded first admin and the database URL", () => {
    expect(prefixLine("db", "ready")).toBe("[db  ] ready");
    expect(prefixLine("core", "listening")).toBe("[core] listening");
    expect(isFirstAdminSeededLine('{"at":"2026-11-19T00:00:00.000Z","level":"info","msg":"setup.first_admin_seeded","userId":"u1"}')).toBe(true);
    expect(isFirstAdminSeededLine("listening on 8787")).toBe(false);
    expect(isDatabaseUrlLine("DATABASE_URL=postgresql://...")).toBe(true);
    expect(isDatabaseUrlLine("Dev database running")).toBe(false);
  });

  it("says how to sign in as the seeded admin, and never prints an operator's own password", () => {
    expect(firstAdminSignIn({}).join(" ")).toContain("demo@demo.com with the password demo");
    const own = firstAdminSignIn({ OSTRA_ADMIN_EMAIL: "ada@example.com", OSTRA_ADMIN_PASSWORD: "a-secret-password", OSTRA_PUBLIC_URL: "http://panel.test" }).join(" ");
    expect(own).toContain("ada@example.com");
    expect(own).toContain("http://panel.test");
    expect(own).toContain("OSTRA_ADMIN_PASSWORD");
    expect(own).not.toContain("a-secret-password");
  });

  it("uses DATABASE_URL when it's set, and pnpm's own entry when pnpm started it", () => {
    expect(usesExternalDatabase({})).toBe(false);
    expect(usesExternalDatabase({ DATABASE_URL: "" })).toBe(false);
    expect(usesExternalDatabase({ DATABASE_URL: "postgresql://elsewhere/ostra" })).toBe(true);
    expect(pnpmEntry({ npm_execpath: "C:\\pnpm\\bin\\pnpm.cjs" })).toBe("C:\\pnpm\\bin\\pnpm.cjs");
    expect(pnpmEntry({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" })).toBeNull();
    expect(pnpmEntry({})).toBeNull();
  });
});
