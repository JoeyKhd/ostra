import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import { tarOf } from "./tar.ts";

// A fake npm registry (ticket 06, spec section 8): packuments and tarballs with their `integrity`
// and `shasum`, as `npm install --registry` and the runner's pin (ticket 19) read them. Packages
// are packed in memory (`packNpmPackage`). Test and dev only.

export type PackageJson = Readonly<Record<string, unknown>> & { readonly name: string; readonly version: string };

/** A package packed as `npm pack` packs it: its files under `package/`, gzipped, and the integrity of the tarball. */
export type PackedPackage = {
  readonly manifest: PackageJson;
  readonly tarball: Buffer;
  /** `sha512-<base64>`, as the packument and the lockfile carry it. */
  readonly integrity: string;
  readonly shasum: string;
};

export const packNpmPackage = async (manifest: PackageJson, files: Readonly<Record<string, string>>): Promise<PackedPackage> => {
  const entries = [
    { name: "package/package.json", content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...Object.entries(files).map(([name, content]) => ({ name: `package/${name}`, content: Buffer.from(content), mode: 0o755 })),
  ];
  const tarball = await promisify(gzip)(tarOf(entries));
  return {
    manifest,
    tarball,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    shasum: createHash("sha1").update(tarball).digest("hex"),
  };
};

/**
 * A stand-in for the ostra CLI at a version, until the CLI is published (ticket 22): a package
 * named `name` with an `ostra` bin that prints its version, so an install can be checked by running it.
 */
export const packFakeCli = (version: string, name = "ostra"): Promise<PackedPackage> =>
  packNpmPackage(
    { name, version, bin: { ostra: "bin/ostra.js" }, license: "Apache-2.0", engines: { node: ">=24" } },
    { "bin/ostra.js": `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`ostra ${version}\n`)});\n` },
  );

export type FakeNpmRequest = { readonly method: string; readonly path: string; readonly status: number };

export type FakeNpmRegistry = {
  readonly url: string;
  readonly requests: () => readonly FakeNpmRequest[];
  readonly close: () => Promise<void>;
};

const tarballName = (name: string, version: string): string => `${name.split("/").pop() ?? name}-${version}.tgz`;

/** Serves each package's packument and tarballs; `latest` is the highest version given unless `latest` names one. */
export const startFakeNpmRegistry = async (packages: readonly PackedPackage[], options: { readonly latest?: Readonly<Record<string, string>>; readonly port?: number } = {}): Promise<FakeNpmRegistry> => {
  const requests: FakeNpmRequest[] = [];
  const byName = new Map<string, PackedPackage[]>();
  for (const pack of packages) byName.set(pack.manifest.name, [...(byName.get(pack.manifest.name) ?? []), pack]);

  const server = createServer();
  const url = await new Promise<string>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`);
    });
  });

  const compare = (a: string, b: string): number => {
    const parts = (version: string): number[] => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    const [left, right] = [parts(a), parts(b)];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (left[index] ?? 0) - (right[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  const packument = (name: string, versions: readonly PackedPackage[]): Readonly<Record<string, unknown>> => {
    const sorted = [...versions].sort((a, b) => compare(a.manifest.version, b.manifest.version));
    const latest = options.latest?.[name] ?? sorted.at(-1)?.manifest.version ?? "0.0.0";
    return {
      _id: name,
      name,
      "dist-tags": { latest },
      versions: Object.fromEntries(
        sorted.map((pack) => [
          pack.manifest.version,
          {
            ...pack.manifest,
            _id: `${name}@${pack.manifest.version}`,
            dist: { tarball: `${url}/${name}/-/${tarballName(name, pack.manifest.version)}`, integrity: pack.integrity, shasum: pack.shasum },
          },
        ]),
      ),
      time: Object.fromEntries(sorted.map((pack) => [pack.manifest.version, new Date(Date.UTC(2026, 0, 1)).toISOString()])),
    };
  };

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const pathname = decodeURIComponent(new URL(request.url ?? "/", url).pathname);
    const answer = (status: number, type: string, body: Buffer | string): void => {
      requests.push({ method, path: pathname, status });
      const data = typeof body === "string" ? Buffer.from(body) : body;
      response.writeHead(status, { "content-type": type, "content-length": String(data.length) }).end(method === "HEAD" ? undefined : data);
    };
    const tarball = /^\/(.+)\/-\/([^/]+\.tgz)$/.exec(pathname);
    if (tarball?.[1] !== undefined && tarball[2] !== undefined) {
      const name = tarball[1];
      const pack = byName.get(name)?.find((item) => tarballName(name, item.manifest.version) === tarball[2]);
      if (pack === undefined) answer(404, "application/json", JSON.stringify({ error: "not found" }));
      else answer(200, "application/octet-stream", pack.tarball);
      return;
    }
    const name = pathname.slice(1);
    const versions = byName.get(name);
    if (versions === undefined) {
      answer(404, "application/json", JSON.stringify({ error: "not found" }));
      return;
    }
    answer(200, "application/json", JSON.stringify(packument(name, versions)));
  });

  return {
    url,
    requests: () => [...requests],
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
