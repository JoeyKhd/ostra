import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  devApps,
  hasDevScript,
  isDatabaseUrlLine,
  isSetupTokenLine,
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
  });

  it("prefixes each piece's lines, and picks out the setup token and the database URL", () => {
    expect(prefixLine("db", "ready")).toBe("[db  ] ready");
    expect(prefixLine("core", "listening")).toBe("[core] listening");
    expect(isSetupTokenLine("First start: the setup token is abc")).toBe(true);
    expect(isSetupTokenLine("listening on 8787")).toBe(false);
    expect(isDatabaseUrlLine("DATABASE_URL=postgresql://...")).toBe(true);
    expect(isDatabaseUrlLine("Dev database running")).toBe(false);
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
