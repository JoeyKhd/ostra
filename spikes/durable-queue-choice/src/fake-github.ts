// A fake GitHub that counts idempotency keys. It is a stand-in for the real code host, which the
// pass bar allows for this scenario. A real run against the test org stays SKIPPED territory for
// spike 4, not this one.
//
// The endpoints have GitHub's shape, so the lookup a handler makes here is the one the real adapter
// will make (a pull request found again by its branch), not a call that only the fake offers:
//
//   GET  /repos/<owner>/<repo>/pulls?head=<owner>:<branch>&state=all   200 + an array of the pull
//        requests whose head is that branch (empty if none)
//   POST /repos/<owner>/<repo>/pulls   body {title, head, base}, header Idempotency-Key = the key
//        the branch is named after (`ostra/<key>`). Every POST is counted per key, a duplicate too.
//        A second pull request for a head that already has one is answered 422, as GitHub does.
//
// Two hold headers let the harness stop a request at an exact point (scenario C2):
//
//   x-hold-before-ms   the fake holds the request before it counts it. If the client goes away
//                      meanwhile, the request is dropped and never counted: a kill before the effect lands.
//   x-hold-ms          the fake counts and applies the request, then holds the response. The effect
//                      exists, and the client does not know yet: a kill after the effect and before
//                      the handler has recorded it.

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { BRANCH_PREFIX, PULLS_PATH } from "./code-host.ts";

export type KeyCount = { readonly posts: number; readonly gets: number };

export type FakeGithub = {
  readonly url: string;
  counts: () => ReadonlyMap<string, KeyCount>;
  /** Keys that were POSTed more than once. */
  duplicates: () => readonly string[];
  totalPosts: () => number;
  /** Requests received and held before being counted. */
  heldBeforeCount: () => number;
  close: () => Promise<void>;
};

const postBodySchema = z.object({
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!(chunk instanceof Buffer)) {
      continue;
    }
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const holdSchema = z.coerce.number().int().min(0).max(120_000);

const holdHeader = (request: IncomingMessage, name: string): number => {
  const raw = request.headers[name];
  if (typeof raw !== "string") {
    return 0;
  }
  const parsed = holdSchema.safeParse(raw);
  return parsed.success ? parsed.data : 0;
};

/** Waits `ms`. Resolves false at once if the client's socket closes first. */
const holdUnlessClosed = (request: IncomingMessage, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const { socket } = request;
    if (socket.destroyed) {
      resolve(false);
      return;
    }
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve(true);
    }, ms);
    socket.once("close", onClose);
  });

export const startFakeGithub = async (): Promise<FakeGithub> => {
  const posts = new Map<string, number>();
  const gets = new Map<string, number>();
  const pulls = new Map<string, { readonly number: number; readonly title: string }>();
  let held = 0;

  const server: Server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === PULLS_PATH) {
        const head = url.searchParams.get("head") ?? "";
        const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
        const key = branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
        gets.set(key, (gets.get(key) ?? 0) + 1);
        const found = pulls.get(branch);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(found === undefined ? [] : [{ number: found.number, title: found.title, head: { ref: branch } }]));
        return;
      }

      if (method === "POST" && url.pathname === PULLS_PATH) {
        const header = request.headers["idempotency-key"];
        const body: unknown = JSON.parse(await readBody(request));
        const parsed = postBodySchema.parse(body);
        if (typeof header !== "string" || parsed.head !== `${BRANCH_PREFIX}${header}`) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "the Idempotency-Key header must be the key the branch is named after" }));
          return;
        }
        const holdBefore = holdHeader(request, "x-hold-before-ms");
        if (holdBefore > 0) {
          held += 1;
          const stillThere = await holdUnlessClosed(request, holdBefore);
          held -= 1;
          if (!stillThere) {
            return;
          }
        }
        const count = (posts.get(header) ?? 0) + 1;
        posts.set(header, count);
        const existing = pulls.get(parsed.head);
        const created = existing ?? { number: pulls.size + 1, title: parsed.title };
        if (existing === undefined) {
          pulls.set(parsed.head, created);
        }
        const holdAfter = holdHeader(request, "x-hold-ms");
        if (holdAfter > 0 && !(await holdUnlessClosed(request, holdAfter))) {
          return;
        }
        if (existing === undefined) {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ number: created.number, head: { ref: parsed.head } }));
        } else {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "Validation Failed", errors: [{ message: "A pull request already exists for this head" }] }));
        }
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    };

    handle().catch(() => {
      if (!response.headersSent && !request.socket.destroyed) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad request" }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake github did not bind to a TCP port");
  }
  const { port }: AddressInfo = address;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    counts: () => {
      const all = new Map<string, KeyCount>();
      for (const key of new Set([...posts.keys(), ...gets.keys()])) {
        all.set(key, { posts: posts.get(key) ?? 0, gets: gets.get(key) ?? 0 });
      }
      return all;
    },
    duplicates: () => [...posts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
    totalPosts: () => [...posts.values()].reduce((sum, count) => sum + count, 0),
    heldBeforeCount: () => held,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
