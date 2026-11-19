import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

// What a snapshot build's push step does with BuildKit's OCI tarball (ticket 08, F-120): unpacks it
// (a tar read a header at a time, so an image of gigabytes takes a little memory) and pushes its
// blobs and its manifest to the registry with the push credential, over the distribution API, as
// Docker's client does: Basic, or a bearer token from the realm a 401 names. The credential is in a
// header only, never logged, never in an error's words.

export type RegistryCredential = { readonly username: string; readonly token: string };

/** An image reference's parts: `registry.example:5000/ostra/acme:snap-1`. */
export type ImageRef = { readonly host: string; readonly name: string; readonly tag: string };

export const parseImageRef = (ref: string): ImageRef | null => {
  const at = ref.indexOf("@");
  const plain = at === -1 ? ref : ref.slice(0, at);
  const slash = plain.indexOf("/");
  if (slash === -1) return null;
  const host = plain.slice(0, slash);
  if (!(host.includes(".") || host.includes(":") || host === "localhost")) return null;
  const rest = plain.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const name = colon === -1 ? rest : rest.slice(0, colon);
  const tag = colon === -1 ? "latest" : rest.slice(colon + 1);
  if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(name) || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) return null;
  return { host, name, tag };
};

/** The registry's base URL: plain HTTP for a registry on this machine only, as Docker allows. */
export const registryUrlOf = (host: string): string => {
  const bare = host.replace(/:\d+$/, "");
  return `${bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]" ? "http" : "https"}://${host}`;
};

// ---------- the tarball ----------

const octal = (block: Buffer, offset: number, length: number): number => {
  const text = block.subarray(offset, offset + length).toString("latin1").replaceAll("\0", "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
};
const text = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
};

/** Unpacks a tar's regular files into a folder. Refuses a path that leaves it. */
export const extractTar = async (file: string, into: string): Promise<number> => {
  const handle = await open(file, "r");
  const root = path.resolve(into);
  let files = 0;
  try {
    const size = (await handle.stat()).size;
    let offset = 0;
    let longName: string | null = null;
    const header = Buffer.alloc(512);
    while (offset + 512 <= size) {
      await handle.read(header, 0, 512, offset);
      if (header.every((byte) => byte === 0)) break;
      const length = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0);
      const body = offset + 512;
      const next = body + Math.ceil(length / 512) * 512;
      const readBody = async (): Promise<Buffer> => {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, body);
        return buffer;
      };
      if (type === "x") {
        const pax = (await readBody()).toString("utf8");
        const match = /\d+ path=([^\n]*)\n/.exec(pax);
        longName = match?.[1] ?? longName;
      } else if (type === "L") {
        longName = (await readBody()).toString("utf8").replace(/\0+$/, "");
      } else {
        const prefix = text(header, 345, 155);
        const name = longName ?? (prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
        longName = null;
        if (type === "0" || type === "\0") {
          const target = path.resolve(root, ...name.split("/").filter((part) => part !== "" && part !== "."));
          if (!target.startsWith(`${root}${path.sep}`)) throw new Error("the image's archive names a path outside it");
          await mkdir(path.dirname(target), { recursive: true });
          const out = await open(target, "w");
          try {
            const chunk = Buffer.alloc(1024 * 1024);
            for (let done = 0; done < length; ) {
              const want = Math.min(chunk.length, length - done);
              const { bytesRead } = await handle.read(chunk, 0, want, body + done);
              if (bytesRead === 0) throw new Error("the image's archive ends early");
              await out.write(chunk, 0, bytesRead);
              done += bytesRead;
            }
          } finally {
            await out.close();
          }
          files += 1;
        }
      }
      offset = next;
    }
  } finally {
    await handle.close();
  }
  return files;
};

// ---------- the layout ----------

const descriptorSchema = z.looseObject({ mediaType: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size: z.number().int().nonnegative() });
const indexSchema = z.looseObject({ manifests: z.array(descriptorSchema).min(1) });
const manifestSchema = z.looseObject({ mediaType: z.string().optional(), config: descriptorSchema, layers: z.array(descriptorSchema) });

const blobPath = (layout: string, digest: string): string => path.join(layout, "blobs", "sha256", digest.slice("sha256:".length));

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(`sha256:${hash.digest("hex")}`);
      });
  });

// ---------- the registry ----------

const challengeParams = (header: string): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) params[match[1]] = match[2];
  }
  return params;
};

const tokenSchema = z.looseObject({ token: z.string().optional(), access_token: z.string().optional() });

export type PushResult = { readonly ok: true; readonly digest: string; readonly blobs: number } | { readonly ok: false; readonly status: number; readonly message: string };

/** Pushes an unpacked OCI layout's image (its index's first manifest) under the reference's tag. */
export const pushOciLayout = async (layout: string, ref: ImageRef, credential: RegistryCredential, registryUrl = registryUrlOf(ref.host)): Promise<PushResult> => {
  const basic = `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;
  const scope = `repository:${ref.name}:pull,push`;
  let bearer: string | null = null;
  const send = async (method: string, url: string, init: { readonly body?: Buffer; readonly headers?: Record<string, string> } = {}): Promise<Response> => {
    const attempt = (authorization: string): Promise<Response> =>
      fetch(new URL(url, registryUrl), {
        method,
        headers: { ...(init.headers ?? {}), authorization },
        ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
        redirect: "follow",
      });
    let response = await attempt(bearer ?? basic);
    if (response.status !== 401) return response;
    const header = response.headers.get("www-authenticate") ?? "";
    if (!header.startsWith("Bearer ")) return response;
    const params = challengeParams(header);
    const realm = new URL(params["realm"] ?? `${registryUrl}/token`);
    if (params["service"] !== undefined) realm.searchParams.set("service", params["service"]);
    realm.searchParams.set("scope", scope);
    const issued = await fetch(realm, { headers: { authorization: basic } });
    if (!issued.ok) return issued;
    const body = tokenSchema.safeParse(await issued.json());
    const token = body.success ? (body.data.token ?? body.data.access_token ?? "") : "";
    bearer = `Bearer ${token}`;
    response = await attempt(bearer);
    return response;
  };
  const refused = (response: Response, what: string): PushResult => ({ ok: false, status: response.status, message: `${what}: the registry answered ${String(response.status)}` });

  const index = indexSchema.safeParse(JSON.parse(await readFile(path.join(layout, "index.json"), "utf8")));
  if (!index.success) return { ok: false, status: 0, message: "the image's index doesn't parse" };
  const [top] = index.data.manifests;
  if (top === undefined) return { ok: false, status: 0, message: "the image has no manifest" };
  const manifestBytes = await readFile(blobPath(layout, top.digest));
  const manifest = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
  if (!manifest.success) return { ok: false, status: 0, message: "the image's manifest doesn't parse" };
  let blobs = 0;
  for (const blob of [manifest.data.config, ...manifest.data.layers]) {
    const file = blobPath(layout, blob.digest);
    if ((await sha256File(file)) !== blob.digest || (await stat(file)).size !== blob.size) {
      return { ok: false, status: 0, message: "a blob of the image doesn't match its digest" };
    }
    const head = await send("HEAD", `/v2/${ref.name}/blobs/${blob.digest}`);
    if (head.status === 200) continue;
    const data = await readFile(file);
    const posted = await send("POST", `/v2/${ref.name}/blobs/uploads/?digest=${encodeURIComponent(blob.digest)}`, { body: data, headers: { "content-type": "application/octet-stream" } });
    if (posted.status === 202) {
      // The registry took no monolithic POST: the upload finishes with a PUT to where it said.
      const location = posted.headers.get("location") ?? "";
      const separator = location.includes("?") ? "&" : "?";
      const put = await send("PUT", `${location}${separator}digest=${encodeURIComponent(blob.digest)}`, { body: data, headers: { "content-type": "application/octet-stream" } });
      if (put.status !== 201) return refused(put, "finishing a blob's upload");
    } else if (posted.status !== 201) {
      return refused(posted, "uploading a blob");
    }
    blobs += 1;
  }
  const mediaType = manifest.data.mediaType ?? top.mediaType;
  const put = await send("PUT", `/v2/${ref.name}/manifests/${ref.tag}`, { body: manifestBytes, headers: { "content-type": mediaType } });
  if (put.status !== 201) return refused(put, "pushing the manifest");
  const digest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const answered = put.headers.get("docker-content-digest");
  if (answered !== null && answered !== digest) return { ok: false, status: put.status, message: "the registry answered another digest for the manifest" };
  return { ok: true, digest, blobs };
};
