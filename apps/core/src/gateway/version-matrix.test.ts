import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresCommandOutbox, runnerRowVersionState } from "@ostra/domain";
import { closeCodes, helloSchema, infoResponseSchema, infoResponseSchemaV3, runnerHeaders, runnerPaths } from "@ostra/protocol";
import type { Hello, RunnerId } from "@ostra/protocol";
import { minor4CommandFixtures, readRecordedBuild, RECORDED_SERVER_MINOR, recordedMinors } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { postHello } from "../testing/fake-http-peer.ts";
import { connectPeer } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { accessToken, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";

// Ticket 16 (F-061, ADR 0034, ADR 0022): the version window on both carriers, against core's real
// gateway at minor 4, with the recorded builds of `@ostra/protocol/testing` (minors 2 to 6): 3, 4
// and 5 work and are written to in their own minor; 2 and 6 are refused with the fix, and the
// refused runner is kept as outdated. And `GET /runner/v1/info`'s shape.

const SERVER_VERSION = "0.5.0";
let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;
const sockets: FakePeer[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  // The recordings were made against a minor-4 server (`RECORDED_SERVER_MINOR`): this gateway speaks it. Today's
  // minor-5 window over the same recordings is `packages/protocol`'s `version-matrix.test.ts`.
  harness = await startGateway(test.db, test.url, { serverMinor: RECORDED_SERVER_MINOR, serverVersion: SERVER_VERSION, runnerNpm: { package: "ostra", registry: "http://127.0.0.1:14873" } });
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.close();
  }
  await harness.stop();
  await test.dispose();
});

/** A recorded build's hello, as the registered runner `runnerId` sends it on `carrier`. */
const helloOf = async (minor: (typeof recordedMinors)[number], runnerId: RunnerId, carrier: Hello["carrier"]): Promise<Hello> => {
  const build = await readRecordedBuild(minor);
  return helloSchema.parse({ ...helloSchema.parse(build.hello), peer: { kind: "runner", runnerId }, carrier });
};

const fresh = async (): Promise<{ readonly runner: RegisteredRunner; readonly token: string }> => {
  const runner = await registerPersonal(harness, test.db, fixture.a.member);
  return { runner, token: (await accessToken(harness, runner)).accessToken };
};

/** The dispatch a minor-4 server sends, with a size and an image, addressed to this runner. */
const sendDispatch = async (runnerId: RunnerId): Promise<void> => {
  const { body } = minor4CommandFixtures["dispatch, with a size and an image"];
  await test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, fixture.a.organization.id, runnerId, { kind: "dispatch", body, notAfter: Date.now() + 60_000, task: null }),
  );
};

describe("the version window on both carriers (F-061)", () => {
  it("F-061/c1: the matrix: the recorded builds of minors 3, 4 and 5 connect on the WebSocket and over HTTP and are written to in their own minor; 2 and 6 are refused with the fix", async () => {
    expect(RECORDED_SERVER_MINOR).toBe(4);
    const seen: (readonly [number, string, number | string])[] = [];
    for (const minor of recordedMinors) {
      const build = await readRecordedBuild(minor);
      // The WebSocket.
      const ws = await fresh();
      const peer = await connectPeer(harness.url, ws.token, ws.runner.runnerId, { minor: build.negotiated ?? RECORDED_SERVER_MINOR, skipHello: true });
      sockets.push(peer);
      peer.sendText(JSON.stringify(await helloOf(minor, ws.runner.runnerId, "websocket")));
      if (build.negotiated === undefined) {
        const error = await peer.next("error");
        expect(error).toMatchObject({ code: "version-unsupported", supported: { min: 3, max: 5 }, serverMinor: 4 });
        expect(error.message).toContain(`This runner speaks protocol 1.${String(minor)}; this server accepts 1.3 to 1.5. Update it to v${SERVER_VERSION}.`);
        expect(await peer.closed).toBe(closeCodes.upgradeRequired);
        seen.push([minor, "websocket", "refused"]);
      } else {
        const welcome = await peer.next("welcome");
        expect(welcome.minor).toBe(build.negotiated);
        // What the build sends after hello is read, and what the server sends is in the build's minor.
        peer.sendText(JSON.stringify(build.status));
        await sendDispatch(ws.runner.runnerId);
        const dispatch = await peer.next("command");
        const raw = JSON.stringify(dispatch);
        expect(raw.includes('"box"')).toBe(build.negotiated >= 4);
        expect(dispatch).toMatchObject({ kind: "dispatch", body: z.looseObject({ body: z.record(z.string(), z.unknown()) }).parse(build.dispatch).body });
        seen.push([minor, "websocket", welcome.minor]);
        peer.close();
        await peer.closed;
      }
      // HTTP.
      const http = await fresh();
      const answer = await postHello(harness.url, http.token, await helloOf(minor, http.runner.runnerId, "http"));
      if (build.negotiated === undefined) {
        expect(answer.status).toBe(426);
        const [error] = answer.frames;
        expect(error).toMatchObject({ type: "error", code: "version-unsupported", supported: { min: 3, max: 5 } });
        expect(error?.type === "error" ? error.message : "").toContain(`Update it to v${SERVER_VERSION}.`);
        seen.push([minor, "http", "refused"]);
      } else {
        expect(answer.status).toBe(200);
        const [welcome] = answer.frames;
        expect(welcome).toMatchObject({ type: "welcome", minor: build.negotiated });
        seen.push([minor, "http", welcome?.type === "welcome" ? welcome.minor : "none"]);
      }
    }
    expect(seen).toEqual([
      [2, "websocket", "refused"],
      [2, "http", "refused"],
      [3, "websocket", 3],
      [3, "http", 3],
      [4, "websocket", 4],
      [4, "http", 4],
      [5, "websocket", 4],
      [5, "http", 4],
      [6, "websocket", "refused"],
      [6, "http", "refused"],
      [7, "websocket", "refused"],
      [7, "http", "refused"],
      [8, "websocket", "refused"],
      [8, "http", "refused"],
      [9, "websocket", "refused"],
      [9, "http", "refused"],
    ]);
  });

  it("F-061/c3: a refused runner is kept once with its version and minor, and the fleet view reads it as outdated", async () => {
    const { runner, token } = await fresh();
    const before = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(before.lastSeenAt).toBeNull();
    const hello = await helloOf(2, runner.runnerId, "http");
    expect((await postHello(harness.url, token, hello)).status).toBe(426);
    const refused = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(refused).toMatchObject({ minor: 2, version: "0.3.0", kind: "personal" });
    expect(refused.lastSeenAt).not.toBeNull();
    expect(runnerRowVersionState({ minor: RECORDED_SERVER_MINOR, version: SERVER_VERSION }, refused)).toBe("outside");
    // No row of its own, and no presence: it never connected.
    expect(await test.db.runner.count({ where: { ownerMemberId: fixture.a.member.id, publicKey: before.publicKey } })).toBe(1);
    expect(await test.db.runnerPresence.findUnique({ where: { runnerId: runner.runnerId } })).toBeNull();
    // Once: its retry with the same build writes nothing, on either carrier.
    const notices = async () => test.db.changeNotice.count({ where: { entityId: runner.runnerId } });
    const count = await notices();
    expect((await postHello(harness.url, token, hello)).status).toBe(426);
    const ws = await connectPeer(harness.url, token, runner.runnerId, { skipHello: true });
    sockets.push(ws);
    ws.sendText(JSON.stringify({ ...hello, carrier: "websocket" }));
    await ws.next("error");
    expect(await notices()).toBe(count);
    expect((await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).lastSeenAt).toEqual(refused.lastSeenAt);
    // Updated to a build inside the window, it connects, and its state follows.
    const updated = await connectPeer(harness.url, token, runner.runnerId, { minor: 3, skipHello: true });
    sockets.push(updated);
    updated.sendText(JSON.stringify(await helloOf(3, runner.runnerId, "websocket")));
    await updated.next("welcome");
    const current = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(current).toMatchObject({ minor: 3, version: "0.4.0" });
    expect(runnerRowVersionState({ minor: RECORDED_SERVER_MINOR, version: SERVER_VERSION }, current)).toBe("behind");
  });
});

describe("GET /runner/v1/info (F-061)", () => {
  it("F-061/c2: info's shape: the server's version, its window and where the pin installs from, at minor 4; minor 3's strict shape without the header", async () => {
    const atFour = await fetch(`${harness.url}${runnerPaths.info}`, { headers: { [runnerHeaders.minor]: "4" } });
    expect(atFour.status).toBe(200);
    const body = infoResponseSchema.parse(await atFour.json());
    expect(body).toMatchObject({
      protocolMajor: 1,
      serverMinor: 4,
      supported: { min: 3, max: 5 },
      serverVersion: SERVER_VERSION,
      minorWindow: { min: 3, max: 5 },
      npm: { package: "ostra", registry: "http://127.0.0.1:14873" },
    });
    // A runner below minor 4 sends no header, and reads minor 3's strict shape.
    const old = await fetch(`${harness.url}${runnerPaths.info}`);
    expect(infoResponseSchemaV3.safeParse(await old.json()).success).toBe(true);
    // A server that names no package (before milestone 7) answers `npm: null`.
    const plain = await startGateway(test.db, test.url, { serverMinor: RECORDED_SERVER_MINOR, serverVersion: SERVER_VERSION });
    try {
      const answer = infoResponseSchema.parse(await (await fetch(`${plain.url}${runnerPaths.info}`, { headers: { [runnerHeaders.minor]: "4" } })).json());
      expect(answer.npm).toBeNull();
    } finally {
      await plain.stop();
    }
  });
});
