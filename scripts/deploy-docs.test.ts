import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// F-001 (Q97, ADR 0029): the compose file's pool runner mounts the Docker socket, and the docs say
// what that means. Read from the files an operator reads, so a compose change that mounts the
// socket elsewhere, or a docs edit that drops the warning, fails here.

const repoRoot = path.resolve(import.meta.dirname, "..");

/** The lines of one service under `services:` in a compose file, by its two-space-indented key. */
const serviceBlock = (compose: string, name: string): string => {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`the compose file has no service "${name}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

/** The paragraph of a Markdown file that starts with this bold lead. */
const paragraphLed = (markdown: string, lead: string): string => {
  const paragraph = markdown.split(/\r?\n\r?\n/).find((candidate) => candidate.startsWith(lead));
  if (paragraph === undefined) throw new Error(`no paragraph starts with ${lead}`);
  return paragraph;
};

describe("the compose file's runner and the Docker socket", () => {
  it("F-001: the compose pool runner mounts the Docker socket, and the docs say it is root on that machine and pools belong on dedicated hosts", async () => {
    const compose = await readFile(path.join(repoRoot, "deploy", "compose.yaml"), "utf8");
    const runner = serviceBlock(compose, "runner");
    expect(runner).toMatch(/OSTRA_RUNNER_EXECUTOR: docker\n/);
    expect(runner).toMatch(/^ {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);
    // The only service that mounts it.
    const mounting = compose.split(/\r?\n/).filter((line) => line.includes("/var/run/docker.sock:"));
    expect(mounting).toHaveLength(1);

    const docs = await readFile(path.join(repoRoot, "docs", "configuration.md"), "utf8");
    const socket = paragraphLed(docs, "**The Docker socket**");
    expect(socket).toContain("`deploy/compose.yaml`");
    expect(socket).toContain("mounts the Docker socket");
    expect(socket).toContain("root on that machine");
    expect(socket).toContain("pool runners belong on dedicated hosts");
    expect(socket).toContain("Q97");
  });
});
