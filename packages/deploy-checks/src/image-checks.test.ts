import { OPENCODE_VERSION, pinnedChecksums } from "@ostra/adapter-opencode";
import { describe, expect, it } from "vitest";

import { readDeployFiles } from "./deploy-files.ts";
import { checkCompose, checkDockerfile, checkImages } from "./image-checks.ts";
import type { DeployFiles, ImageRule } from "./image-checks.ts";
import { buildPlan } from "./images.ts";
import { NOTICES_PATH } from "./notices.ts";
import { parseYaml, yamlAt } from "./yaml.ts";

// Milestone 5's ticket 22 (F-039): the three images and the compose file, checked without Docker.
// Each rule runs on the repo's own files, which pass, and on a copy broken in one place, which
// fails with that rule. Moved and grown from the docker executor's `deploy.test.ts`.

const files = await readDeployFiles();

const rulesOf = (changed: Partial<DeployFiles>): readonly ImageRule[] => checkImages({ ...files, ...changed }).map((problem) => problem.rule);

const withDockerfile = (name: "server" | "runner" | "base", from: string | RegExp, to: string): Partial<DeployFiles> => {
  const text = files.dockerfiles[name];
  const changed = text.replace(from, to);
  expect(changed, `the ${name} Dockerfile's text to change`).not.toBe(text);
  return { dockerfiles: { ...files.dockerfiles, [name]: changed } };
};

describe("the repo's deploy files", () => {
  it("F-039/c1: the three Dockerfiles and the compose file pass every check", () => {
    expect(checkImages(files)).toEqual([]);
  });
});

describe("every FROM", () => {
  it("F-039/c1: every FROM has a digest: a tag alone fails, and an earlier stage's name passes", () => {
    for (const name of ["server", "runner", "base"] as const) {
      const froms = [...files.dockerfiles[name].matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? "");
      expect(froms.length, name).toBeGreaterThan(1);
      expect(froms.some((from) => /@sha256:[0-9a-f]{64}$/.test(from)), name).toBe(true);
      const unpinned = withDockerfile(name, /(FROM node:24\.14\.0-bookworm-slim)@sha256:[0-9a-f]{64}( AS runtime)/, "$1$2");
      expect(rulesOf(unpinned), name).toContain("from-digest");
    }
    // A stage's own name isn't an image, and a later stage's name can't be used before it exists.
    // Only the FROM rule is read here: these small files write no notices.
    const fromRules = (text: string): readonly ImageRule[] => checkDockerfile("runner", text, "").map((problem) => problem.rule).filter((rule) => rule !== "notices");
    expect(fromRules("FROM a:1@sha256:" + "0".repeat(64) + " AS one\nFROM one AS two\nUSER node\nENTRYPOINT [\"ostra\"]\n")).toEqual([]);
    expect(fromRules("FROM two AS one\nFROM a:1@sha256:" + "0".repeat(64) + " AS two\nUSER node\nENTRYPOINT [\"ostra\"]\n")).toEqual(["from-digest"]);
  });

  it("F-039: the compose file pins every image it doesn't build by digest", () => {
    expect(rulesOf({ compose: files.compose.replace(/(image: postgres:18\.6-bookworm)@sha256:[0-9a-f]{64}/, "$1") })).toContain("from-digest");
  });
});

describe("OpenCode's checksum", () => {
  it("F-039/c1: the checksum comes from the repo's pin: each architecture's expected SHA-256 is pinnedChecksums', fed to sha256sum -c", () => {
    const base = files.dockerfiles.base;
    expect(base).toContain(`@opencode/cli@${OPENCODE_VERSION}`);
    expect(base).toContain(`pkg=cli-linux-x64; sum=${pinnedChecksums["@opencode/cli-linux-x64"] ?? "missing"}`);
    expect(base).toContain(`pkg=cli-linux-arm64; sum=${pinnedChecksums["@opencode/cli-linux-arm64"] ?? "missing"}`);
    // A sum that differs from the pin by one character fails.
    const x64 = pinnedChecksums["@opencode/cli-linux-x64"] ?? "";
    const flipped = `${x64.slice(0, -1)}${x64.endsWith("0") ? "1" : "0"}`;
    expect(rulesOf(withDockerfile("base", x64, flipped))).toContain("opencode-pin");
  });

  it("F-039/c1: a checksum taken from the downloaded files fails, however it's read", () => {
    const x64 = pinnedChecksums["@opencode/cli-linux-x64"] ?? "";
    // Computed from the binary the build just fetched: it always matches, so it checks nothing.
    const computed = withDockerfile("base", `sum=${x64}`, 'sum=$(sha256sum "/opt/opencode/node_modules/@opencode/cli-linux-x64/bin/opencode" | cut -c1-64)');
    expect(rulesOf(computed)).toContain("opencode-pin");
    // Read from a file the package ships.
    const shipped = withDockerfile("base", `sum=${x64}`, "sum=$(cat /opt/opencode/node_modules/@opencode/cli-linux-x64/checksum)");
    expect(rulesOf(shipped)).toContain("opencode-pin");
    // The check dropped, or turned into a computation.
    expect(rulesOf(withDockerfile("base", 'echo "$sum  $bin" | sha256sum -c -; ', ""))).toContain("opencode-pin");
    expect(rulesOf(withDockerfile("base", "sha256sum -c -", 'sha256sum "$bin"'))).toContain("opencode-pin");
  });

  it("F-039/c1: OpenCode is installed at the adapter's version with its install scripts off", () => {
    expect(rulesOf(withDockerfile("base", " --ignore-scripts", ""))).toContain("opencode-pin");
    expect(rulesOf(withDockerfile("base", `@opencode/cli@${OPENCODE_VERSION}`, "@opencode/cli@latest"))).toContain("opencode-pin");
  });
});

describe("secrets", () => {
  it("F-039/c1: no secret-shaped ARG: an ARG or ENV named like a credential, or one set in a RUN, fails", () => {
    expect(rulesOf(withDockerfile("server", "FROM base AS build\n", "FROM base AS build\nARG NPM_TOKEN\n"))).toContain("secret");
    expect(rulesOf(withDockerfile("runner", "FROM base AS build\n", "FROM base AS build\nARG GITHUB_AUTH=none\n"))).toContain("secret");
    expect(rulesOf(withDockerfile("base", "ENV PNPM_HOME=/pnpm", "ENV OSTRA_SECRETS_KEY=x PNPM_HOME=/pnpm"))).toContain("secret");
    expect(rulesOf(withDockerfile("runner", "RUN pnpm install --frozen-lockfile --prod", "RUN NPM_TOKEN=abc pnpm install --frozen-lockfile --prod"))).toContain("secret");
    // A token-shaped value, whatever it's named.
    expect(rulesOf(withDockerfile("server", "RUN corepack enable", `RUN corepack enable && echo ghp_${"a1B2".repeat(9)}`))).toContain("secret");
    // `TARGETARCH` and the pins are not secrets: the repo's files pass (above).
  });

  it("F-039: the compose file holds no secret value", () => {
    expect(rulesOf({ compose: files.compose.replace("POSTGRES_DB: ostra", "POSTGRES_DB: ostra\n      POSTGRES_PASSWORD: hunter2") })).toContain("secret");
    expect(rulesOf({ compose: files.compose.replace("OSTRA_RUNNER_NAME: compose-pool", `OSTRA_RUNNER_NAME: ghp_${"a1B2".repeat(9)}`) })).toContain("secret");
  });
});

describe("the compose file and the build", () => {
  it("F-039/c2: the compose file runs the images the build tags", () => {
    const compose = parseYaml(files.compose);
    for (const build of buildPlan(files.releaseVersion)) {
      expect(yamlAt(compose, "services", build.name, "image")).toBe(build.tag);
      expect(yamlAt(compose, "services", build.name, "build", "dockerfile")).toBe(build.dockerfile);
    }
    expect(yamlAt(compose, "services", "runner", "environment", "OSTRA_BOX_BASE_IMAGE")).toBe(`ostra/base:${files.releaseVersion}`);
    expect(yamlAt(compose, "services", "runner", "environment", "OSTRA_BOX_RUNNER_IMAGE")).toBe(`ostra/runner:${files.releaseVersion}`);
    // Another release's tag, a box image the build doesn't make, or a built service gone: each fails.
    expect(checkCompose(files.compose, "9.9.9").map((problem) => problem.rule)).toContain("compose-images");
    for (const name of ["server", "runner", "base"]) {
      const other = files.compose.replace(`image: ostra/${name}:${files.releaseVersion}`, `image: ostra/${name}:latest`);
      expect(other).not.toBe(files.compose);
      expect(checkCompose(other, files.releaseVersion).map((problem) => problem.message), name).toContain(
        `${name} must run ostra/${name}:${files.releaseVersion}, the tag pnpm images:build gives it`,
      );
    }
    expect(rulesOf({ compose: files.compose.replace(`OSTRA_BOX_BASE_IMAGE: ostra/base:${files.releaseVersion}`, "OSTRA_BOX_BASE_IMAGE: ostra/base:latest") })).toContain("compose-images");
    expect(rulesOf({ compose: files.compose.replace("  base:\n", "  basic:\n") })).toContain("compose-images");
  });

  it("F-039/c2: the build plan tags each image with the release version, as docker's arguments, and refuses a version that isn't one", () => {
    expect(buildPlan("1.2.3").map((build) => build.args)).toEqual([
      ["build", "--file", "deploy/Dockerfile.server", "--tag", "ostra/server:1.2.3", "--label", "org.opencontainers.image.version=1.2.3", "."],
      ["build", "--file", "deploy/Dockerfile.runner", "--tag", "ostra/runner:1.2.3", "--label", "org.opencontainers.image.version=1.2.3", "."],
      ["build", "--file", "deploy/Dockerfile.base", "--tag", "ostra/base:1.2.3", "--label", "org.opencontainers.image.version=1.2.3", "."],
    ]);
    expect(() => buildPlan("1.2.3; rm -rf /")).toThrow();
    expect(rulesOf({ runnerVersion: "9.9.9" })).toContain("release-version");
  });

  it("runs the server (all), Postgres and one pool runner on the docker executor", () => {
    const compose = parseYaml(files.compose);
    expect(Object.keys(yamlAt(compose, "services") ?? {}).sort()).toEqual(["base", "postgres", "runner", "server"]);
    expect(yamlAt(compose, "services", "server", "command")).toEqual(["all"]);
    expect(yamlAt(compose, "services", "server", "ports")).toEqual(["3000:3000", "8787:8787"]);
    expect(yamlAt(compose, "services", "runner", "environment", "OSTRA_RUNNER_EXECUTOR")).toBe("docker");
    expect(yamlAt(compose, "services", "runner", "environment", "OSTRA_JOIN_TOKEN_FILE")).toBe("/var/lib/ostra-server/bootstrap-join-token");
    expect(yamlAt(compose, "services", "runner", "volumes")).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(yamlAt(compose, "services", "runner", "volumes")).toContain("server-data:/var/lib/ostra-server:ro");
    expect(yamlAt(compose, "services", "server", "environment", "OSTRA_DATA_DIR")).toBe("/var/lib/ostra");
  });

  it("says the Docker socket is root on the host, and where pools belong", () => {
    expect(files.compose).toMatch(/socket below is root on this host \(Q97\)/);
    expect(files.compose).toMatch(/pool runners belong on dedicated hosts/);
  });
});

describe("each image's own rules", () => {
  it("F-039/c1: the server runs as ostra-server web, core or all with a health check, and as a non-root user", () => {
    expect(rulesOf(withDockerfile("server", "USER node\n", ""))).toContain("non-root");
    expect(rulesOf(withDockerfile("server", "USER node\n", "USER root\n"))).toContain("non-root");
    expect(rulesOf(withDockerfile("server", /HEALTHCHECK [^\n]*\n/, ""))).toContain("health-check");
    expect(rulesOf(withDockerfile("server", 'ENTRYPOINT ["ostra-server"]', 'ENTRYPOINT ["node", "apps/core/src/main.ts"]'))).toContain("entrypoint");
    expect(rulesOf({ entrypoint: files.entrypoint.replace("  health)", "  check)") })).toContain("entrypoint");
  });

  it("F-039/c1: the runner is the ostra CLI, as a non-root user", () => {
    expect(rulesOf(withDockerfile("runner", "USER node\n", "USER 0\n"))).toContain("non-root");
    expect(rulesOf(withDockerfile("runner", 'ENTRYPOINT ["ostra"]', 'ENTRYPOINT ["node", "/app/apps/runner/src/main.ts"]'))).toContain("entrypoint");
    expect(files.dockerfiles.runner).toContain("exec node /app/apps/runner/src/main.ts");
  });

  it("F-039/c1: the base image has the catalog as a file with the fetch off, its init under tini, and downloads nothing when a box starts", () => {
    expect(files.dockerfiles.base).toContain("/opt/ostra/init/main.ts");
    expect(rulesOf(withDockerfile("base", "OPENCODE_DISABLE_MODELS_FETCH=1", "OPENCODE_DISABLE_MODELS_FETCH=0"))).toContain("catalog");
    expect(rulesOf(withDockerfile("base", /COPY packages\/adapters\/adapter-model-endpoint[^\n]*\n/, ""))).toContain("catalog");
    expect(rulesOf(withDockerfile("base", 'CMD ["node", "/opt/ostra/init/main.ts"]', 'CMD ["sh", "-c", "npm install -g @opencode/cli && node /opt/ostra/init/main.ts"]'))).toContain("catalog");
    expect(rulesOf(withDockerfile("base", 'ENTRYPOINT ["tini", "--"]', 'ENTRYPOINT ["node"]'))).toContain("entrypoint");
  });
});

describe("the YAML reader", () => {
  it("reads maps, lists, inline lists and quoted scalars, and refuses what it doesn't know", () => {
    expect(parseYaml("a:\n  b: 'x'\n  c: [1, \"2\"]\n  d:\n    - e # comment\n")).toEqual({ a: { b: "x", c: ["1", "2"], d: ["e"] } });
    expect(() => parseYaml("just text\n")).toThrow();
  });
});

// Milestone 7's ticket 29: each image writes its THIRD_PARTY_NOTICES in its build and carries them.
describe("the notices in each image", () => {
  it("F-039/c1: each image writes its notices from its own install and copies them to the same path; the runner installs no agent", () => {
    for (const name of ["server", "runner", "base"] as const) {
      expect(files.dockerfiles[name], name).toContain(`/opt/notices/out/THIRD_PARTY_NOTICES ${NOTICES_PATH}`);
      expect(rulesOf(withDockerfile(name, ` ${NOTICES_PATH}`, " /THIRD_PARTY_NOTICES")), name).toContain("notices");
      expect(rulesOf(withDockerfile(name, `--image ${name}`, "--image other")), name).toContain("notices");
      expect(rulesOf(withDockerfile(name, "notices-main.ts --image", "notices.ts --image")), name).toContain("notices");
    }
    // The bundle the checkout's check reads is the one the Dockerfile prunes and installs.
    expect(rulesOf(withDockerfile("runner", "prune @ostra/runner --docker", "prune @ostra/runner @ostra/core --docker"))).toContain("notices");
    expect(rulesOf(withDockerfile("runner", "pnpm licenses list --json --recursive --prod", "pnpm licenses list --json --recursive"))).toContain("notices");
    expect(rulesOf(withDockerfile("server", "pnpm licenses list --json --recursive >", "pnpm licenses list --json --recursive --prod >"))).toContain("notices");
    expect(rulesOf(withDockerfile("base", " --extra /opt/notices/extra/models-dev.json", ""))).toContain("notices");
    // The runner's build checks that its install holds no agent, and it installs none.
    expect(rulesOf(withDockerfile("runner", "/app/node_modules/.pnpm --without-agent", "/app/node_modules/.pnpm"))).toContain("notices");
    expect(rulesOf(withDockerfile("runner", "USER node", "RUN npm install --ignore-scripts @opencode/cli@2.3.2\nUSER node"))).toContain("no-agent");
  });
});
