// The layer scan on a hand-made OCI-layout tarball: one gzipped "layer" and
// one plain blob. It tests the scan, not a real image (that is the real-box
// snapshot run).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand, tarCommand } from "../src/harness/commands.ts";
import { scanOciTarball } from "../src/snapshot/image-scan.ts";

const gzipAsync = promisify(gzip);
const CANARY = "OSTRA-SETUP-CANARY-0123456789abcdef";

const makeTarball = async (dir: string, name: string, layerText: string): Promise<string> => {
  const layout = path.join(dir, name);
  await mkdir(path.join(layout, "blobs", "sha256"), { recursive: true });
  await writeFile(path.join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  await writeFile(path.join(layout, "blobs", "sha256", "a".repeat(64)), await gzipAsync(Buffer.from(layerText)));
  await writeFile(path.join(layout, "blobs", "sha256", "b".repeat(64)), '{"config":{}}');
  const tarball = path.join(dir, `${name}.tar`);
  const result = await runCommand(tarCommand(), ["-cf", tarball, "-C", layout, "."]);
  if (result.code !== 0) throw new Error(`tar failed: ${result.stderr}`);
  return tarball;
};

describe("scanOciTarball", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ostra-scan-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a secret inside a gzipped layer", async () => {
    const scan = await scanOciTarball(await makeTarball(dir, "baked", `etc/npmrc\0token=${CANARY}\n`), { canary: CANARY });
    expect(scan.found).toEqual(["canary"]);
    expect(scan.blobs).toBe(2);
  });
  it("clears an image without it", async () => {
    const scan = await scanOciTarball(await makeTarball(dir, "clean", "etc/npmrc\0registry=https://example.invalid\n"), { canary: CANARY });
    expect(scan.found).toEqual([]);
  });
});
