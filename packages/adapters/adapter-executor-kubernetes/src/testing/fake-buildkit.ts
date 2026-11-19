import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import { OCI_CONFIG, OCI_INDEX, OCI_LAYER, OCI_MANIFEST, tarOf } from "@ostra/adapter-sdk/testing/net";
import type { TarEntry } from "@ostra/adapter-sdk/testing/net";

// A stand-in for rootless BuildKit's `buildctl-daemonless.sh build` in the fake cluster's process
// mode (ticket 08): it reads the build's arguments as the pod gives them, makes an image whose one
// layer holds the build context, and exports it as an OCI tarball where `--output type=oci,dest=`
// says. It runs no Dockerfile: a setup script that says `LEAK` stands for one that writes its
// secrets into a file, and the layer then holds each secret BuildKit was given, so the scan has
// something to find. The process mode doesn't rewrite paths inside an argument, so the pod's mount
// paths are read under the pod's folder here. Test only.

const podDir = process.env["OSTRA_FAKE_KUBE_POD_DIR"] ?? "";
const MOUNTS: Readonly<Record<string, string>> = {
  "/context": "context",
  "/out": "out",
  "/run/ostra-build/secrets": "setup-secrets",
};
const local = (mounted: string): string => {
  const base = Object.keys(MOUNTS)
    .sort((a, b) => b.length - a.length)
    .find((mount) => mounted === mount || mounted.startsWith(`${mount}/`));
  if (base === undefined) return mounted;
  return path.join(podDir, "volumes", MOUNTS[base] ?? "", ...mounted.slice(base.length).split("/").filter((part) => part !== ""));
};

const args = process.argv.slice(2);
const contextArg = args.find((arg) => arg.startsWith("--local=context="))?.slice("--local=context=".length) ?? "/context";
const output = args[args.indexOf("--output") + 1] ?? "";
const dest = /dest=([^,]+)/.exec(output)?.[1] ?? "/out/image.tar";
const secrets = args.flatMap((arg, index) => (args[index - 1] === "--secret" ? [/src=([^,]+)/.exec(arg)?.[1] ?? ""] : [])).filter((src) => src !== "");

const walk = async (dir: string, prefix = ""): Promise<TarEntry[]> => {
  const entries: TarEntry[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.name === ".git") continue;
    if (item.isDirectory()) entries.push(...(await walk(path.join(dir, item.name), rel)));
    else if (item.isFile()) entries.push({ name: `task/snapshot/${rel}`, content: await readFile(path.join(dir, item.name)) });
  }
  return entries;
};

const sha = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

const context = local(contextArg);
const files = await walk(context);
const setups = files.filter((file) => /task\/snapshot\/ostra\/setup.*\.sh$/.test(file.name));
if (setups.some((file) => file.content.toString("utf8").includes("LEAK"))) {
  for (const [index, src] of secrets.entries()) files.push({ name: `task/leaked-${String(index)}`, content: await readFile(local(src)) });
}
const layerTar = tarOf(files);
const layer = await promisify(gzip)(layerTar);
const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [sha(layerTar)] }, config: {} }));
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, digest: sha(config), size: config.length },
    layers: [{ mediaType: OCI_LAYER, digest: sha(layer), size: layer.length }],
  }),
);
const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ mediaType: OCI_MANIFEST, digest: sha(manifest), size: manifest.length }] }));
const blob = (data: Buffer): TarEntry => ({ name: `blobs/sha256/${sha(data).slice("sha256:".length)}`, content: data });
await writeFile(
  local(dest),
  tarOf([{ name: "oci-layout", content: Buffer.from('{"imageLayoutVersion":"1.0.0"}') }, { name: "index.json", content: index }, blob(manifest), blob(config), blob(layer)]),
);
process.stdout.write(`fake buildkit: ${String(files.length)} files in one layer, exported\n`);
