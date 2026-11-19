import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runAgentCommand } from "./spawn-agent.ts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("running an agent's command as an executor would", () => {
  it("writes the command's standard output to the file it names, and returns its exit code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ostra-run-command-"));
    roots.push(root);
    const out = path.join(root, "archive.json");
    const result = await runAgentCommand({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(JSON.stringify({ hello: "world" }))'],
      env: {},
      cwd: root,
      stdoutTo: out,
    });
    expect(result).toEqual({ code: 0 });
    expect(await readFile(out, "utf8")).toBe('{"hello":"world"}');
  });

  it("passes only the command's own environment, and reports a failure's code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ostra-run-command-"));
    roots.push(root);
    const out = path.join(root, "env.json");
    await runAgentCommand({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(JSON.stringify({ leaked: process.env.OSTRA_SDK_PROBE ?? null, own: process.env.OWN ?? null }))'],
      env: { OWN: "yes" },
      cwd: root,
      stdoutTo: out,
    });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ leaked: null, own: "yes" });
    expect(await runAgentCommand({ command: process.execPath, args: ["-e", "process.exit(3)"], env: {}, cwd: root })).toEqual({ code: 3 });
    expect(await runAgentCommand({ command: path.join(root, "no-such-binary"), args: [], env: {}, cwd: root })).toEqual({ code: null });
  });
});
