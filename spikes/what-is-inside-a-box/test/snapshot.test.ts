import { describe, expect, it } from "vitest";
import { generateSnapshotDockerfile, secretsFoundInLayers } from "../src/snapshot/dockerfile.ts";

describe("generateSnapshotDockerfile (ADR 0038)", () => {
  const spec = {
    baseImage: "ostra/base@sha256:" + "0".repeat(64),
    repos: [{ name: "ostra-test/app", commit: "a".repeat(40) }],
    setupScript: "pnpm install --frozen-lockfile",
    setupSecrets: [{ id: "npm_token", mountPath: "/run/secrets/npm_token" }],
  };
  it("mounts setup secrets instead of baking them", () => {
    const dockerfile = generateSnapshotDockerfile(spec);
    expect(dockerfile).toContain("--mount=type=secret,id=npm_token,target=/run/secrets/npm_token");
    expect(dockerfile).toContain("FROM ostra/base@sha256:");
    expect(dockerfile).toContain("USER agent");
  });
  it("rejects a base image that is not pinned by digest", () => {
    expect(() => generateSnapshotDockerfile({ ...spec, baseImage: "ostra/base:latest" })).toThrow();
  });
  it("rejects a repo name with . or .. segments (COPY must stay in the build context)", () => {
    expect(() => generateSnapshotDockerfile({ ...spec, repos: [{ name: "../..", commit: "a".repeat(40) }] })).toThrow();
    expect(() => generateSnapshotDockerfile({ ...spec, repos: [{ name: "ostra-test/..", commit: "a".repeat(40) }] })).toThrow();
  });
  it("rejects a repo at a non-commit ref", () => {
    expect(() => generateSnapshotDockerfile({ ...spec, repos: [{ name: "ostra-test/app", commit: "main" }] })).toThrow();
  });
});

describe("secretsFoundInLayers", () => {
  it("flags a secret that leaked into a layer", () => {
    expect(secretsFoundInLayers(["token=npm_tok_secret_value"], { npm_token: "npm_tok_secret_value" })).toEqual(["npm_token"]);
  });
  it("clears an image with no secret", () => {
    expect(secretsFoundInLayers(["clean build output"], { npm_token: "npm_tok_secret_value" })).toEqual([]);
  });
});
