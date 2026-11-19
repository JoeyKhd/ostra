import { sha256Digest } from "./fake-oci-registry.ts";

// A small registry client for the fake registry's tests and the dev tools (ticket 06): it answers
// a 401's challenge as Docker does (Basic, or a bearer token for the scope from the realm), pushes a
// blob monolithically or in chunks, and pushes and pulls manifests by tag or digest. Test and dev only.

export type OciCredential = { readonly username: string; readonly password: string };

export type OciClient = {
  /** Pushes a blob; `chunkSize` splits it into PATCHes. Answers its digest. */
  readonly pushBlob: (name: string, data: Buffer, chunkSize?: number) => Promise<string>;
  readonly pullBlob: (name: string, digest: string) => Promise<Buffer>;
  /** Pushes a manifest under a tag or its digest; answers the digest the registry gave it. */
  readonly pushManifest: (name: string, reference: string, mediaType: string, body: Buffer) => Promise<string>;
  readonly pullManifest: (name: string, reference: string) => Promise<{ readonly digest: string; readonly mediaType: string; readonly body: Buffer }>;
};

/** A refusal, with the registry's status: `401` for a refused credential, `403` for a missing permission. */
export type OciError = Error & { readonly status: number };

const ociError = (status: number, message: string): OciError => Object.assign(new Error(message), { status });

const challengeParams = (header: string): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) params[match[1]] = match[2];
  }
  return params;
};

export const ociClient = (registryUrl: string, credential: OciCredential | null): OciClient => {
  const basic = credential === null ? null : `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const tokens = new Map<string, string>();

  const send = async (method: string, path: string, scope: string, init: { readonly body?: Buffer; readonly headers?: Record<string, string> } = {}): Promise<Response> => {
    const attempt = (authorization: string | null): Promise<Response> =>
      fetch(new URL(path, registryUrl), {
        method,
        headers: { ...(init.headers ?? {}), ...(authorization === null ? {} : { authorization }) },
        ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
      });
    const known = tokens.get(scope);
    let response = await attempt(known === undefined ? basic : `Bearer ${known}`);
    if (response.status !== 401) return response;
    const header = response.headers.get("www-authenticate") ?? "";
    if (header.startsWith("Bearer ")) {
      const params = challengeParams(header);
      const realm = new URL(params["realm"] ?? `${registryUrl}/token`);
      if (params["service"] !== undefined) realm.searchParams.set("service", params["service"]);
      realm.searchParams.set("scope", scope);
      const tokenResponse = await fetch(realm, { headers: basic === null ? {} : { authorization: basic } });
      if (!tokenResponse.ok) throw ociError(tokenResponse.status, `the token endpoint refused: ${String(tokenResponse.status)}`);
      const body: unknown = await tokenResponse.json();
      const token = typeof body === "object" && body !== null && "token" in body && typeof body.token === "string" ? body.token : "";
      tokens.set(scope, token);
      response = await attempt(`Bearer ${token}`);
    }
    return response;
  };

  const expect = async (response: Response, ok: readonly number[], what: string): Promise<Response> => {
    if (!ok.includes(response.status)) throw ociError(response.status, `${what}: ${String(response.status)} ${await response.text()}`);
    return response;
  };

  return {
    pushBlob: async (name, data, chunkSize) => {
      const scope = `repository:${name}:pull,push`;
      const digest = sha256Digest(data);
      if (chunkSize === undefined) {
        await expect(await send("POST", `/v2/${name}/blobs/uploads/?digest=${encodeURIComponent(digest)}`, scope, { body: data, headers: { "content-type": "application/octet-stream" } }), [201], "push a blob");
        return digest;
      }
      const started = await expect(await send("POST", `/v2/${name}/blobs/uploads/`, scope), [202], "start an upload");
      let location = started.headers.get("location") ?? "";
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const chunk = data.subarray(offset, offset + chunkSize);
        const patched = await expect(
          await send("PATCH", location, scope, { body: chunk, headers: { "content-type": "application/octet-stream", "content-range": `${String(offset)}-${String(offset + chunk.length - 1)}` } }),
          [202],
          "send a chunk",
        );
        location = patched.headers.get("location") ?? location;
      }
      const separator = location.includes("?") ? "&" : "?";
      await expect(await send("PUT", `${location}${separator}digest=${encodeURIComponent(digest)}`, scope), [201], "finish an upload");
      return digest;
    },
    pullBlob: async (name, digest) => {
      const response = await expect(await send("GET", `/v2/${name}/blobs/${digest}`, `repository:${name}:pull`), [200], "pull a blob");
      return Buffer.from(await response.arrayBuffer());
    },
    pushManifest: async (name, reference, mediaType, body) => {
      const response = await expect(await send("PUT", `/v2/${name}/manifests/${reference}`, `repository:${name}:pull,push`, { body, headers: { "content-type": mediaType } }), [201], "push a manifest");
      return response.headers.get("docker-content-digest") ?? "";
    },
    pullManifest: async (name, reference) => {
      const response = await expect(await send("GET", `/v2/${name}/manifests/${reference}`, `repository:${name}:pull`, { headers: { accept: "application/vnd.oci.image.manifest.v1+json" } }), [200], "pull a manifest");
      return { digest: response.headers.get("docker-content-digest") ?? "", mediaType: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()) };
    },
  };
};
