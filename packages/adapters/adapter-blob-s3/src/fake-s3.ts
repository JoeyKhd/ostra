import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A fake S3-compatible server for this package's tests and for core's: path-style addressing, one
// bucket, and enough of the API for the blob store (put, get, head, delete, list, multipart). Like
// the real one it checks the request's AWS Signature V4 against the access key's secret, answers
// errors as XML with a code, and enforces the 5 MiB floor on every part but the last. It can be told
// to fail the next requests that match, or to drop the connection in the middle of a body, which is
// what a flaky network does to a part upload.

export type FakeS3Object = {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: number;
};

/** A fault to inject for the next requests `match` accepts. */
export type FakeS3Fault = {
  readonly match: (request: FakeS3Request) => boolean;
  /** `drop`: read part of the body, then destroy the socket. `status`: answer this status and code. */
  readonly action: { readonly kind: "drop" } | { readonly kind: "status"; readonly status: number; readonly code: string };
  /** How many matching requests it fails; default 1. */
  times?: number;
};

export type FakeS3Request = {
  readonly method: string;
  /** The key within the bucket, or `""` for the bucket itself. */
  readonly key: string;
  readonly query: Readonly<Record<string, string>>;
};

export type FakeS3 = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Every object, by key. */
  readonly objects: Map<string, FakeS3Object>;
  /** Multipart uploads in flight, by upload ID: their key and the parts received. */
  readonly multipart: Map<string, { readonly key: string; readonly parts: Map<number, Uint8Array> }>;
  /** Every request the server answered or failed, in order. */
  readonly requests: FakeS3Request[];
  readonly faults: FakeS3Fault[];
  readonly close: () => Promise<void>;
};

export type FakeS3Options = {
  readonly bucket?: string;
  readonly region?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** Parts under this size are refused unless last. S3's floor is 5 MiB, which is the default. */
  readonly minPartBytes?: number;
  /** How many keys a list page holds at most; default 1000, as S3. */
  readonly listPageSize?: number;
};

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();
const md5Hex = (data: Uint8Array): string => createHash("md5").update(data).digest("hex");

const xmlEscape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const xmlUnescape = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const readBody = async (request: IncomingMessage, dropAfter?: number): Promise<Uint8Array | "dropped"> => {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    seen += buffer.length;
    if (dropAfter !== undefined && seen >= dropAfter) {
      request.socket.destroy();
      return "dropped";
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
};

/** The canonical query string of a signature: names and values as they came, sorted. */
const canonicalQuery = (rawQuery: string): string =>
  rawQuery === ""
    ? ""
    : rawQuery
        .split("&")
        .map((pair) => {
          const at = pair.indexOf("=");
          return at < 0 ? ([pair, ""] as const) : ([pair.slice(0, at), pair.slice(at + 1)] as const);
        })
        .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");

export const createFakeS3 = async (options: FakeS3Options = {}): Promise<FakeS3> => {
  const bucket = options.bucket ?? "ostra-test";
  const region = options.region ?? "us-east-1";
  const accessKeyId = options.accessKeyId ?? "AKIAFAKEACCESSKEY";
  const secretAccessKey = options.secretAccessKey ?? "fake-secret-access-key/value";
  const minPartBytes = options.minPartBytes ?? 5 * 1024 * 1024;
  const pageSize = options.listPageSize ?? 1000;
  const objects = new Map<string, FakeS3Object>();
  const multipart = new Map<string, { readonly key: string; readonly parts: Map<number, Uint8Array> }>();
  const requests: FakeS3Request[] = [];
  const faults: FakeS3Fault[] = [];

  const sendXml = (response: ServerResponse, status: number, xml: string): void => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    response.writeHead(status, { "content-type": "application/xml", "content-length": Buffer.byteLength(body) });
    response.end(body);
  };
  const sendError = (response: ServerResponse, status: number, code: string, message: string, isHead: boolean): void => {
    if (isHead) {
      response.writeHead(status, { "x-amz-error-code": code });
      response.end();
      return;
    }
    sendXml(response, status, `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
  };

  /** Checks the request's AWS Signature V4 the way S3 does, from the wire. */
  const signatureError = (request: IncomingMessage, rawPath: string, rawQuery: string): { readonly status: number; readonly code: string } | undefined => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(header) : null;
    if (match === null) {
      return { status: 403, code: "AccessDenied" };
    }
    const [, keyId = "", day = "", scope = "", signedHeaders = "", signature = ""] = match;
    if (keyId !== accessKeyId) {
      return { status: 403, code: "InvalidAccessKeyId" };
    }
    const amzDate = request.headers["x-amz-date"];
    const payloadHash = request.headers["x-amz-content-sha256"];
    if (typeof amzDate !== "string" || typeof payloadHash !== "string") {
      return { status: 403, code: "AccessDenied" };
    }
    const names = signedHeaders.split(";");
    const canonicalHeaders = names
      .map((name) => {
        const value = request.headers[name];
        const text = Array.isArray(value) ? value.join(",") : (value ?? "");
        return `${name}:${text.trim().replace(/\s+/g, " ")}\n`;
      })
      .join("");
    const canonical = [request.method ?? "GET", rawPath, canonicalQuery(rawQuery), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", amzDate, `${day}/${scope}/s3/aws4_request`, sha256Hex(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), scope), "s3"), "aws4_request");
    const expected = createHmac("sha256", signingKey).update(toSign, "utf8").digest("hex");
    return expected === signature ? undefined : { status: 403, code: "SignatureDoesNotMatch" };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const isHead = method === "HEAD";
    const url = new URL(request.url ?? "/", "http://fake");
    const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
    const rawQuery = (request.url ?? "").includes("?") ? (request.url ?? "").slice((request.url ?? "").indexOf("?") + 1) : "";
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
      query[name] = value;
    }
    const segments = url.pathname.split("/").filter((part) => part !== "");
    const [first, ...rest] = segments;
    const key = rest.map((part) => decodeURIComponent(part)).join("/");
    const seen: FakeS3Request = { method, key, query };
    requests.push(seen);

    const bad = signatureError(request, rawPath, rawQuery);
    if (bad !== undefined) {
      await readBody(request);
      sendError(response, bad.status, bad.code, "The request signature we calculated does not match.", isHead);
      return;
    }
    const fault = faults.find((candidate) => (candidate.times ?? 1) > 0 && candidate.match(seen));
    if (fault !== undefined) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.action.kind === "drop") {
        // Read some of the body, then cut the connection: the client sees a reset.
        await readBody(request, 1);
        request.socket.destroy();
        return;
      }
      await readBody(request);
      sendError(response, fault.action.status, fault.action.code, "an injected failure", isHead);
      return;
    }
    if (decodeURIComponent(first ?? "") !== decodeURIComponent(bucket)) {
      await readBody(request);
      sendError(response, 404, "NoSuchBucket", "The specified bucket does not exist", isHead);
      return;
    }

    // ---- the bucket itself
    if (key === "") {
      if (isHead) {
        response.writeHead(200, { "x-amz-bucket-region": region });
        response.end();
        return;
      }
      if (method === "GET" && query["list-type"] === "2") {
        const prefix = query["prefix"] ?? "";
        const start = query["continuation-token"] ?? "";
        const max = Math.min(Number(query["max-keys"] ?? pageSize), pageSize);
        const all = [...objects.keys()].filter((name) => name.startsWith(prefix) && name > start).sort();
        const page = all.slice(0, max);
        const truncated = all.length > page.length;
        const contents = page
          .map((name) => {
            const object = objects.get(name);
            return `<Contents><Key>${xmlEscape(name)}</Key><LastModified>${new Date(object?.lastModified ?? 0).toISOString()}</LastModified><ETag>"${object?.etag ?? ""}"</ETag><Size>${String(object?.body.length ?? 0)}</Size></Contents>`;
          })
          .join("");
        sendXml(
          response,
          200,
          `<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${String(page.length)}</KeyCount><MaxKeys>${String(max)}</MaxKeys><IsTruncated>${String(truncated)}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEscape(page.at(-1) ?? "")}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
        );
        return;
      }
      await readBody(request);
      sendError(response, 501, "NotImplemented", "not in the fake", isHead);
      return;
    }

    // ---- multipart
    if (method === "POST" && "uploads" in query) {
      await readBody(request);
      const uploadId = `mpu-${randomUUID()}`;
      multipart.set(uploadId, { key, parts: new Map() });
      sendXml(
        response,
        200,
        `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    const uploadId = query["uploadId"];
    if (uploadId !== undefined) {
      const upload = multipart.get(uploadId);
      if (upload?.key !== key) {
        await readBody(request);
        sendError(response, 404, "NoSuchUpload", "The specified upload does not exist", isHead);
        return;
      }
      if (method === "PUT" && query["partNumber"] !== undefined) {
        const body = await readBody(request);
        if (body === "dropped") {
          return;
        }
        upload.parts.set(Number(query["partNumber"]), body);
        response.writeHead(200, { etag: `"${md5Hex(body)}"` });
        response.end();
        return;
      }
      if (method === "POST") {
        const posted = await readBody(request);
        if (posted === "dropped") {
          return;
        }
        const xml = Buffer.from(posted).toString("utf8");
        const listed = [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((block) => ({
          number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(block[1] ?? "")?.[1]),
          etag: xmlUnescape(/<ETag>([^<]*)<\/ETag>/.exec(block[1] ?? "")?.[1] ?? "").replaceAll('"', ""),
        }));
        if (listed.length === 0) {
          sendError(response, 400, "MalformedXML", "The XML you provided was not well-formed", isHead);
          return;
        }
        const bodies: Uint8Array[] = [];
        for (const [index, part] of listed.entries()) {
          const held = upload.parts.get(part.number);
          if (held === undefined || md5Hex(held) !== part.etag) {
            sendError(response, 400, "InvalidPart", "One or more of the specified parts could not be found", isHead);
            return;
          }
          if (held.length < minPartBytes && index < listed.length - 1) {
            sendError(response, 400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size", isHead);
            return;
          }
          bodies.push(held);
        }
        const body = new Uint8Array(Buffer.concat(bodies));
        objects.set(key, { body, contentType: "application/octet-stream", etag: `${md5Hex(body)}-${String(bodies.length)}`, lastModified: Date.now() });
        multipart.delete(uploadId);
        sendXml(
          response,
          200,
          `<CompleteMultipartUploadResult><Location>${xmlEscape(`${bucket}/${key}`)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>"${md5Hex(body)}-${String(bodies.length)}"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
      if (method === "DELETE") {
        multipart.delete(uploadId);
        response.writeHead(204);
        response.end();
        return;
      }
    }

    // ---- objects
    if (method === "PUT") {
      const body = await readBody(request);
      if (body === "dropped") {
        return;
      }
      objects.set(key, {
        body,
        contentType: request.headers["content-type"] ?? "application/octet-stream",
        etag: md5Hex(body),
        lastModified: Date.now(),
      });
      response.writeHead(200, { etag: `"${md5Hex(body)}"` });
      response.end();
      return;
    }
    if (method === "GET" || isHead) {
      const object = objects.get(key);
      if (object === undefined) {
        sendError(response, 404, "NoSuchKey", "The specified key does not exist.", isHead);
        return;
      }
      const range = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.range ?? "");
      const from = range === null ? 0 : Number(range[1]);
      const to = range === null ? object.body.length - 1 : Math.min(Number(range[2] ?? object.body.length - 1), object.body.length - 1);
      const slice = object.body.subarray(from, to + 1);
      response.writeHead(range === null ? 200 : 206, {
        "content-type": object.contentType,
        "content-length": slice.length,
        etag: `"${object.etag}"`,
        "last-modified": new Date(object.lastModified).toUTCString(),
        ...(range === null ? {} : { "content-range": `bytes ${String(from)}-${String(to)}/${String(object.body.length)}` }),
      });
      response.end(isHead ? undefined : Buffer.from(slice));
      return;
    }
    if (method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    await readBody(request);
    sendError(response, 501, "NotImplemented", "not in the fake", isHead);
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendError(response, 500, "InternalError", "the fake failed", false);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    objects,
    multipart,
    requests,
    faults,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
