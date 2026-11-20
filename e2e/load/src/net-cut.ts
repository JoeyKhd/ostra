import net from "node:net";

// A TCP forwarder in front of one core replica (ticket 34): the simulated runners connect through
// it, so the reconnect storm can cut every runner's connection at once, as a network failure does,
// and let each runner come back on its own: the runner's real backoff, token and resend, nothing
// told to it.

export type NetCut = {
  readonly url: string;
  /** Destroys every connection open now. New ones pass as before. */
  readonly cut: () => number;
  readonly close: () => Promise<void>;
};

export const startNetCut = async (targetPort: number): Promise<NetCut> => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  });
  server.maxConnections = 100_000;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    cut: () => {
      const count = sockets.size / 2;
      for (const socket of sockets) socket.destroy();
      return count;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
