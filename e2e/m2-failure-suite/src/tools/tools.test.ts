import http from "node:http";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startCutProxy } from "./cut-proxy.ts";
import { mutationOf, startFaultProxy } from "./fault-proxy.ts";
import { descendantsOf } from "./procs.ts";

// The failure suite's own tools (ticket 38): the cut proxy's two modes, the fault proxy's
// write-then-500, and the process tree the kill helpers walk. The suite's cases rest on them.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

/** An echo server: what a socket sends comes back. */
const echo = async (): Promise<number> => {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  closers.push(() => new Promise((resolve) => server.close(() => { resolve(); })));
  return listen(server);
};

const connect = (port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });

const nextData = (socket: net.Socket, timeoutMs: number): Promise<string | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("data", onData);
      resolve(null);
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    };
    socket.once("data", onData);
  });

describe("the cut proxy (spike 6's, spec section 8)", () => {
  it("hold: nothing passes during the cut, and what waited arrives after it", async () => {
    const proxy = await startCutProxy({ host: "127.0.0.1", port: await echo() });
    closers.push(proxy.close);
    const socket = await connect(proxy.port);
    socket.write("before");
    expect(await nextData(socket, 2000)).toBe("before");
    proxy.cut("hold");
    socket.write("during");
    expect(await nextData(socket, 500)).toBeNull();
    const arrived = nextData(socket, 2000);
    proxy.restore();
    expect(await arrived).toBe("during");
    socket.destroy();
  });

  it("reset: the flow dies at once, and a new connection is refused until the cut ends", async () => {
    const proxy = await startCutProxy({ host: "127.0.0.1", port: await echo() });
    closers.push(proxy.close);
    const socket = await connect(proxy.port);
    const closed = new Promise<boolean>((resolve) => socket.once("close", () => { resolve(true); }));
    socket.on("error", () => undefined);
    proxy.cut("reset");
    expect(await closed).toBe(true);
    const refused = await connect(proxy.port).then(
      async (again) => {
        again.on("error", () => undefined);
        const ended = await new Promise<boolean>((resolve) => again.once("close", () => { resolve(true); }));
        return ended;
      },
      () => true,
    );
    expect(refused).toBe(true);
    proxy.restore();
    const fresh = await connect(proxy.port);
    fresh.write("after");
    expect(await nextData(fresh, 2000)).toBe("after");
    fresh.destroy();
    expect(proxy.accepted()).toBe(2);
  });
});

describe("the fault proxy (spec section 8)", () => {
  it("reads a GraphQL mutation's root field, and nothing from a query", () => {
    expect(mutationOf(JSON.stringify({ query: "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }" }))).toBe("commentCreate");
    expect(mutationOf(JSON.stringify({ query: "mutation Link { made: attachmentCreate(input: {}) { success } }" }))).toBe("attachmentCreate");
    expect(mutationOf(JSON.stringify({ query: "query { viewer { id } }" }))).toBeNull();
    expect(mutationOf("not json")).toBeNull();
  });

  it("forwards a matching write, lets it apply, and answers 500; the next call passes", async () => {
    let applied = 0;
    const service = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        applied += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ number: applied }));
      });
    });
    const port = await listen(service);
    closers.push(() => new Promise((resolve) => service.close(() => { resolve(); })));
    const proxy = await startFaultProxy(`http://127.0.0.1:${String(port)}`);
    closers.push(proxy.close);
    proxy.arm({ name: "create a PR", match: (request) => request.method === "POST" && request.path.endsWith("/pulls") });
    const first = await fetch(`${proxy.url}/repos/o/r/pulls`, { method: "POST", body: "{}" });
    expect(first.status).toBe(500);
    expect(applied).toBe(1);
    const second = await fetch(`${proxy.url}/repos/o/r/pulls`, { method: "POST", body: "{}" });
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ number: 2 });
    expect(proxy.fired().map((one) => [one.name, one.upstreamStatus])).toEqual([["create a PR", 201]]);
    expect(proxy.armed()).toEqual([]);
  });
});

describe("the process tree the kill helpers walk", () => {
  it("finds every process under a root, at any depth, and nothing beside it", () => {
    const table = [
      { pid: 10, parentPid: 1, name: "node.exe" },
      { pid: 11, parentPid: 10, name: "opencode.exe" },
      { pid: 12, parentPid: 11, name: "git.exe" },
      { pid: 20, parentPid: 1, name: "other.exe" },
    ];
    expect(descendantsOf(table, 10).map((row) => row.pid).sort()).toEqual([11, 12]);
    expect(descendantsOf(table, 20)).toEqual([]);
  });
});
