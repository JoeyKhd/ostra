// Scans a built image for a setup secret's value (ADR 0038: "the build fails
// if the secret's value is found in the image"). The input is an OCI image
// tarball (BuildKit's `--output type=oci,dest=<file>`): every blob in it (the
// config, the manifests and each layer, gunzipped when compressed) is
// searched as text with `secretsFoundInLayers`. A layer is an uncompressed
// tar once gunzipped, so a secret in any file of any layer shows up as bytes.
//
// It never returns or prints a secret's value: only the ids found.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { runCommand, tarCommand } from "../harness/commands.ts";
import { secretsFoundInLayers } from "./dockerfile.ts";

const gunzipAsync = promisify(gunzip);

export type ImageScan = {
  readonly blobs: number;
  readonly bytesScanned: number;
  /** Ids of the secrets whose value was found. Empty is the pass. */
  readonly found: readonly string[];
};

const isGzip = (data: Buffer): boolean => data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;

/** Scans an OCI image tarball for the given secret values. Throws if the tarball can't be read. */
export const scanOciTarball = async (tarball: string, secretValues: Readonly<Record<string, string>>): Promise<ImageScan> => {
  const dir = await mkdtemp(path.join(tmpdir(), "ostra-image-scan-"));
  try {
    const untar = await runCommand(tarCommand(), ["-xf", tarball, "-C", dir], { timeoutMs: 600_000 });
    if (untar.code !== 0) throw new Error(`tar exited ${String(untar.code)}`);
    const blobDir = path.join(dir, "blobs", "sha256");
    const names = await readdir(blobDir);
    const found = new Set<string>();
    let bytesScanned = 0;
    for (const name of names) {
      const raw = await readFile(path.join(blobDir, name));
      const data = isGzip(raw) ? await gunzipAsync(raw) : raw;
      bytesScanned += data.length;
      for (const id of secretsFoundInLayers([data.toString("latin1")], secretValues)) found.add(id);
    }
    return { blobs: names.length, bytesScanned, found: [...found] };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
