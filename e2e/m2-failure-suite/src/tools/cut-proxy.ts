import net from "node:net";

// Ported from spikes/runner-transport/src/harness/net-proxies.ts (`tcpProxy`). A loopback TCP proxy
// between a runner and core that can cut the network (ticket 38, spec section 8):
// - `hold`: stop forwarding. Bytes wait, closes wait, new connections hang: the path is gone but no
//   one says so, and TCP may carry the flow over the gap.
// - `reset`: the flow dies, as on a NAT rebind or a Wi-Fi roam. The runner's side is reset at once;
//   the server's side goes silent (a dropped flow says nothing to the far end) and never carries
//   another byte. New connections are reset until `restore()`.

export type CutMode = "hold" | "reset";

export type CutProxy = {
  readonly port: number;
  readonly url: string;
  readonly cut: (mode: CutMode) => void;
  readonly restore: () => void;
  readonly isCut: () => boolean;
  /** Connections it has accepted so far: a reconnect adds one. */
  readonly accepted: () => number;
  readonly close: () => Promise<void>;
};

type Pair = {
  readonly client: net.Socket;
  upstream: net.Socket | undefined;
  toUpstream: Buffer[];
  toClient: Buffer[];
  clientClosed: boolean;
  upstreamClosed: boolean;
  /** The flow was reset: nothing is forwarded on it again. */
  dead: boolean;
};

export const startCutProxy = async (target: { readonly host: string; readonly port: number }): Promise<CutProxy> => {
  let cutNow = false;
  let cutMode: CutMode = "hold";
  let accepted = 0;
  const pairs = new Set<Pair>();

  const connectUpstream = (pair: Pair): void => {
    const upstream = net.connect(target.port, target.host);
    upstream.setNoDelay(true);
    let connected = false;
    upstream.on("connect", () => {
      connected = true;
      pair.upstream = upstream;
      if (pair.clientClosed || pair.dead) {
        upstream.destroy();
        return;
      }
      if (!cutNow) for (const chunk of pair.toUpstream.splice(0)) upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (pair.dead) return;
      if (cutNow) pair.toClient.push(chunk);
      else pair.client.write(chunk);
    });
    upstream.on("error", () => {
      if (!connected) pair.client.destroy();
    });
    upstream.on("close", () => {
      if (!connected) return;
      pair.upstreamClosed = true;
      if (pair.dead) pairs.delete(pair);
      else if (!cutNow) pair.client.destroy();
    });
  };

  const server = net.createServer((client) => {
    client.on("error", () => undefined);
    if (cutNow && cutMode === "reset") {
      client.resetAndDestroy();
      return;
    }
    accepted += 1;
    client.setNoDelay(true);
    const pair: Pair = { client, upstream: undefined, toUpstream: [], toClient: [], clientClosed: false, upstreamClosed: false, dead: false };
    pairs.add(pair);
    client.on("data", (chunk: Buffer) => {
      if (pair.dead) return;
      if (cutNow || pair.upstream === undefined) pair.toUpstream.push(chunk);
      else pair.upstream.write(chunk);
    });
    client.on("close", () => {
      pair.clientClosed = true;
      if (pair.dead) return;
      if (!cutNow) {
        pair.upstream?.destroy();
        pairs.delete(pair);
      }
    });
    if (!cutNow) connectUpstream(pair);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    cut: (mode) => {
      cutNow = true;
      cutMode = mode;
      if (mode !== "reset") return;
      for (const pair of [...pairs]) {
        pair.dead = true;
        pair.toUpstream = [];
        pair.toClient = [];
        pair.client.resetAndDestroy();
        // The server's side hears nothing, as a dropped flow says nothing to the far end.
        if (pair.upstream === undefined || pair.upstreamClosed) pairs.delete(pair);
      }
    },
    restore: () => {
      cutNow = false;
      for (const pair of [...pairs]) {
        if (pair.dead) continue;
        if (pair.clientClosed) {
          pair.upstream?.destroy();
          pairs.delete(pair);
          continue;
        }
        if (pair.upstream === undefined) {
          connectUpstream(pair);
          continue;
        }
        if (pair.upstreamClosed) {
          pair.client.destroy();
          pairs.delete(pair);
          continue;
        }
        for (const chunk of pair.toUpstream.splice(0)) pair.upstream.write(chunk);
        for (const chunk of pair.toClient.splice(0)) pair.client.write(chunk);
      }
    },
    isCut: () => cutNow,
    accepted: () => accepted,
    close: async () => {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream?.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        setTimeout(resolve, 1000).unref();
      });
    },
  };
};
