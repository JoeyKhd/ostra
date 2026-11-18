import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAppender, type WakeItem } from "./appender.ts";
import { createHandler, type Services } from "./app.ts";
import type { ServerSettings } from "./config.ts";
import { createPool, exec } from "./db.ts";
import { createLogger } from "./log.ts";
import { createSseMetrics } from "./sse.ts";
import { createTailer } from "./tailer.ts";
import { createWakeListener, createWakeSender } from "./wake.ts";

export type RunningServer = {
  readonly port: number;
  readonly services: Services;
  readonly stop: () => Promise<void>;
};

// One replica: stateless, serves any task, holds one tailer and one LISTEN connection (ADR 0035).
export const startServer = async (settings: ServerSettings): Promise<RunningServer> => {
  const log = createLogger(settings.OSTRA_SPIKE_REPLICA_ID, settings.OSTRA_SPIKE_QUIET === "1");
  const db = createPool(settings.DATABASE_URL, settings.OSTRA_SPIKE_PG_POOL, settings.OSTRA_SPIKE_PG_IDLE_MS);
  const tailer = createTailer(db, settings.OSTRA_SPIKE_POLL_MS, log);
  const sender = createWakeSender(db, settings.OSTRA_SPIKE_REPLICA_ID, log);
  const listener = createWakeListener(
    settings.DATABASE_URL,
    settings.OSTRA_SPIKE_REPLICA_ID,
    (items) => {
      tailer.wake(items);
    },
    () => {
      tailer.markAllDirty();
    },
    log,
  );
  const afterCommit = (wake: WakeItem[]): void => {
    // the writing replica wakes its own subscribers, then sends one NOTIFY for the others
    tailer.wake(wake);
    void sender.send(wake);
  };
  const appender = createAppender(db, settings.OSTRA_SPIKE_FLUSH_MS, afterCommit, log);
  const services: Services = { settings, db, appender, tailer, sender, listener, log, sseMetrics: createSseMetrics(), afterCommit };
  const handler = createHandler(services);
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  server.keepAliveTimeout = 65_000;
  await listener.start();
  tailer.start();
  await new Promise<void>((resolve) => {
    server.listen(settings.PORT, settings.HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const port = (address satisfies AddressInfo).port;

  // A partial nobody refreshed for a minute belongs to a dead segment: remove it.
  const janitor = setInterval(() => {
    void exec(db, "DELETE FROM task_live_text WHERE updated_at < now() - interval '60 seconds'").catch(() => undefined);
  }, 15_000);

  log.info("server.listening", { port });
  return {
    port,
    services,
    stop: async () => {
      clearInterval(janitor);
      tailer.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await listener.stop();
      await db.end();
    },
  };
};
