import net from "node:net";

// A TCP proxy a test can break in front of the server, in the two ways a network breaks.
//  - cut(): the friendly failure. Every socket is destroyed, so the browser's EventSource errors at once and
//    reconnects; while the proxy is down it still accepts connections, records the headers a reconnecting
//    EventSource sends (Last-Event-ID), and drops them.
//  - blackhole(): the unfriendly one (Wi-Fi roaming, a NAT that forgets the flow, a laptop that sleeps). Every
//    open socket stays open and silent: nothing is forwarded either way, ever, as if the flow were lost.
//    A new connection made while it lasts hangs, unanswered; restore() lets those through.
export type ProxyAttempt = { at: number; mode: ProxyMode; lastEventId: string | null };
export type ProxyMode = "up" | "cut" | "blackhole";

type Connection = {
  readonly client: net.Socket;
  upstream: net.Socket | null;
  // set when the flow was black-holed under it: its data goes nowhere, for good
  dead: boolean;
  // the first request, held while the proxy is black-holed
  held: Buffer | null;
};

export type ToggleProxy = {
  readonly start: () => Promise<number>;
  readonly port: () => number;
  readonly mode: () => ProxyMode;
  readonly attempts: ProxyAttempt[];
  readonly cut: () => void;
  readonly blackhole: () => void;
  readonly restore: () => void;
  readonly stop: () => Promise<void>;
};

export const createToggleProxy = (targetPort: number): ToggleProxy => {
  let listening = 0;
  let mode: ProxyMode = "up";
  let server: net.Server | null = null;
  const attempts: ProxyAttempt[] = [];
  const connections = new Set<Connection>();

  const forward = (connection: Connection, first: Buffer): void => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    connection.upstream = upstream;
    upstream.on("close", () => {
      connection.client.destroy();
    });
    upstream.on("error", () => {
      connection.client.destroy();
    });
    upstream.on("data", (back: Buffer) => {
      if (!connection.dead && mode !== "cut") connection.client.write(back);
    });
    upstream.write(first);
  };

  return {
    attempts,
    port: () => listening,
    mode: () => mode,
    start: () =>
      new Promise((resolve, reject) => {
        const created = net.createServer((client) => {
          const connection: Connection = { client, upstream: null, dead: false, held: null };
          connections.add(connection);
          client.on("error", () => undefined);
          client.on("close", () => {
            connections.delete(connection);
            connection.upstream?.destroy();
          });
          let first = true;
          client.on("data", (chunk: Buffer) => {
            if (connection.dead) return;
            if (first) {
              first = false;
              const head = chunk.toString("latin1");
              // the header a reconnecting EventSource sends, or the query a page's own watchdog reconnect passes
              const match = /^last-event-id:\s*(\d+)/im.exec(head) ?? /lastEventId=(\d+)/.exec(head);
              if (head.includes("/stream")) attempts.push({ at: Date.now(), mode, lastEventId: match?.[1] ?? null });
              if (mode === "cut") {
                client.destroy();
                return;
              }
              if (mode === "blackhole") {
                connection.held = chunk;
                return;
              }
              forward(connection, chunk);
              return;
            }
            if (connection.upstream !== null && mode === "up") connection.upstream.write(chunk);
          });
        });
        created.once("error", reject);
        created.listen(0, "127.0.0.1", () => {
          const address = created.address();
          if (address === null || typeof address === "string") {
            reject(new Error("no address"));
            return;
          }
          listening = address.port;
          server = created;
          resolve(address.port);
        });
      }),
    cut: () => {
      mode = "cut";
      for (const connection of connections) {
        connection.client.destroy();
        connection.upstream?.destroy();
      }
      connections.clear();
    },
    blackhole: () => {
      mode = "blackhole";
      // what is open now is lost for good; the sockets stay open
      for (const connection of connections) {
        if (connection.held === null) connection.dead = true;
      }
    },
    restore: () => {
      mode = "up";
      for (const connection of connections) {
        const held = connection.held;
        if (held === null || connection.dead) continue;
        connection.held = null;
        forward(connection, held);
      }
    },
    stop: async () => {
      mode = "cut";
      for (const connection of connections) {
        connection.client.destroy();
        connection.upstream?.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
