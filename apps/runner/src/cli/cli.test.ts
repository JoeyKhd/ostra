import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_MINOR } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnerOnly } from "../identity/owner-only.ts";
import { dataPaths, loadIdentity, updateStatus } from "../identity/store.ts";
import type { SignedIn } from "../sign-in.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import { startLockHolder } from "../testing/lock-holder.ts";
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

const run = async (args: readonly string[], env: CliDeps["env"] = {}, now?: () => number): Promise<Run> => {
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
    ...(now === undefined ? {} : { now }),
  });
  return { code, lines: terminal.lines(), signedIn };
};

const runner = (fake: FakeServer, ...extra: string[]): Promise<Run> =>
  run(["runner", "--server", fake.url, "--data-dir", dataDir, "--name", "laptop", ...extra]);

/** `ostra runner` on a machine whose clock reads `offsetMs` from the real one. */
const runnerWithClock = (fake: FakeServer, offsetMs: number): Promise<Run> =>
  run(["runner", "--server", fake.url, "--data-dir", dataDir, "--name", "laptop"], {}, () => Date.now() + offsetMs);

const HOUR = 3_600_000;

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
    expect(registered?.request).toMatchObject({ name: "laptop", executor: "host", capacity: 2, version: RUNNER_VERSION });
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

  it("F-013: a clock an hour behind the server's is named with its offset, and sign-in hands over to the connection instead of exiting", async () => {
    const fake = await start();
    await runner(fake);
    const skewed = await runnerWithClock(fake, -HOUR);
    // It went on to connect, which asks again with its backoff: no exit, no refusal for good.
    expect(skewed.code).toBe(exitCodes.ok);
    expect(skewed.signedIn).toBeDefined();
    const output = skewed.lines.join("");
    expect(output).toContain("this machine's clock is 3600 s behind the server's");
    expect(output).toContain("Retrying until the clocks agree");
    // The identity is fine, so nothing says to delete it, and nothing calls it revoked.
    expect(output).not.toContain(dataPaths(dataDir).identityDir);
    expect(output).not.toContain("revoked");
    expect(fake.tokenRequests.at(-1)?.minor).toBe(String(PROTOCOL_MINOR));
    const status = await run(["runner", "status", "--data-dir", dataDir]);
    expect(status.lines.join("")).toMatch(/Last refusal +\S+ clock-skew: .*3600 s behind/);
    // And an hour ahead says so the other way round.
    const ahead = await runnerWithClock(fake, HOUR);
    expect(ahead.code).toBe(exitCodes.ok);
    expect(ahead.lines.join("")).toContain("this machine's clock is 3600 s ahead of the server's");
  });

  it("F-013: a key the server doesn't know stops the runner with its own message and the advice to sign in again", async () => {
    const fake = await start();
    await runner(fake);
    fake.runners.clear();
    const refused = await runner(fake);
    expect(refused.code).toBe(exitCodes.refused);
    const output = refused.lines.join("");
    expect(output).toContain("The server doesn't know this runner's key");
    expect(output).not.toContain("revoked");
    expect(output).toContain(`To sign in again, delete ${dataPaths(dataDir).identityDir} and start the runner again.`);
    const status = await run(["runner", "status", "--data-dir", dataDir]);
    expect(status.lines.join("")).toMatch(/Last refusal +\S+ unknown-key:/);
  });

  it("F-013: a nonce the server says it saw is retried at once with a fresh assertion", async () => {
    const fake = await start();
    await runner(fake);
    const before = fake.tokenRequests.length;
    fake.tokenRefusals.push({
      status: 401,
      body: { error: { code: "unauthorized", message: "the assertion was already used", reason: "replayed" } },
    });
    const again = await runner(fake);
    expect(again.code).toBe(exitCodes.ok);
    expect(again.signedIn).toBeDefined();
    const asked = fake.tokenRequests.slice(before);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.nonce).not.toBe(asked[1]?.nonce);
    expect(again.lines.join("")).not.toContain("refused");
  });

  it("F-061: against a server before minor 2, a 401 without a reason is told as such and handed to the connection, never an exit", async () => {
    const fake = await start();
    await runner(fake);
    // A minor-1 server's 401: ostra's error body, with no reason.
    fake.tokenRefusals.push({ status: 401, body: { error: { code: "unauthorized", message: "the assertion was already used" } } });
    const result = await runner(fake);
    expect(result.code).toBe(exitCodes.ok);
    expect(result.signedIn).toBeDefined();
    const output = result.lines.join("");
    expect(output).toContain("The server refused the access token (401) without a reason. Retrying.");
    expect(output).not.toContain(dataPaths(dataDir).identityDir);
    // Its 403 was only ever a revoked runner, and still ends it.
    fake.tokenRefusals.push({ status: 403, body: { error: { code: "unauthorized", message: "this runner is revoked" } } });
    expect((await runner(fake)).code).toBe(exitCodes.refused);
  });

  it("refuses a server whose version window excludes this runner, with the fix", async () => {
    const fake = await start({ info: { serverMinor: 6, supported: { min: 5, max: 7 }, serverVersion: "0.6.0" } });
    const result = await runner(fake);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.lines.join("")).toContain("Install ostra 0.6.0");
    expect(fake.runners.size).toBe(0);
    expect(fake.requests.some((line) => line.includes("/api/auth/device/"))).toBe(false);

    const status = await run(["runner", "status", "--data-dir", dataDir]);
    expect(status.lines.join("")).toContain("protocol 1.5 to 1.7 (server ostra 0.6.0)");
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

  it("F-013: refuses to start while another runner on this machine holds its data folder, with exit code 4 and that runner's pid, and starts once it's gone", async () => {
    const fake = await start();
    await runner(fake);
    const before = fake.requests.length;
    const tokens = [...fake.tokensIssued.values()];
    const other = await startLockHolder(dataDir);
    try {
      const refused = await runner(fake);
      expect(refused.code).toBe(exitCodes.duplicate);
      expect(refused.lines.join("")).toContain(`Another ostra runner (pid ${String(other.pid)}) is running with this data folder, ${dataDir}`);
      // Refused before it signed in: no token, no registration, and no runner started.
      expect(refused.signedIn).toBeUndefined();
      expect(fake.requests.slice(before).filter((line) => /\/token|\/register|\/device/.test(line))).toEqual([]);
      expect([...fake.tokensIssued.values()]).toEqual(tokens);
    } finally {
      await other.crash();
    }
    // A crash leaves its lock behind; the next start takes it over.
    const again = await runner(fake);
    expect(again.code).toBe(exitCodes.ok);
    expect(again.signedIn).toBeDefined();
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

  it("refuses a login with no server, a checkout with no task, and unknown commands and flags", async () => {
    const login = await run(["login"], { APPDATA: dataDir, XDG_CONFIG_HOME: dataDir });
    expect(login.code).toBe(exitCodes.usage);
    expect(login.lines.join("")).toContain("--server <url>");
    expect((await run(["checkout"], { APPDATA: dataDir, XDG_CONFIG_HOME: dataDir })).code).toBe(exitCodes.usage);
    expect((await run(["checkout", "t1", "t2"], { APPDATA: dataDir, XDG_CONFIG_HOME: dataDir })).code).toBe(exitCodes.usage);
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

  it("F-013: shows the carrier of the last connection, and why it fell back to HTTP", async () => {
    await updateStatus(dataDir, { carrier: { at: Date.now(), carrier: "http", fallback: "no-welcome" } });
    const fellBack = (await run(["runner", "status", "--data-dir", dataDir])).lines.join("");
    expect(fellBack).toContain("Carrier         HTTP, fell back because the WebSocket upgrade succeeded but no welcome came within 10 s");
    await updateStatus(dataDir, { carrier: { at: Date.now(), carrier: "websocket", fallback: null } });
    expect((await run(["runner", "status", "--data-dir", dataDir])).lines.join("")).toContain("Carrier         WebSocket");
  });
});
