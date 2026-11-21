import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { testPort } from "@ostra/adapter-sdk/testing/net";
import type { Db } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { PROTOCOL_MINOR, registerResponseSchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { CommandAck, DownFrame, LeaseEpoch, RunnerEvent, RunnerId, SessionId, TaskEvent, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { KillPointName } from "../kill-points.ts";
import { connectPeer, makeRunnerKey, signAssertion } from "./fake-peer.ts";
import type { FakePeer, RunnerKey } from "./fake-peer.ts";
import { postJson, registerBody, seedDeviceSession } from "./harness.ts";

// The restart harness (ticket 21, F-043): core in its own process against one database, killed with
// SIGKILL at a named point (`src/kill-points.ts`) and started again, and a runner that behaves as
// the real one does across it: it spools every event until the server acks it, reconnects when the
// socket goes, says in `hello` which command it applied last and where each session stands, resends
// what wasn't acked, and applies each command once by its ID. Nothing here sleeps for a fixed time:
// every wait polls a condition with a deadline.

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A free loopback port: core is started on the same one each time, as a restarted server is. One
 * of this test process's own (`testPort`), below the ephemeral range, so no other server takes it
 * while core starts, or between a kill and the restart.
 */
export const freePort = (): Promise<number> => testPort();

/** Polls `check` until it's true, or fails after `timeoutMs` with `what`. */
export const waitFor = async (what: string, check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
};

export type CoreProcess = {
  readonly url: string;
  readonly port: number;
  /** Resolves with the exit code (null when a signal ended it). */
  readonly exited: Promise<number | null>;
  /** Its stderr, one log line each, for a failing test's message. */
  readonly logs: readonly string[];
  /** Ends it at once, as `kill -9` does, and waits for it to be gone. */
  readonly kill: () => Promise<void>;
  /** Whether it has exited. */
  readonly dead: () => boolean;
};

const listeningSchema = z.object({ listening: z.number().int().positive() });

/** Starts core as its own process with `env`, armed at `killAt` if given, and waits until it listens. */
export const spawnCore = (env: NodeJS.ProcessEnv, killAt: KillPointName | null, timeoutMs = 90_000): Promise<CoreProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "restart-child.ts")], {
      env: { ...env, CORE_TEST_KILL_POINT: killAt ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => {
      logs.push(line);
      if (logs.length > 400) {
        logs.shift();
      }
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => {
        resolveExit(code);
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`core didn't start in ${String(timeoutMs)} ms:\n${logs.slice(-30).join("\n")}`));
    }, timeoutMs);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`core exited (${String(code)}) before it listened:\n${logs.slice(-30).join("\n")}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = listeningSchema.safeParse(json);
      if (!parsed.success) {
        return;
      }
      clearTimeout(timer);
      resolve({
        url: `http://127.0.0.1:${String(parsed.data.listening)}`,
        port: parsed.data.listening,
        exited,
        dead: () => child.exitCode !== null || child.signalCode !== null,
        logs,
        kill: async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          await exited;
        },
      });
    });
  });

// ---------- the runner ----------

export type RegisteredAt = { readonly key: RunnerKey; readonly runnerId: RunnerId };

/** Registers a personal runner of `member` with the core at `url`, as `ostra runner` does. */
export const registerRunnerAt = async (url: string, db: Db, member: SeededMember): Promise<RegisteredAt> => {
  const key = await makeRunnerKey();
  const session = await seedDeviceSession(db, member);
  // Room for every task a run makes: a slot is held by each task left running.
  const response = await postJson(`${url}${runnerPaths.register}`, registerBody(key, { capacity: 100 }), session);
  if (response.status !== 201) {
    throw new Error(`register answered ${String(response.status)}`);
  }
  return { key, runnerId: registerResponseSchema.parse(response.body).runnerId };
};

type SessionPlace = { readonly taskId: TaskId; readonly sessionId: SessionId; leaseEpoch: LeaseEpoch; nextSeq: number };

export type SpoolingRunner = {
  readonly runnerId: RunnerId;
  /** Connects (again) to `url` with what it applied and where each session stands, then resends what wasn't acked. */
  readonly connect: (url: string) => Promise<void>;
  /** Waits for the socket to close: the server died. */
  readonly lost: () => Promise<void>;
  /** Spools events for a session and sends them in one frame. They stay spooled until acked. */
  readonly send: (session: { readonly taskId: TaskId; readonly sessionId: SessionId; readonly leaseEpoch: LeaseEpoch }, ...events: TaskEvent[]) => void;
  /** Waits until the server acked the session up to `seq`. */
  readonly acked: (sessionId: SessionId, seq: number, timeoutMs?: number) => Promise<void>;
  /** Every command it received, by ID, and how many times each arrived. */
  readonly received: ReadonlyMap<string, { readonly kind: string; readonly body: unknown; times: number }>;
  /** How many times it applied each command: once, by its ID. */
  readonly applied: ReadonlyMap<string, number>;
  readonly close: () => void;
};

/** A runner that keeps a spool, as `apps/runner` does (ADR 0034). Dispatch offers are accepted. */
export const spoolingRunner = (registered: RegisteredAt): SpoolingRunner => {
  const spool: RunnerEvent[] = [];
  const sessions = new Map<SessionId, SessionPlace>();
  const ackedUpTo = new Map<SessionId, number>();
  const received = new Map<string, { readonly kind: string; readonly body: unknown; times: number }>();
  const applied = new Map<string, number>();
  let lastCommandSeq = 0;
  let peer: FakePeer | null = null;
  let seen = 0;
  let pump: ReturnType<typeof setInterval> | null = null;

  const sendFrame = (events: readonly RunnerEvent[]): void => {
    if (peer !== null && events.length > 0) {
      peer.send({ type: "events", events: [...events] });
    }
  };

  const handle = (frame: DownFrame, current: FakePeer): void => {
    switch (frame.type) {
      case "ack": {
        ackedUpTo.set(frame.sessionId, Math.max(ackedUpTo.get(frame.sessionId) ?? 0, frame.upTo));
        for (let index = spool.length - 1; index >= 0; index -= 1) {
          const item = spool[index];
          if (item?.sessionId === frame.sessionId && item.sessionSeq <= frame.upTo) {
            spool.splice(index, 1);
          }
        }
        if (frame.resendFrom !== undefined) {
          sendFrame(spool.filter((item) => item.sessionId === frame.sessionId));
        }
        return;
      }
      case "command": {
        const known = received.get(frame.id);
        if (known === undefined) {
          received.set(frame.id, { kind: frame.kind, body: frame.body, times: 1 });
        } else {
          known.times += 1;
        }
        // Applied once by its ID; a resend is answered again, never applied again.
        if (!applied.has(frame.id)) {
          applied.set(frame.id, 1);
        }
        lastCommandSeq = Math.max(lastCommandSeq, frame.seq);
        const ack: CommandAck = {
          type: "command-ack",
          upTo: lastCommandSeq,
          results: [{ id: frame.id, seq: frame.seq, result: frame.kind === "dispatch" ? "accepted" : "done" }],
        };
        current.send(ack);
        return;
      }
      case "welcome":
      case "credit":
      case "error":
      case "evict":
      case "goaway":
        // Nothing this runner acts on: the socket closing is what a lost server looks like.
        return;
      default:
        frame satisfies never;
    }
  };

  return {
    runnerId: registered.runnerId,
    received,
    applied,
    connect: async (url) => {
      const token = await postJson(`${url}${runnerPaths.token}`, signAssertion(registered.key, registered.runnerId));
      if (token.status !== 200) {
        throw new Error(`token answered ${String(token.status)}`);
      }
      const next = await connectPeer(url, tokenResponseSchema.parse(token.body).accessToken, registered.runnerId, {
        minor: PROTOCOL_MINOR - 1,
        lastCommandSeq,
        sessions: [...sessions.values()].map((place) => ({
          taskId: place.taskId,
          sessionId: place.sessionId,
          leaseEpoch: place.leaseEpoch,
          nextSessionSeq: place.nextSeq,
        })),
      });
      peer = next;
      seen = 0;
      await next.next("welcome");
      if (pump !== null) {
        clearInterval(pump);
      }
      pump = setInterval(() => {
        const current = peer;
        if (current === null) {
          return;
        }
        while (seen < current.frames.length) {
          const frame = current.frames[seen];
          seen += 1;
          if (frame !== undefined) {
            handle(frame, current);
          }
        }
      }, 10);
      // What the server didn't ack before it went.
      sendFrame([...spool]);
    },
    lost: async () => {
      const current = peer;
      if (current !== null) {
        await current.closed;
      }
    },
    send: (session, ...events) => {
      const place = sessions.get(session.sessionId) ?? { taskId: session.taskId, sessionId: session.sessionId, leaseEpoch: session.leaseEpoch, nextSeq: 1 };
      place.leaseEpoch = session.leaseEpoch;
      sessions.set(session.sessionId, place);
      const items = events.map((event): RunnerEvent => {
        const item = { sessionId: session.sessionId, sessionSeq: place.nextSeq, leaseEpoch: session.leaseEpoch, at: Date.now(), event };
        place.nextSeq += 1;
        return item;
      });
      spool.push(...items);
      sendFrame(items);
    },
    acked: (sessionId, seq, timeoutMs = 60_000) => waitFor(`the ack of ${sessionId} up to ${String(seq)}`, () => (ackedUpTo.get(sessionId) ?? 0) >= seq, timeoutMs),
    close: () => {
      if (pump !== null) {
        clearInterval(pump);
      }
      peer?.close();
      peer = null;
    },
  };
};
