import { readFile } from "node:fs/promises";
import path from "node:path";

/** The repo's root folder: this package lives at `packages/deploy-checks`. */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** Reads a file of the repo by its path from the root, with forward slashes. */
export const readRepoFile = (file: string): Promise<string> => readFile(path.join(repoRoot, ...file.split("/")), "utf8");

/** The release version: the root package.json's, which the images are tagged with (ADR 0046). */
export const releaseVersion = async (): Promise<string> => {
  const pkg: unknown = JSON.parse(await readRepoFile("package.json"));
  const version: unknown = Reflect.get(Object(pkg), "version");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("the root package.json has no release version");
  }
  return version;
};
