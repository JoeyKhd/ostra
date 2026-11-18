// A stand-in for ostra's server and its blob store (ADR 0043): the runner
// uploads the session archive through the server, which needs only one
// address. One HTTP server on loopback, a bearer token per run, files on disk.
//
//   PUT /blobs/<task>/<name>   stores the body; answers {bytes, sha256}
//   GET /blobs/<task>/<name>   returns it
//
// It logs IDs and sizes only, never a body.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import type { BlobKey } from "./ids.ts";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BYTES = 512 * 1024 * 1024;

export type BlobRecord = { readonly key: string; readonly bytes: number; readonly sha256: string; readonly at: number; readonly op: "put" | "get" };

export type BlobStore = {
  readonly baseUrl: string;
  readonly token: string;
  readonly records: readonly BlobRecord[];
  readonly close: () => Promise<void>;
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BYTES) throw new Error("too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const tokenMatches = (header: string | undefined, token: string): boolean => {
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

export const startBlobStore = async (dir: string, log?: (line: Readonly<Record<string, string | number>>) => void): Promise<BlobStore> => {
  await mkdir(dir, { recursive: true });
  const token = randomBytes(24).toString("base64url");
  const records: BlobRecord[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const parts = (req.url ?? "").split("?")[0]?.split("/").filter((p) => p !== "") ?? [];
      const [root, task, name] = parts;
      if (root !== "blobs" || task === undefined || name === undefined || parts.length !== 3 || !SEGMENT.test(task) || !SEGMENT.test(name)) {
        res.writeHead(404).end();
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        res.writeHead(401).end();
        return;
      }
      const file = path.join(dir, task, name);
      const key = `${task}/${name}`;
      if (req.method === "PUT") {
        const body = await readBody(req);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.part`, body);
        await rename(`${file}.part`, file);
        const sha256 = createHash("sha256").update(body).digest("hex");
        records.push({ key, bytes: body.byteLength, sha256, at: Date.now(), op: "put" });
        log?.({ event: "blob.put", key, bytes: body.byteLength });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bytes: body.byteLength, sha256 }));
        return;
      }
      if (req.method === "GET") {
        const info = await stat(file).catch(() => undefined);
        if (info === undefined) {
          res.writeHead(404).end();
          return;
        }
        records.push({ key, bytes: info.size, sha256: "", at: Date.now(), op: "get" });
        log?.({ event: "blob.get", key, bytes: info.size });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(info.size) });
        createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(405).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("blob store: no address");
  const { port } = address satisfies AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token,
    records,
    close: async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

const putAnswer = z.strictObject({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** The runner's side: upload one blob. */
export const uploadBlob = async (store: Pick<BlobStore, "baseUrl" | "token">, key: BlobKey, body: string | Buffer): Promise<z.infer<typeof putAnswer>> => {
  const response = await fetch(`${store.baseUrl}/blobs/${key}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${store.token}`, "content-type": "application/octet-stream" },
    body: typeof body === "string" ? body : new Uint8Array(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`blob upload: HTTP ${String(response.status)}`);
  return putAnswer.parse(await response.json());
};

/** The runner's side: download one blob. */
export const downloadBlob = async (store: Pick<BlobStore, "baseUrl" | "token">, key: BlobKey): Promise<Buffer> => {
  const response = await fetch(`${store.baseUrl}/blobs/${key}`, { headers: { authorization: `Bearer ${store.token}` }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`blob download: HTTP ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
};
