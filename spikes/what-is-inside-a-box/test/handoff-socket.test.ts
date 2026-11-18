// The Kubernetes handoff path: the sidecar listens on a socket (a Unix socket;
// a named pipe on Windows), and handoff-client.ts delivers the handoff from
// stdin. Run here on whatever this machine has.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { boxId } from "../src/bridge/protocol.ts";
import { runCommand } from "../src/harness/commands.ts";
import { handoffSchema, listenForHandoff } from "../src/sidecar/handoff.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, "..", "src", "sidecar", "handoff-client.ts");

const socketPath = (): string => (process.platform === "win32" ? `\\\\.\\pipe\\ostra-handoff-test-${randomBytes(4).toString("hex")}` : path.join(tmpdir(), `ostra-handoff-test-${randomBytes(4).toString("hex")}.sock`));

const handoffFor = (nonce: string): string =>
  JSON.stringify(
    handoffSchema.parse({
      version: 1,
      nonce,
      taskId: "t-socket",
      bridgeNonce: randomBytes(24).toString("base64url"),
      controlToken: randomBytes(24).toString("base64url"),
      model: { kind: "stub", apiKey: randomBytes(16).toString("hex"), format: "openai" },
      git: { upstream: "stub", token: randomBytes(16).toString("hex"), repo: "ostra-test/app", taskBranch: "ostra/t-socket" },
    }),
  );

describe("handoff over a socket (the pod's path)", () => {
  it("accepts the handoff from handoff-client.ts, then closes", async () => {
    const nonce = randomBytes(24).toString("base64url");
    const sock = socketPath();
    const listener = await listenForHandoff({ boxId: boxId("box-socket"), nonce, host: "127.0.0.1", port: 0, socketPath: sock, network: { boxCidrs: [], sharedNetns: true }, log: () => undefined });
    expect(listener.port).toBe(0);
    const env = { ...process.env, OSTRA_HANDOFF_SOCKET: sock };
    const result = await runCommand(process.execPath, [client], { input: handoffFor(nonce), env, timeoutMs: 20_000 });
    expect(result.code).toBe(0);
    const received = await listener.received;
    expect(received.taskId).toBe("t-socket");
    // The listener closed: a second delivery fails.
    const again = await runCommand(process.execPath, [client], { input: handoffFor(nonce), env, timeoutMs: 20_000 });
    expect(again.code).not.toBe(0);
    await listener.close();
  });

  it("refuses a handoff with the wrong nonce", async () => {
    const sock = socketPath();
    const listener = await listenForHandoff({ boxId: boxId("box-socket"), nonce: randomBytes(24).toString("base64url"), host: "127.0.0.1", port: 0, socketPath: sock, network: { boxCidrs: [], sharedNetns: true }, log: () => undefined });
    const result = await runCommand(process.execPath, [client], { input: handoffFor(randomBytes(24).toString("base64url")), env: { ...process.env, OSTRA_HANDOFF_SOCKET: sock }, timeoutMs: 20_000 });
    expect(result.code).not.toBe(0);
    expect(listener.refused()).toBe(1);
    await listener.close();
  });
});

describe("handoff schema", () => {
  it("refuses a repo with . or .. segments", () => {
    const base: unknown = JSON.parse(handoffFor(randomBytes(24).toString("base64url")));
    const withRepo = (repo: string): unknown => ({ ...asObject(base), git: { ...asObject(asObject(base)["git"]), repo } });
    expect(handoffSchema.safeParse(withRepo("../..")).success).toBe(false);
    expect(handoffSchema.safeParse(withRepo("ostra-test/..")).success).toBe(false);
    expect(handoffSchema.safeParse(withRepo("ostra-test/app")).success).toBe(true);
  });
});

/** Narrows a parsed JSON value to an object for the test's spread. */
const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
};
