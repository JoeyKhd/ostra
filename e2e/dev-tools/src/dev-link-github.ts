// `pnpm dev:link-github <username> <github-login>`: links a dev account to a GitHub user, as the
// panel's "Link GitHub" would after its OAuth round trip (milestone 4, ticket 40). It reads the
// user's numeric ID from GitHub with `GITHUB_TEST_ADMIN_TOKEN` from the environment or from
// `~/.config/ostra-dev/github-test.env`, or without a token when there is none. Development and
// test only: it refuses to run otherwise, and the production build doesn't include it. The token
// is never printed.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDb } from "@ostra/db";
import { parseServerSettings, seedingAllowed } from "@ostra/domain";

import { linkGitHubForDev } from "./link-github.ts";

/** One `KEY=value` of a dev env file, or `null`. Read only; the value is never printed. */
const fromEnvFile = async (file: string, key: string): Promise<string | null> => {
  try {
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1] === key) {
        const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
        return value === "" ? null : value;
      }
    }
  } catch {
    return null;
  }
  return null;
};

const main = async (): Promise<number> => {
  const [username, githubLogin] = process.argv.slice(2);
  if (username === undefined || githubLogin === undefined) {
    process.stderr.write("Usage: pnpm dev:link-github <username> <github-login>\n");
    return 2;
  }
  if (!seedingAllowed(process.env)) {
    process.stderr.write("The dev GitHub link runs only when NODE_ENV is development or test.\n");
    return 1;
  }
  const settings = parseServerSettings(process.env);
  if (!settings.ok) {
    process.stderr.write(`${settings.errors.join("\n")}\n`);
    return 1;
  }
  const envToken = process.env["GITHUB_TEST_ADMIN_TOKEN"];
  const token =
    envToken === undefined || envToken === "" ? await fromEnvFile(path.join(os.homedir(), ".config", "ostra-dev", "github-test.env"), "GITHUB_TEST_ADMIN_TOKEN") : envToken;
  const db = createDb(settings.settings.databaseUrl);
  try {
    const result = await linkGitHubForDev(
      { db, env: process.env, fetch, apiUrl: process.env["OSTRA_DEV_GITHUB_API_URL"] ?? "https://api.github.com", token, now: () => Date.now() },
      { username, githubLogin },
    );
    if (!result.ok) {
      process.stderr.write(`${result.message}.\n`);
      return 1;
    }
    process.stdout.write(`Linked ${username} to GitHub's ${result.githubLogin} (user ${result.githubUserId}).\n`);
    return 0;
  } finally {
    await db.$disconnect();
  }
};

process.exitCode = await main();
