import { createServer } from "node:net";

// Ports for a test's own servers that start later, in another process or after other work: a
// box's app process, a dev server, core spawned as its own process. Picking one with `listen(0)`
// and closing it (the old `freePort`) hands out a port of the OS's ephemeral range, which every
// `listen(0)` and outgoing connection on the machine draws from: on a loaded CI machine, another
// test's server took it before the process that was given it listened (an app process "failed
// with port-in-use", a "free" port answering).
//
// So these come from below every OS's ephemeral range (Linux 32768–60999, Windows and macOS
// 49152–65535), where nothing is handed out unasked. Each test process claims a block of its
// own by listening on the block's claim port for as long as it lives, so two test processes
// (vitest's workers, turbo's packages side by side) never pick the same port, and the claim goes
// when the process does, however it ends. Within its block a process takes the ports in turn, and
// skips one something listens on. With every block claimed, it falls back to `listen(0)`.

/** The claim ports: block `k`'s is `CLAIM_FIRST + k`. */
const CLAIM_FIRST = 20_000;
const BLOCKS = 64;
/** Block `k` is `[BLOCK_FIRST + k * BLOCK_SIZE, BLOCK_FIRST + (k + 1) * BLOCK_SIZE)`: the last ends at 31_620. */
const BLOCK_FIRST = 20_100;
const BLOCK_SIZE = 180;

type Block = { readonly first: number; readonly size: number };

/** Whether `host:port` takes a listener now. An address the machine lacks (no IPv6 loopback) counts as free. */
const listenable = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

/** Holds the first claim port no other process holds, for this process's life; `null` when every block is taken. */
const claimBlock = async (): Promise<Block | null> => {
  for (let index = 0; index < BLOCKS; index += 1) {
    const claim = createServer();
    const held = await new Promise<boolean>((resolve) => {
      claim.once("error", () => {
        resolve(false);
      });
      claim.listen(CLAIM_FIRST + index, "127.0.0.1", () => {
        resolve(true);
      });
    });
    if (held) {
      // Never keeps the process alive, and never closed: it goes with the process.
      claim.unref();
      return { first: BLOCK_FIRST + index * BLOCK_SIZE, size: BLOCK_SIZE };
    }
  }
  return null;
};

/** The OS's pick, as `listen(0)` makes it: only when every block is claimed. */
const osPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

let block: Promise<Block | null> | undefined;
let turn = 0;

/**
 * A loopback port no one listens on, for a server this test starts later: from this process's own
 * block, below the ephemeral range, so nothing else on the machine takes it in the meantime. Free
 * on `127.0.0.1` and `::1` both, as a server told `localhost` may take either.
 */
export const testPort = async (): Promise<number> => {
  block ??= claimBlock();
  const mine = await block;
  if (mine === null) {
    return osPort();
  }
  for (let tried = 0; tried < mine.size; tried += 1) {
    const port = mine.first + (turn % mine.size);
    turn += 1;
    if ((await listenable(port, "127.0.0.1")) && (await listenable(port, "::1"))) {
      return port;
    }
  }
  return osPort();
};
