import { readFile } from "node:fs/promises";
import path from "node:path";

import { IMAGE_NAMESPACE } from "./images.ts";

/** The repo's root folder: this package lives at `packages/deploy-checks`. */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** Reads a file of the repo by its path from the root, with forward slashes. `root` is another checkout's, in a test. */
export const readRepoFile = (file: string, root: string = repoRoot): Promise<string> => readFile(path.join(root, ...file.split("/")), "utf8");

/** A field of the root package.json, if it's a string that matches `format`. */
const rootField = async (root: string, field: string, format: RegExp): Promise<string | null> => {
  const pkg: unknown = JSON.parse(await readRepoFile("package.json", root));
  const value: unknown = Reflect.get(Object(pkg), field);
  return typeof value === "string" && format.test(value) ? value : null;
};

/** The release version: the root package.json's, which the images are tagged with (ADR 0046). */
export const releaseVersion = async (root: string = repoRoot): Promise<string> => {
  const version = await rootField(root, "version", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  if (version === null) {
    throw new Error("the root package.json has no release version");
  }
  return version;
};

/**
 * The namespace the release's images are published under: the root package.json's
 * `imageNamespace`, which the release's stamp sets (`ghcr.io/<owner>`, say; `ostra` in a clone).
 * The build tags each image `<namespace>/<name>:<version>`, and the compose file and charts name it.
 */
export const imageNamespace = async (root: string = repoRoot): Promise<string> => {
  const namespace = await rootField(root, "imageNamespace", IMAGE_NAMESPACE);
  if (namespace === null) {
    throw new Error("the root package.json has no imageNamespace");
  }
  return namespace;
};
