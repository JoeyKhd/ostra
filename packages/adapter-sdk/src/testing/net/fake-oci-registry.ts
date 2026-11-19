import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import { z } from "zod";

import { tarOf } from "./tar.ts";

// A fake OCI registry (ticket 06, spec section 8), speaking the distribution API that Docker
// Engine, kubelets, BuildKit and ostra's registry check speak: `/v2/`, with Basic or bearer-token
// auth; blob uploads, monolithic and chunked, and cancelled; manifests by tag and by digest, checked against the
// blobs they name. It holds a push-only and a pull-only credential, a seeded image, and a record of
// every request, with the user who made it (never a password or token). Test and dev only.

export type RegistryAction = "pull" | "push";

export type FakeRegistryCredential = { readonly username: string; readonly password: string; readonly can: readonly RegistryAction[] };

export type FakeRegistryRequest = {
  readonly method: string;
  readonly path: string;
  /** The user the request authenticated as, or `null`. */
  readonly user: string | null;
  readonly action: RegistryAction | null;
  readonly status: number;
};

export type FakeOciRegistryOptions = {
  /** `basic`: Basic auth on every request. `bearer`: Docker's token flow, a token per scope from `/token`. Default `bearer`. */
  readonly auth?: "basic" | "bearer";
  /** Default: one push-only and one pull-only credential, with random passwords. */
  readonly credentials?: readonly FakeRegistryCredential[];
  readonly port?: number;
};

export type FakeOciRegistry = {
  readonly url: string;
  /** `127.0.0.1:<port>`: how an image reference names this registry. */
  readonly host: string;
  readonly push: FakeRegistryCredential;
  readonly pull: FakeRegistryCredential;
  /** The seeded image, `ostra/base:seed`, and its manifest's digest. */
  readonly seeded: { readonly name: string; readonly tag: string; readonly digest: string };
  readonly requests: () => readonly FakeRegistryRequest[];
  /** A manifest the registry holds, by tag or digest. */
  readonly manifest: (name: string, reference: string) => { readonly digest: string; readonly mediaType: string; readonly body: Buffer } | undefined;
  readonly hasBlob: (digest: string) => boolean;
  readonly close: () => Promise<void>;
};

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
export const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

export const sha256Digest = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

const descriptorSchema = z.looseObject({ mediaType: z.string().optional(), digest: z.string(), size: z.number().optional() });
const manifestSchema = z.looseObject({
  schemaVersion: z.number().optional(),
  mediaType: z.string().optional(),
  config: descriptorSchema.optional(),
  layers: z.array(descriptorSchema).optional(),
  manifests: z.array(descriptorSchema).optional(),
});

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*";
const UPLOADS = new RegExp(`^/v2/(${NAME})/blobs/uploads/?$`);
const UPLOAD = new RegExp(`^/v2/(${NAME})/blobs/uploads/([0-9a-f-]+)$`);
const BLOB = new RegExp(`^/v2/(${NAME})/blobs/(sha256:[a-f0-9]{64})$`);
const MANIFEST = new RegExp(`^/v2/(${NAME})/manifests/([A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[a-f0-9]{64})$`);
const TAGS = new RegExp(`^/v2/(${NAME})/tags/list$`);

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

const errorBody = (code: string, message: string): string => JSON.stringify({ errors: [{ code, message, detail: null }] });

/** What a request needs: `null` for `/v2/` itself and `/token`. */
const actionOf = (method: string, pathname: string): RegistryAction | null => {
  if (pathname === "/v2/" || pathname === "/v2" || pathname === "/token") return null;
  return method === "GET" || method === "HEAD" ? "pull" : "push";
};

const nameOf = (pathname: string): string | null => {
  for (const pattern of [UPLOADS, UPLOAD, BLOB, MANIFEST, TAGS]) {
    const match = pattern.exec(pathname);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
};

const scopeSchema = /^repository:([^:]+):([a-z,]+)$/;

export const startFakeOciRegistry = async (options: FakeOciRegistryOptions = {}): Promise<FakeOciRegistry> => {
  const mode = options.auth ?? "bearer";
  const credentials = options.credentials ?? [
    { username: "ostra-push", password: randomBytes(12).toString("hex"), can: ["push"] },
    { username: "ostra-pull", password: randomBytes(12).toString("hex"), can: ["pull"] },
  ];
  const pushCredential = credentials.find((credential) => credential.can.includes("push"));
  const pullCredential = credentials.find((credential) => credential.can.includes("pull") && !credential.can.includes("push")) ?? credentials.find((credential) => credential.can.includes("pull"));
  if (pushCredential === undefined || pullCredential === undefined) throw new Error("the fake registry needs a push and a pull credential");

  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { readonly mediaType: string; readonly body: Buffer }>();
  /** `name:tag` → digest; `name@digest` → present. */
  const tags = new Map<string, string>();
  const named = new Set<string>();
  const uploads = new Map<string, { readonly name: string; chunks: Buffer[] }>();
  /** Bearer tokens: the user, the repository and what it may do there. */
  const tokens = new Map<string, { readonly user: string; readonly grants: ReadonlyMap<string, readonly RegistryAction[]> }>();
  const requests: FakeRegistryRequest[] = [];

  const putManifest = (name: string, reference: string, mediaType: string, body: Buffer): string => {
    const digest = sha256Digest(body);
    manifests.set(digest, { mediaType, body });
    named.add(`${name}@${digest}`);
    if (!DIGEST.test(reference)) tags.set(`${name}:${reference}`, digest);
    return digest;
  };

  // The seeded image: one layer with one file, its config, and its manifest, tagged `seed`.
  const layerTar = tarOf([{ name: "etc/ostra-seed.txt", content: Buffer.from("seeded by the fake registry\n") }]);
  const layer = await promisify(gzip)(layerTar);
  blobs.set(sha256Digest(layer), layer);
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [sha256Digest(layerTar)] }, config: {} }));
  blobs.set(sha256Digest(config), config);
  const seedManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: sha256Digest(config), size: config.length },
      layers: [{ mediaType: OCI_LAYER, digest: sha256Digest(layer), size: layer.length }],
    }),
  );
  const seededDigest = putManifest("ostra/base", "seed", OCI_MANIFEST, seedManifest);

  const server = createServer();
  const url = await new Promise<string>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`);
    });
  });
  const host = url.replace(/^http:\/\//, "");

  const basicUser = (header: string | undefined): FakeRegistryCredential | null => {
    const match = /^Basic (.+)$/.exec(header ?? "");
    if (match?.[1] === undefined) return null;
    const [username, ...rest] = Buffer.from(match[1], "base64").toString("utf8").split(":");
    return credentials.find((credential) => credential.username === username && credential.password === rest.join(":")) ?? null;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const parsed = new URL(request.url ?? "/", url);
    const pathname = parsed.pathname;
    const action = actionOf(method, pathname);
    const name = nameOf(pathname);
    let user: string | null = null;
    const answer = (status: number, headers: Record<string, string> = {}, body: string | Buffer = ""): void => {
      requests.push({ method, path: pathname, user, action, status });
      const data = typeof body === "string" ? Buffer.from(body) : body;
      response.writeHead(status, { "docker-distribution-api-version": "registry/2.0", "content-length": String(data.length), ...headers });
      response.end(method === "HEAD" ? undefined : data);
    };
    const challenge = (error: string | null): void => {
      const scope = name === null || action === null ? "" : `,scope="repository:${name}:${action}"`;
      const header =
        mode === "basic" ? 'Basic realm="fake-registry"' : `Bearer realm="${url}/token",service="fake-registry"${scope}${error === null ? "" : `,error="${error}"`}`;
      answer(401, { "www-authenticate": header, "content-type": "application/json" }, errorBody("UNAUTHORIZED", "authentication required"));
    };

    // Docker's token endpoint: a token for the scopes asked for, cut to what the credential may do.
    if (pathname === "/token" && mode === "bearer") {
      const credential = basicUser(request.headers.authorization);
      if (credential === null) {
        answer(401, { "content-type": "application/json" }, errorBody("UNAUTHORIZED", "the credential was refused"));
        return;
      }
      user = credential.username;
      const grants = new Map<string, RegistryAction[]>();
      for (const scope of parsed.searchParams.getAll("scope")) {
        const match = scopeSchema.exec(scope);
        if (match?.[1] === undefined || match[2] === undefined) continue;
        const asked = match[2].split(",").filter((item): item is RegistryAction => item === "pull" || item === "push");
        grants.set(match[1], asked.filter((item) => credential.can.includes(item)));
      }
      const token = randomBytes(18).toString("hex");
      tokens.set(token, { user: credential.username, grants });
      answer(200, { "content-type": "application/json" }, JSON.stringify({ token, access_token: token, expires_in: 300, issued_at: new Date().toISOString() }));
      return;
    }

    // Who's asking, and may they?
    let allowed: readonly RegistryAction[] = [];
    if (mode === "basic") {
      const credential = basicUser(request.headers.authorization);
      if (credential === null) {
        challenge(null);
        return;
      }
      user = credential.username;
      allowed = credential.can;
    } else {
      const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
      const token = match?.[1] === undefined ? undefined : tokens.get(match[1]);
      if (token === undefined) {
        challenge(null);
        return;
      }
      user = token.user;
      allowed = name === null ? ["pull"] : (token.grants.get(name) ?? []);
    }
    if (action !== null && !allowed.includes(action)) {
      if (mode === "bearer") challenge("insufficient_scope");
      else answer(403, { "content-type": "application/json" }, errorBody("DENIED", `${user} may not ${action}`));
      return;
    }

    if (pathname === "/v2/" || pathname === "/v2") {
      answer(200, { "content-type": "application/json" }, "{}");
      return;
    }

    const uploadsMatch = UPLOADS.exec(pathname);
    if (uploadsMatch?.[1] !== undefined && method === "POST") {
      const repository = uploadsMatch[1];
      const body = await readBody(request);
      const digest = parsed.searchParams.get("digest");
      if (digest !== null) {
        // Monolithic: the whole blob in the POST.
        if (sha256Digest(body) !== digest) {
          answer(400, { "content-type": "application/json" }, errorBody("DIGEST_INVALID", "the content doesn't match its digest"));
          return;
        }
        blobs.set(digest, body);
        answer(201, { location: `/v2/${repository}/blobs/${digest}`, "docker-content-digest": digest });
        return;
      }
      const id = randomUUID();
      uploads.set(id, { name: repository, chunks: body.length > 0 ? [body] : [] });
      answer(202, { location: `/v2/${repository}/blobs/uploads/${id}`, range: "0-0", "docker-upload-uuid": id });
      return;
    }

    const uploadMatch = UPLOAD.exec(pathname);
    if (uploadMatch?.[1] !== undefined && uploadMatch[2] !== undefined) {
      const upload = uploads.get(uploadMatch[2]);
      if (upload?.name !== uploadMatch[1]) {
        answer(404, { "content-type": "application/json" }, errorBody("BLOB_UPLOAD_UNKNOWN", "no such upload"));
        return;
      }
      // An upload cancelled (the distribution spec's DELETE): what a registry check does after it started one.
      if (method === "DELETE") {
        uploads.delete(uploadMatch[2]);
        answer(204);
        return;
      }
      const body = await readBody(request);
      if (body.length > 0) upload.chunks.push(body);
      const size = upload.chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (method === "PATCH") {
        answer(202, { location: pathname, range: `0-${String(Math.max(0, size - 1))}`, "docker-upload-uuid": uploadMatch[2] });
        return;
      }
      if (method === "PUT") {
        const digest = parsed.searchParams.get("digest") ?? "";
        const blob = Buffer.concat(upload.chunks);
        if (!DIGEST.test(digest) || sha256Digest(blob) !== digest) {
          answer(400, { "content-type": "application/json" }, errorBody("DIGEST_INVALID", "the content doesn't match its digest"));
          return;
        }
        uploads.delete(uploadMatch[2]);
        blobs.set(digest, blob);
        answer(201, { location: `/v2/${uploadMatch[1]}/blobs/${digest}`, "docker-content-digest": digest });
        return;
      }
    }

    const blobMatch = BLOB.exec(pathname);
    if (blobMatch?.[2] !== undefined && (method === "GET" || method === "HEAD")) {
      const blob = blobs.get(blobMatch[2]);
      if (blob === undefined) {
        answer(404, { "content-type": "application/json" }, errorBody("BLOB_UNKNOWN", "blob unknown to registry"));
        return;
      }
      answer(200, { "content-type": "application/octet-stream", "docker-content-digest": blobMatch[2] }, blob);
      return;
    }

    const manifestMatch = MANIFEST.exec(pathname);
    if (manifestMatch?.[1] !== undefined && manifestMatch[2] !== undefined) {
      const [, repository, reference] = manifestMatch;
      if (method === "PUT") {
        const body = await readBody(request);
        const mediaType = (request.headers["content-type"] ?? OCI_MANIFEST).split(";")[0] ?? OCI_MANIFEST;
        let text: unknown;
        try {
          text = JSON.parse(body.toString("utf8"));
        } catch {
          answer(400, { "content-type": "application/json" }, errorBody("MANIFEST_INVALID", "not JSON"));
          return;
        }
        const manifest = manifestSchema.safeParse(text);
        if (!manifest.success) {
          answer(400, { "content-type": "application/json" }, errorBody("MANIFEST_INVALID", "not a manifest"));
          return;
        }
        const missingBlob = [...(manifest.data.config === undefined ? [] : [manifest.data.config]), ...(manifest.data.layers ?? [])].find((item) => !blobs.has(item.digest));
        if (missingBlob !== undefined) {
          answer(400, { "content-type": "application/json" }, errorBody("MANIFEST_BLOB_UNKNOWN", `blob unknown: ${missingBlob.digest}`));
          return;
        }
        const missingManifest = (manifest.data.manifests ?? []).find((item) => !manifests.has(item.digest));
        if (missingManifest !== undefined) {
          answer(400, { "content-type": "application/json" }, errorBody("MANIFEST_UNKNOWN", `manifest unknown: ${missingManifest.digest}`));
          return;
        }
        if (DIGEST.test(reference) && sha256Digest(body) !== reference) {
          answer(400, { "content-type": "application/json" }, errorBody("DIGEST_INVALID", "the manifest doesn't match its digest"));
          return;
        }
        const digest = putManifest(repository, reference, mediaType, body);
        answer(201, { location: `/v2/${repository}/manifests/${digest}`, "docker-content-digest": digest });
        return;
      }
      if (method === "GET" || method === "HEAD") {
        const digest = DIGEST.test(reference) ? (named.has(`${repository}@${reference}`) ? reference : undefined) : tags.get(`${repository}:${reference}`);
        const stored = digest === undefined ? undefined : manifests.get(digest);
        if (digest === undefined || stored === undefined) {
          answer(404, { "content-type": "application/json" }, errorBody("MANIFEST_UNKNOWN", "manifest unknown"));
          return;
        }
        answer(200, { "content-type": stored.mediaType, "docker-content-digest": digest }, stored.body);
        return;
      }
    }

    const tagsMatch = TAGS.exec(pathname);
    if (tagsMatch?.[1] !== undefined && method === "GET") {
      const prefix = `${tagsMatch[1]}:`;
      const list = [...tags.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      answer(200, { "content-type": "application/json" }, JSON.stringify({ name: tagsMatch[1], tags: list }));
      return;
    }

    answer(404, { "content-type": "application/json" }, errorBody("UNSUPPORTED", `${method} ${pathname}`));
  };

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  return {
    url,
    host,
    push: pushCredential,
    pull: pullCredential,
    seeded: { name: "ostra/base", tag: "seed", digest: seededDigest },
    requests: () => [...requests],
    manifest: (name, reference) => {
      const digest = DIGEST.test(reference) ? (named.has(`${name}@${reference}`) ? reference : undefined) : tags.get(`${name}:${reference}`);
      const stored = digest === undefined ? undefined : manifests.get(digest);
      return digest === undefined || stored === undefined ? undefined : { digest, ...stored };
    },
    hasBlob: (digest) => blobs.has(digest),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
