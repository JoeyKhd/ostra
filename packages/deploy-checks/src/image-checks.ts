// The static checks of the three images and the compose file (F-039, ADR 0046's milestone 5
// section): every `FROM` pinned by digest, OpenCode's checksum taken from the repo's pin and never
// from the download, no secret in an `ARG`, `ENV` or `RUN`, the server and the runner as a non-root
// user, and the compose file running the images the build tags. `pnpm check:images` runs them.

import { OPENCODE_VERSION, pinnedChecksums } from "@ostra/adapter-opencode";
import { redactTokens } from "@ostra/adapter-sdk";

import { envValue, execForm, namesSet, parseDockerfile, stagesOf } from "./dockerfile.ts";
import type { Instruction, Stage } from "./dockerfile.ts";
import { buildPlan, dockerfileOf, imageNames } from "./images.ts";
import type { ImageName } from "./images.ts";
import { isYamlList, parseYaml, yamlAt, yamlPairs, yamlScalars } from "./yaml.ts";
import type { Yaml } from "./yaml.ts";

export type ImageRule =
  | "from-digest"
  | "opencode-pin"
  | "secret"
  | "non-root"
  | "entrypoint"
  | "health-check"
  | "catalog"
  | "compose-images"
  | "release-version";

export type Problem = { readonly file: string; readonly line: number | null; readonly rule: ImageRule; readonly message: string };

/** What the checks read: each file's text. */
export type DeployFiles = {
  readonly dockerfiles: Readonly<Record<ImageName, string>>;
  readonly compose: string;
  /** deploy/server-entrypoint.sh, the server image's `ostra-server`. */
  readonly entrypoint: string;
  readonly releaseVersion: string;
  /** apps/runner/package.json's version, which `ostra --version` prints. */
  readonly runnerVersion: string;
};

/** An image reference pinned by tag and digest: `name:tag@sha256:<64 hex>`. */
export const DIGEST_PINNED = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

/** `ARG` and `ENV` names that hold a credential. Build secrets go through `RUN --mount=type=secret`. */
const SECRET_NAME = /TOKEN|SECRET|PASSW|PRIVATE|CREDENTIAL|AUTH|(?:^|_)KEY(?:$|_)/i;

/** The platform package each architecture the base image builds for checks against its pin. */
const OPENCODE_ARCHES = [
  { arch: "amd64", pkg: "cli-linux-x64" },
  { arch: "arm64", pkg: "cli-linux-arm64" },
] as const;

const fromDigests = (file: string, stages: readonly Stage[], instructions: readonly Instruction[]): Problem[] => {
  const froms = instructions.filter((instruction) => instruction.keyword === "FROM");
  const problems: Problem[] = [];
  if (froms.length === 0) {
    problems.push({ file, line: null, rule: "from-digest", message: "has no FROM" });
  }
  for (const [index, stage] of stages.entries()) {
    const earlier = stages.slice(0, index).map((item) => item.name);
    if (!earlier.includes(stage.from) && !DIGEST_PINNED.test(stage.from)) {
      problems.push({ file, line: froms[index]?.line ?? null, rule: "from-digest", message: `FROM ${stage.from} isn't pinned by digest (name:tag@sha256:...)` });
    }
  }
  return problems;
};

const secrets = (file: string, instructions: readonly Instruction[]): Problem[] => {
  const problems: Problem[] = [];
  for (const instruction of instructions) {
    for (const name of namesSet(instruction)) {
      if (SECRET_NAME.test(name)) {
        problems.push({ file, line: instruction.line, rule: "secret", message: `${instruction.keyword} ${name} is shaped like a secret: use a build secret mount` });
      }
    }
    if (instruction.keyword === "RUN") {
      const assigned = [...instruction.args.matchAll(/(?:^|[\s;&|])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1] ?? "");
      for (const name of assigned.filter((item) => SECRET_NAME.test(item))) {
        problems.push({ file, line: instruction.line, rule: "secret", message: `RUN sets ${name}, shaped like a secret` });
      }
    }
    if (instruction.keyword === "RUN" || instruction.keyword === "ENV" || instruction.keyword === "ARG") {
      // Paths and URLs are long runs of the characters a token uses: the token check reads the rest.
      for (const word of instruction.args.split(/\s+/).filter((item) => !item.includes("/"))) {
        if (redactTokens(word) !== word) {
          problems.push({ file, line: instruction.line, rule: "secret", message: `${instruction.keyword} holds a token-shaped value` });
        }
      }
    }
  }
  return problems;
};

const lastOf = (stage: Stage | undefined, keyword: string): Instruction | undefined =>
  stage?.instructions.filter((instruction) => instruction.keyword === keyword).at(-1);

const nonRoot = (file: string, stage: Stage | undefined): Problem[] => {
  const user = lastOf(stage, "USER");
  return user === undefined || /^(?:root|0)(?::|$)/.test(user.args.trim())
    ? [{ file, line: user?.line ?? null, rule: "non-root", message: "the image's last USER must be a non-root user" }]
    : [];
};

const entrypointIs = (file: string, stage: Stage | undefined, expected: readonly string[]): Problem[] => {
  const entrypoint = lastOf(stage, "ENTRYPOINT");
  const words = entrypoint === undefined ? null : execForm(entrypoint);
  return words !== null && JSON.stringify(words) === JSON.stringify(expected)
    ? []
    : [{ file, line: entrypoint?.line ?? null, rule: "entrypoint", message: `the ENTRYPOINT must be ${JSON.stringify(expected)}` }];
};

/**
 * OpenCode's binary checked against the repo's pin (ADR 0046): installed at `OPENCODE_VERSION` with
 * its scripts off, each architecture's expected SHA-256 written as the literal `pinnedChecksums`
 * holds, and that literal fed to `sha256sum -c`. A sum computed from anything the build fetched
 * (`$(sha256sum ...)`, a file of the package) proves nothing, so `sha256sum` may only check.
 */
const opencodePin = (file: string, instructions: readonly Instruction[]): Problem[] => {
  const problem = (message: string, line: number | null = null): Problem => ({ file, line, rule: "opencode-pin", message });
  const runs = instructions.filter((instruction) => instruction.keyword === "RUN");
  const install = runs.find((run) => run.args.includes("@opencode/cli@"));
  if (install === undefined) {
    return [problem("OpenCode isn't installed")];
  }
  const problems: Problem[] = [];
  if (!new RegExp(`@opencode/cli@${OPENCODE_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`).test(install.args)) {
    problems.push(problem(`OpenCode must be installed at the adapter's version, ${OPENCODE_VERSION}`, install.line));
  }
  if (!install.args.includes("--ignore-scripts")) {
    problems.push(problem("OpenCode's install must run no scripts (--ignore-scripts)", install.line));
  }
  const check = runs.find((run) => run.args.includes("sha256sum"));
  if (check === undefined) {
    return [...problems, problem("OpenCode's binary is never checked with sha256sum")];
  }
  if ([...check.args.matchAll(/sha256sum(\s+\S+)?/g)].some((use) => use[1]?.trim() !== "-c")) {
    problems.push(problem("sha256sum may only check (-c) against the repo's pin, never compute the expected sum", check.line));
  }
  if (!/echo "\$sum {2}\$bin" \| sha256sum -c -/.test(check.args)) {
    problems.push(problem('the check must be `echo "$sum  $bin" | sha256sum -c -`', check.line));
  }
  const sums = [...check.args.matchAll(/(?:^|[\s;])sum=([^\s;]*)/g)].map((match) => match[1] ?? "");
  if (sums.length === 0 || sums.some((sum) => !/^[0-9a-f]{64}$/.test(sum))) {
    problems.push(problem("every expected sum must be a literal SHA-256 from the repo's pin, never computed in the build", check.line));
  }
  for (const { arch, pkg } of OPENCODE_ARCHES) {
    const pinned = pinnedChecksums[`@opencode/${pkg}`];
    const written = new RegExp(`${arch}\\)\\s*pkg=${pkg};\\s*sum=([^\\s;]+)`).exec(check.args)?.[1];
    if (pinned === undefined || written !== pinned) {
      problems.push(problem(`${arch}'s expected sum must be pinnedChecksums["@opencode/${pkg}"]`, check.line));
    }
  }
  return problems;
};

const baseImage = (file: string, instructions: readonly Instruction[], final: Stage | undefined): Problem[] => {
  const problems = [...opencodePin(file, instructions), ...entrypointIs(file, final, ["tini", "--"])];
  const env = final?.instructions.filter((instruction) => instruction.keyword === "ENV") ?? [];
  const valueOf = (name: string): string | null => env.map((instruction) => envValue(instruction, name)).find((value) => value !== null) ?? null;
  const catalog = valueOf("OPENCODE_MODELS_PATH");
  const copied = final?.instructions.some((instruction) => instruction.keyword === "COPY" && catalog !== null && instruction.args.endsWith(` ${catalog}`)) ?? false;
  if (catalog === null || !copied) {
    problems.push({ file, line: null, rule: "catalog", message: "the model catalog must be a file in the image, named by OPENCODE_MODELS_PATH" });
  }
  for (const name of ["OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_AUTOUPDATE"]) {
    if (valueOf(name) !== "1") {
      problems.push({ file, line: null, rule: "catalog", message: `${name}=1: nothing is fetched when a box starts` });
    }
  }
  const start = final?.instructions.filter((instruction) => instruction.keyword === "CMD" || instruction.keyword === "ENTRYPOINT") ?? [];
  if (start.some((instruction) => /\b(?:npm|npx|pnpm|curl|wget|corepack)\b/.test(instruction.args))) {
    problems.push({ file, line: null, rule: "catalog", message: "a box's start must download nothing" });
  }
  return problems;
};

const serverImage = (file: string, final: Stage | undefined, entrypoint: string): Problem[] => {
  const problems = [...nonRoot(file, final), ...entrypointIs(file, final, ["ostra-server"])];
  const health = lastOf(final, "HEALTHCHECK");
  if (health === undefined || !/CMD\s+\["ostra-server",\s*"health"\]/.test(health.args)) {
    problems.push({ file, line: health?.line ?? null, rule: "health-check", message: 'the server needs HEALTHCHECK ... CMD ["ostra-server", "health"]' });
  }
  if (!/web\)[\s\S]*core\)[\s\S]*all\)[\s\S]*health\)/.test(entrypoint)) {
    problems.push({ file: "deploy/server-entrypoint.sh", line: null, rule: "entrypoint", message: "ostra-server runs web, core or all, and answers health" });
  }
  return problems;
};

/** Checks one Dockerfile. */
export const checkDockerfile = (name: ImageName, text: string, entrypoint: string): readonly Problem[] => {
  const file = dockerfileOf(name);
  const instructions = parseDockerfile(text);
  const stages = stagesOf(instructions);
  const final = stages.at(-1);
  const own = ((): Problem[] => {
    switch (name) {
      case "server":
        return serverImage(file, final, entrypoint);
      case "runner":
        return [...nonRoot(file, final), ...entrypointIs(file, final, ["ostra"])];
      case "base":
        return baseImage(file, instructions, final);
      default:
        return name satisfies never;
    }
  })();
  return [...fromDigests(file, stages, instructions), ...secrets(file, instructions), ...own];
};

const COMPOSE = "deploy/compose.yaml";

/** The compose file runs exactly the images the build tags, and pins every other image by digest. */
export const checkCompose = (text: string, version: string): readonly Problem[] => {
  const problem = (rule: ImageRule, message: string): Problem => ({ file: COMPOSE, line: null, rule, message });
  let compose: Yaml;
  try {
    compose = parseYaml(text);
  } catch (error) {
    return [problem("compose-images", `can't be read: ${error instanceof Error ? error.message : "unknown"}`)];
  }
  const services = yamlAt(compose, "services");
  if (services === undefined || typeof services === "string" || isYamlList(services)) {
    return [problem("compose-images", "has no services")];
  }
  const problems: Problem[] = [];
  const builds = new Map(buildPlan(version).map((build) => [build.name, build]));
  for (const [service, definition] of Object.entries(services)) {
    const image = yamlAt(definition, "image");
    const built = imageNames.find((name) => name === service);
    if (built === undefined) {
      if (typeof image !== "string" || !DIGEST_PINNED.test(image)) {
        problems.push(problem("from-digest", `${service}'s image must be pinned by digest`));
      }
      continue;
    }
    const build = builds.get(built);
    if (image !== build?.tag) {
      problems.push(problem("compose-images", `${service} must run ${build?.tag ?? "its build's tag"}, the tag pnpm images:build gives it`));
    }
    if (yamlAt(definition, "build", "dockerfile") !== build?.dockerfile) {
      problems.push(problem("compose-images", `${service} must build from ${build?.dockerfile ?? "its Dockerfile"}`));
    }
  }
  for (const name of imageNames.filter((item) => !(item in services))) {
    problems.push(problem("compose-images", `has no ${name} service, so ${builds.get(name)?.tag ?? name} isn't built with it`));
  }
  // The runner starts boxes from the base image and its sidecar from the runner image: the same tags.
  const boxImages = [
    ["OSTRA_BOX_BASE_IMAGE", "base"],
    ["OSTRA_BOX_RUNNER_IMAGE", "runner"],
  ] as const;
  for (const [setting, name] of boxImages) {
    if (yamlAt(compose, "services", "runner", "environment", setting) !== builds.get(name)?.tag) {
      problems.push(problem("compose-images", `the runner's ${setting} must be ${builds.get(name)?.tag ?? name}`));
    }
  }
  for (const [key, value] of yamlPairs(compose)) {
    if (/PASSWORD|SECRET|TOKEN$|_KEY$/i.test(key) && !/^\$\{[A-Z_]+(?::-[^}]*)?\}$|^\//.test(value)) {
      problems.push(problem("secret", `${key} holds a value: name a variable or a file`));
    }
  }
  // Paths and URLs are long runs of the characters a token uses: the token check reads the rest.
  for (const value of yamlScalars(compose).filter((item) => !item.includes("/"))) {
    if (redactTokens(value) !== value) {
      problems.push(problem("secret", "holds a token-shaped value"));
    }
  }
  return problems;
};

/** Every check over the deploy files. Empty when they pass. */
export const checkImages = (files: DeployFiles): readonly Problem[] => [
  ...imageNames.flatMap((name) => checkDockerfile(name, files.dockerfiles[name], files.entrypoint)),
  ...checkCompose(files.compose, files.releaseVersion),
  ...(files.runnerVersion === files.releaseVersion
    ? []
    : [
        {
          file: "apps/runner/package.json",
          line: null,
          rule: "release-version",
          message: "the runner's version must be the release version, which `ostra --version` prints",
        } satisfies Problem,
      ]),
];
