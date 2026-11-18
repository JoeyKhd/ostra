import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnerOnly } from "../identity/owner-only.ts";
import { dataPaths, loadIdentity } from "../identity/store.ts";
import type { SignedIn } from "../sign-in.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer, FakeServerOptions } from "../testing/fake-server.ts";
import { RUNNER_VERSION } from "../version.ts";
import { exitCodes, runCli } from "./cli.ts";
import type { CliDeps } from "./cli.ts";
import { createCapturingTerminal } from "./terminal.ts";

// Ticket 15's "done when", against a fake server built from the protocol's schemas.

let dataDir = "";
let server: FakeServer | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ostra-runner-cli-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const start = async (options: FakeServerOptions = {}): Promise<FakeServer> => {
  server = await startFakeServer(options);
  return server;
};

type Run = { readonly code: number; readonly lines: readonly string[]; readonly signedIn: SignedIn | undefined };

const run = async (args: readonly string[], env: CliDeps["env"] = {}): Promise<Run> => {
  const terminal = createCapturingTerminal();
  let signedIn: SignedIn | undefined;
  const code = await runCli(args, {
    env,
    terminal,
    signal: new AbortController().signal,
    runSignedIn: (input) => {
      signedIn = input.signedIn;
      return Promise.resolve(exitCodes.ok);
    },
    runSidecar: () => Promise.resolve(exitCodes.usage),
    deviceFlow: { sleep: () => Promise.resolve() },
  });
  return { code, lines: terminal.lines(), signedIn };
};

const runner = (fake: FakeServer, ...extra: string[]): Promise<Run> =>
  run(["runner", "--server", fake.url, "--data-dir", dataDir, "--name", "laptop", ...extra]);

describe("ostra runner: the first sign-in", () => {
  it("runs the device flow, registers, stores the key, and the server revokes the session", async () => {
    const fake = await start();
    const first = await runner(fake);
    expect(first.code).toBe(exitCodes.ok);
    const output = first.lines.join("");
    expect(output).toContain("ABCD-EFGH");
    expect(output).toContain(`${fake.url}/device?user_code=ABCD-EFGH`);
    expect(first.signedIn?.identity.record.kind).toBe("personal");

    expect(fake.runners.size).toBe(1);
    const [registered] = [...fake.runners.values()];
    expect(registered?.proof).toBe("device-session");
    expect(registered?.request).toMatchObject({ name: "laptop", executor: "host", capacity: 1, version: RUNNER_VERSION });
    expect([...fake.sessions.values()].every((session) => session.revoked)).toBe(true);

    const loaded = await loadIdentity(dataDir);
    expect(loaded.kind).toBe("found");
    if (loaded.kind === "found") {
      expect(loaded.identity.record.runnerId).toBe(registered?.runnerId);
      expect(loaded.identity.keyPair.publicKey).toBe(registered?.request.publicKey);
    }
    expect([...fake.tokensIssued.values()]).toEqual([1]);
  });

  it("skips the device flow on the second start and trades a signed assertion for a token", async () => {
    const fake = await start();
    await runner(fake);
    const deviceCalls = fake.requests.filter((line) => line.includes("/api/auth/device/")).length;
    const second = await runner(fake);
    expect(second.code).toBe(exitCodes.ok);
    expect(fake.requests.filter((line) => line.includes("/api/auth/device/")).length).toBe(deviceCalls);
    expect(fake.runners.size).toBe(1);
    expect([...fake.tokensIssued.values()]).toEqual([2]);
    expect(second.signedIn?.identity.record.runnerId).toBe([...fake.runners.keys()][0]);
  });

  it("keeps the private key readable only by its owner", async () => {
    const fake = await start();
    await runner(fake);
    expect(await checkOwnerOnly(dataPaths(dataDir).privateKey)).toEqual({ ownerOnly: true });
  });

  it("registers a pool runner with its join token, without a device flow", async () => {
    const fake = await start({ joinTokens: ["ostra-join-bootstrap-token-1"] });
    const result = await runner(fake, "--join-token", "ostra-join-bootstrap-token-1");
    expect(result.code).toBe(exitCodes.ok);
    expect([...fake.runners.values()][0]?.proof).toBe("join-token");
    expect(result.signedIn?.identity.record.kind).toBe("pool");
    expect(fake.requests.some((line) => line.includes("/api/auth/device/"))).toBe(false);
  });

  it("stops with a clear message when the member denies the code", async () => {
    const fake = await start({ deviceOutcome: "deny" });
    const result = await runner(fake);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.lines.join("")).toContain("denied");
    expect(fake.runners.size).toBe(0);
    expect((await loadIdentity(dataDir)).kind).toBe("none");
  });
});

describe("ostra runner: refusals", () => {
  it("gives a revoked runner a clear message, a distinct exit code, and records it for status", async () => {
    const fake = await start();
    await runner(fake);
    for (const entry of fake.runners.values()) {
      entry.revoked = true;
    }
    const refused = await runner(fake);
    expect(refused.code).toBe(exitCodes.refused);
    const output = refused.lines.join("");
    expect(output).toContain("revoked");
    expect(output).toContain(dataPaths(dataDir).identityDir);

    const status = await run(["runner", "status", "--data-dir", dataDir]);
    expect(status.code).toBe(exitCodes.ok);
    expect(status.lines.join("")).toMatch(/Last refusal +\S+ revoked:/);
  });

  it("refuses a server whose version window excludes this runner, with the fix", async () => {
    const fake = await start({ info: { serverMinor: 5, supported: { min: 4, max: 6 }, serverVersion: "0.5.0" } });
    const result = await runner(fake);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.lines.join("")).toContain("Install ostra 0.5.0");
    expect(fake.runners.size).toBe(0);
    expect(fake.requests.some((line) => line.includes("/api/auth/device/"))).toBe(false);

    const status = await run(["runner", "status", "--data-dir", dataDir]);
    expect(status.lines.join("")).toContain("protocol 1.4 to 1.6 (server ostra 0.5.0)");
    expect(status.lines.join("")).toContain("version-unsupported");
  });

  it("refuses a data folder that belongs to another server", async () => {
    const fake = await start();
    await runner(fake);
    const other = await startFakeServer();
    try {
      const result = await run(["runner", "--server", other.url, "--data-dir", dataDir]);
      expect(result.code).toBe(exitCodes.failed);
      expect(result.lines.join("")).toContain("Use another --data-dir");
      expect(other.runners.size).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("ostra runner: secrets stay out of the output", () => {
  it("never prints the device session, the access token or the private key", async () => {
    const fake = await start();
    const first = await runner(fake);
    const second = await runner(fake);
    const status = await run(["runner", "status", "--data-dir", dataDir]);
    const output = [...first.lines, ...second.lines, ...status.lines].join("");
    const pem = await readFile(dataPaths(dataDir).privateKey, "utf8");
    const keyBody = pem.split("\n").filter((line) => !line.startsWith("-----") && line.length > 0);

    expect(fake.sessions.size).toBeGreaterThan(0);
    expect(fake.accessTokens.size).toBe(2);
    for (const secret of [...fake.sessions.keys(), ...fake.accessTokens.keys(), ...keyBody]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain("PRIVATE KEY");
  });
});

describe("the CLI's commands", () => {
  it("prints its version, equal to package.json's", async () => {
    const pkg: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(Reflect.get(Object(pkg), "version")).toBe(RUNNER_VERSION);
    const result = await run(["--version"]);
    expect(result.lines.join("").trim()).toBe(RUNNER_VERSION);
  });

  it("says login and checkout come later, and refuses unknown commands and flags", async () => {
    expect((await run(["login"])).lines.join("")).toContain("F-103");
    expect((await run(["checkout", "t1"])).code).toBe(exitCodes.usage);
    expect((await run(["fly"])).code).toBe(exitCodes.usage);
    const unknownFlag = await run(["runner", "--server", "http://127.0.0.1:1", "--turbo", "1"]);
    expect(unknownFlag.code).toBe(exitCodes.usage);
    expect(unknownFlag.lines.join("")).toContain("--turbo");
  });

  it("shows status for a runner that never signed in", async () => {
    const result = await run(["runner", "status", "--data-dir", dataDir]);
    expect(result.code).toBe(exitCodes.ok);
    expect(result.lines.join("")).toContain("not signed in");
  });
});
