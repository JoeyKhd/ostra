import { readFile } from "node:fs/promises";
import path from "node:path";

import { devDatabaseUrl, DEV_PG_PORT_DEFAULT, repoRoot } from "@ostra/db/dev";
import { runnerEnvNames } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { devOnlyEnvNames, parseServerSettings, settingFields, settingNames } from "./settings.ts";

describe("the server's settings", () => {
  it("list exactly the names their fields hold", () => {
    expect([...settingNames].sort()).toEqual(Object.keys(settingFields).sort());
  });

  it("parse an empty environment in development, with every default", () => {
    const result = parseServerSettings({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.settings).toMatchObject({
      mode: "development",
      databaseUrl: devDatabaseUrl(DEV_PG_PORT_DEFAULT),
      webPort: 3000,
      corePort: 8787,
      publicUrl: "http://localhost:3000",
      corePublicUrl: "http://localhost:8787",
      githubApiUrl: "https://api.github.com",
      secretsKey: null,
      catalogFetch: true,
      modelEndpointAllowPrivate: false,
      openSignupAccounts: false,
      openSignupOrganizations: false,
      betterAuthSecret: null,
      firstAdmin: { email: "demo@demo.com", username: "demo", password: null, organizationName: "Demo" },
      allowDefaultPassword: false,
    });
    expect(result.settings.dataDir).toBe(path.join(repoRoot, ".ostra-dev", "server"));
  });

  it("keeps model provider URLs off private networks unless OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE says otherwise", () => {
    const on = parseServerSettings({ OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true" });
    expect(on.ok && on.settings.modelEndpointAllowPrivate).toBe(true);
    const off = parseServerSettings({});
    expect(off.ok && off.settings.modelEndpointAllowPrivate).toBe(false);
  });

  it("points GitHub at OSTRA_GITHUB_API_URL, without a trailing slash, and refuses a URL that isn't http(s)", () => {
    const custom = parseServerSettings({ OSTRA_GITHUB_API_URL: "https://ghe.example.com/api/v3/" });
    expect(custom.ok && custom.settings.githubApiUrl).toBe("https://ghe.example.com/api/v3");
    const refused = parseServerSettings({ OSTRA_GITHUB_API_URL: "ftp://ghe.example.com" });
    expect(refused.ok).toBe(false);
  });

  it("F-090: takes the LFS storage hosts from OSTRA_GITHUB_LFS_HOSTS, GitHub.com's by default, and refuses what isn't a host name", () => {
    const fallback = parseServerSettings({});
    expect(fallback.ok && fallback.settings.githubLfsHosts).toEqual(["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"]);
    const ghes = parseServerSettings({ OSTRA_GITHUB_LFS_HOSTS: " LFS.ghes.example.com, *.storage.example.com " });
    expect(ghes.ok && ghes.settings.githubLfsHosts).toEqual(["lfs.ghes.example.com", "*.storage.example.com"]);
    for (const bad of ["https://lfs.example.com", "127.0.0.1:443", "lfs example.com", ","]) {
      const refused = parseServerSettings({ OSTRA_GITHUB_LFS_HOSTS: bad });
      expect(refused.ok, bad).toBe(false);
    }
  });

  it("refuses an unknown OSTRA_ variable, listing the known ones", () => {
    const result = parseServerSettings({ OSTRA_WEB_PROT: "3001" });
    expect(result.ok).toBe(false);
    const errors = result.ok ? "" : result.errors.join("\n");
    expect(errors).toContain("OSTRA_WEB_PROT");
    expect(errors).toContain("OSTRA_WEB_PORT");
  });

  it("lets the runner's and the dev setup's variables through, and ignores others", () => {
    expect(
      parseServerSettings({
        OSTRA_SERVER_URL: "http://localhost:8787",
        OSTRA_DEV_MODEL_ID: "test-model",
        // The dev env files hold these too (github-test.env, tunnel.env, model.env's spike prices).
        OSTRA_DEV_GITHUB_ORG: "ostra-test",
        OSTRA_DEV_PUBLIC_URL: "https://tunnel.example",
        OSTRA_SPIKE_PRICE_INPUT: "0.1",
        PATH: "/usr/bin",
        HOME: "/home/dev",
      }).ok,
    ).toBe(true);
  });

  it("requires DATABASE_URL in production", () => {
    expect(parseServerSettings({ NODE_ENV: "production" })).toEqual({
      ok: false,
      errors: ["DATABASE_URL is required in production"],
    });
    const result = parseServerSettings({ NODE_ENV: "production", DATABASE_URL: "postgresql://db/ostra" });
    expect(result.ok && result.settings.dataDir).toBe("/var/lib/ostra");
  });

  it("reads booleans, ports and URLs, and names a bad one without its value", () => {
    const result = parseServerSettings({ OSTRA_CATALOG_FETCH: "off", OSTRA_CORE_PORT: "9000", OSTRA_OPEN_SIGNUP_ACCOUNTS: "yes" });
    expect(result.ok && [result.settings.catalogFetch, result.settings.corePort, result.settings.openSignupAccounts]).toEqual([
      false,
      9000,
      true,
    ]);
    const bad = parseServerSettings({ BETTER_AUTH_SECRET: "too-short-secret-value", OSTRA_WEB_PORT: "http" });
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? "" : bad.errors.join("\n");
    expect(errors).toContain("BETTER_AUTH_SECRET");
    expect(errors).toContain("OSTRA_WEB_PORT");
    expect(errors).not.toContain("too-short-secret-value");
  });
});

describe("the first admin's settings (F-001)", () => {
  it("default to demo@demo.com, demo, the default password and Demo", () => {
    const result = parseServerSettings({});
    expect(result.ok && result.settings.firstAdmin).toEqual({ email: "demo@demo.com", username: "demo", password: null, organizationName: "Demo" });
    expect(result.ok && result.settings.allowDefaultPassword).toBe(false);
  });

  it("take each variable over its default", () => {
    const result = parseServerSettings({
      OSTRA_ADMIN_EMAIL: "Ada@Example.com",
      OSTRA_ADMIN_USERNAME: "ada",
      OSTRA_ADMIN_PASSWORD: "a-long-enough-password",
      OSTRA_ORGANIZATION_NAME: "  Calculator Co  ",
      OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
    });
    expect(result.ok && result.settings.firstAdmin).toEqual({
      email: "ada@example.com",
      username: "ada",
      password: "a-long-enough-password",
      organizationName: "Calculator Co",
    });
    expect(result.ok && result.settings.allowDefaultPassword).toBe(true);
  });

  it("refuse a bad email, username or short password, naming the variable but never the value", () => {
    for (const [name, value] of [
      ["OSTRA_ADMIN_EMAIL", "not-an-email"],
      ["OSTRA_ADMIN_USERNAME", "Not Valid!"],
      ["OSTRA_ADMIN_PASSWORD", "short-pass1"],
      ["OSTRA_ORGANIZATION_NAME", "   "],
    ] as const) {
      const result = parseServerSettings({ [name]: value });
      expect(result.ok, name).toBe(false);
      const errors = result.ok ? "" : result.errors.join("\n");
      expect(errors).toContain(name);
      if (value.trim() !== "") {
        expect(errors).not.toContain(value);
      }
    }
  });

  it("refuse the old setup token: Q117 is superseded", () => {
    expect(parseServerSettings({ OSTRA_SETUP_TOKEN: "ostra-setup-0123456789abcdef" }).ok).toBe(false);
  });
});

describe("docs/configuration.md", () => {
  const documented = async (): Promise<ReadonlySet<string>> => {
    const text = await readFile(path.join(repoRoot, "docs", "configuration.md"), "utf8");
    return new Set([...text.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));
  };

  it("lists every setting the server, the runner and the dev setup know", async () => {
    const names = await documented();
    for (const name of [...settingNames, ...runnerEnvNames, ...devOnlyEnvNames]) {
      expect(names.has(name), `${name} is missing from docs/configuration.md`).toBe(true);
    }
  });

  it("lists no setting the code doesn't know", async () => {
    const known = new Set<string>([...settingNames, ...runnerEnvNames, ...devOnlyEnvNames]);
    for (const name of await documented()) {
      expect(known.has(name), `${name} is in docs/configuration.md but no schema reads it`).toBe(true);
    }
  });
});
