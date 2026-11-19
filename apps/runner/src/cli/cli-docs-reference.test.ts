import { readFile } from "node:fs/promises";

import { runnerConfigFields } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { runCli } from "./cli.ts";
import type { CliDeps } from "./cli.ts";
import { createCapturingTerminal } from "./terminal.ts";

// The docs site's CLI reference (ADR 0063, F-058) is written from `ostra --help`. This test holds
// the page to the program: a command, a flag, its variable, its default or its words that differ
// on either side fails, so a renamed flag can't leave the page behind.

const page = new URL("../../../docs/content/reference/cli.mdx", import.meta.url);

type Command = { readonly usage: string; readonly description: string };
type Flag = { readonly flag: string; readonly env: string; readonly description: string };

const helpOutput = async (): Promise<readonly string[]> => {
  const terminal = createCapturingTerminal();
  const deps: CliDeps = {
    env: {},
    terminal,
    signal: new AbortController().signal,
    runSignedIn: () => Promise.reject(new Error("--help starts no runner")),
    runSidecar: () => Promise.reject(new Error("--help starts no sidecar")),
  };
  expect(await runCli(["--help"], deps)).toBe(0);
  return terminal.lines().join("").split("\n");
};

/** The help's usage lines: the words up to the first capitalised one, and the sentence after. */
const helpCommands = (lines: readonly string[]): readonly Command[] => {
  const start = lines.indexOf("Usage:");
  const commands: { usage: string; description: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      break;
    }
    const words = line.trim().split(" ").filter((word) => word !== "");
    if (words[0] === "ostra") {
      const cut = words.findIndex((word) => /^[A-Z]/.test(word));
      const usage = (cut === -1 ? words : words.slice(0, cut)).join(" ");
      commands.push({ usage, description: cut === -1 ? "" : words.slice(cut).join(" ") });
      continue;
    }
    const last = commands.at(-1);
    if (last !== undefined) {
      last.description = [last.description, words.join(" ")].filter((part) => part !== "").join(" ");
    }
  }
  return commands;
};

const helpFlags = (lines: readonly string[]): readonly Flag[] =>
  lines.flatMap((line) => {
    const match = /^\s+--([a-z][a-z0-9-]*)\s+(OSTRA_[A-Z_]+)\s+(.+)$/.exec(line);
    return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
      ? []
      : [{ flag: match[1], env: match[2], description: match[3].trim() }];
  });

const decode = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim();

const pageRows = (text: string): readonly (readonly string[])[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("|---"))
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => decode(cell)),
    );

const code = (cell: string | undefined): string | undefined => /^`([^`]+)`$/.exec(cell ?? "")?.[1];

describe("the docs site's CLI reference", () => {
  it("F-058: the CLI reference page lists every command and runner flag `ostra --help` prints, in its words", async () => {
    const lines = await helpOutput();
    const rows = pageRows(await readFile(page, "utf8"));

    const pageCommands = new Map(
      rows.flatMap((row) => {
        const usage = code(row[0]);
        return row.length === 2 && usage?.startsWith("ostra") === true ? [[usage, row[1] ?? ""] as const] : [];
      }),
    );
    const commands = helpCommands(lines);
    expect(commands.length).toBeGreaterThan(4);
    expect([...pageCommands.keys()].sort()).toEqual(commands.map((command) => command.usage).sort());
    for (const command of commands) {
      if (command.description !== "") {
        expect(pageCommands.get(command.usage), `${command.usage}'s words`).toBe(command.description);
      }
    }

    const pageFlags = new Map(
      rows.flatMap((row) => {
        const flag = code(row[0]);
        const env = code(row[1]);
        return row.length === 4 && flag?.startsWith("--") === true && env !== undefined
          ? [[flag.slice(2), { env, defaultValue: row[2] ?? "", description: row[3] ?? "" }] as const]
          : [];
      }),
    );
    const flags = helpFlags(lines);
    expect(flags.length).toBe(Object.keys(runnerConfigFields).length);
    expect([...pageFlags.keys()].sort()).toEqual(flags.map((flag) => flag.flag).sort());
    for (const flag of flags) {
      const row = pageFlags.get(flag.flag);
      expect(row?.env, `--${flag.flag}'s variable`).toBe(flag.env);
      expect(row?.description, `--${flag.flag}'s words`).toBe(flag.description);
      const field = Object.values(runnerConfigFields).find((candidate) => candidate.flag === flag.flag);
      expect(row?.defaultValue, `--${flag.flag}'s default`).toBe(field?.default);
    }

    const verbose = lines.flatMap((line) => /^\s+--verbose\s+(.+)$/.exec(line)?.[1] ?? []);
    const verboseRow = rows.find((row) => code(row[0]) === "--verbose");
    expect(verboseRow?.[1]).toBe(verbose[0]?.trim());
  });
});
