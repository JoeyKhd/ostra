import { Client } from "pg";
import { z } from "zod";
import { TaskId } from "../shared/ids.ts";
import type { WakeItem } from "./appender.ts";
import type { Db } from "./db.ts";
import type { Logger } from "./log.ts";

// ADR 0035: after a commit, one NOTIFY per writer per batch window. The payload is small (task IDs and
// their highest seq) and is a wake-up only: it never carries content.
const CHANNEL = "ostra_wake";
const MAX_PAYLOAD_BYTES = 7000;

const wakePayload = z.strictObject({
  r: z.string(),
  i: z.array(z.tuple([TaskId, z.number(), z.number()])),
});

export type WakeSender = {
  readonly send: (items: readonly WakeItem[]) => Promise<void>;
  readonly notifies: () => number;
};

export const createWakeSender = (db: Db, replicaId: string, log: Logger): WakeSender => {
  let notifies = 0;
  return {
    notifies: () => notifies,
    send: async (items) => {
      if (items.length === 0) return;
      const chunks: string[] = [];
      let current: [string, number, number][] = [];
      let size = 40 + replicaId.length;
      for (const item of items) {
        const entrySize = item.taskId.length + 24;
        if (size + entrySize > MAX_PAYLOAD_BYTES && current.length > 0) {
          chunks.push(JSON.stringify({ r: replicaId, i: current }));
          current = [];
          size = 40 + replicaId.length;
        }
        current.push([item.taskId, item.seq, item.live ? 1 : 0]);
        size += entrySize;
      }
      if (current.length > 0) chunks.push(JSON.stringify({ r: replicaId, i: current }));
      try {
        for (const chunk of chunks) {
          await db.query("SELECT pg_notify($1, $2)", [CHANNEL, chunk]);
          notifies += 1;
        }
      } catch {
        // the 250 ms poll still delivers; a lost wake-up costs latency, never data
        log.warn("wake.send_failed", { chunks: chunks.length });
      }
    },
  };
};

export type WakeListener = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly received: () => number;
};

// One dedicated, direct LISTEN connection per replica (ADR 0034).
export const createWakeListener = (
  databaseUrl: string,
  replicaId: string,
  onWake: (items: WakeItem[]) => void,
  onReconnect: () => void,
  log: Logger,
): WakeListener => {
  let received = 0;
  let client: Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;

  const start = async (): Promise<void> => {
    stopped = false;
    const next = new Client({ connectionString: databaseUrl });
    next.on("notification", (message) => {
      if (message.channel !== CHANNEL || message.payload === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.payload);
      } catch {
        return;
      }
      const payload = wakePayload.safeParse(parsed);
      if (!payload.success || payload.data.r === replicaId) return;
      received += 1;
      onWake(payload.data.i.map(([taskId, seq, live]) => ({ taskId, seq, live: live === 1 })));
    });
    next.on("error", () => {
      log.warn("wake.listen_error");
      reconnect();
    });
    next.on("end", () => {
      reconnect();
    });
    await next.connect();
    await next.query(`LISTEN ${CHANNEL}`);
    client = next;
  };

  function reconnect(): void {
    if (stopped || retry !== null) return;
    const old = client;
    client = null;
    if (old !== null) void old.end().catch(() => undefined);
    retry = setTimeout(() => {
      retry = null;
      start()
        .then(() => {
          onReconnect();
        })
        .catch(() => {
          reconnect();
        });
    }, 500);
  }

  return {
    start,
    received: () => received,
    stop: async () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      const current = client;
      client = null;
      if (current !== null) await current.end().catch(() => undefined);
    },
  };
};
