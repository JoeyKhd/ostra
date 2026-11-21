// The static checks of the three images and the compose file (F-039, ADR 0046's milestone 5
// section): every `FROM` pinned by digest, OpenCode's checksum taken from the repo's pin and never
// from the download, no secret in an `ARG`, `ENV` or `RUN`, the server and the runner as a non-root
// user, and the compose file running the images the build tags. `pnpm check:images` runs them.

import { OPENCODE_VERSION, pinnedChecksums } from "@ostra/adapter-opencode";
import { redactTokens } from "@ostra/adapter-sdk";

import { envValue, execForm, namesSet, parseDockerfile, stagesOf } from "./dockerfile.ts";
import type { Instruction, Stage } from "./dockerfile.ts";
import { buildPlan, dockerfileOf, imageBundles, imageNames } from "./images.ts";
import type { ImageName } from "./images.ts";
import { NOTICES_PATH } from "./notices.ts";
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
  | "release-version"
  | "notices"
  | "no-agent"
  | "pruned-root"
  | "openssl";

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

/** The stage whose RUN does `needle`, such as the server's `@ostra/db generate`. */
const stageRunning = (stages: readonly Stage[], needle: string): Stage | undefined =>
  stages.find((stage) => stage.instructions.some((instruction) => instruction.keyword === "RUN" && instruction.args.includes(needle)));

/** Whether a COPY of the build context names `source` among its sources. */
const copiesFromContext = (stage: Stage, source: string): boolean =>
  stage.instructions.some((instruction) => {
    const words = instruction.args.split(/\s+/);
    return instruction.keyword === "COPY" && !words.some((word) => word.startsWith("--from=")) && words.slice(0, -1).includes(source);
  });

/**
 * The server builds in `turbo prune`'s tree, which keeps the packages and the root's package.json,
 * lockfile and turbo.json, but not the root tsconfig.base.json every package's tsconfig extends:
 * Prisma's generate and `next build` read those tsconfigs, and fail without it (the Proof run of
 * 2026-11-21). The runner and the base image run their TypeScript with Node, which reads none.
 */
const prunedRoot = (file: string, stages: readonly Stage[]): Problem[] => {
  const build = stageRunning(stages, "@ostra/db generate");
  return build !== undefined && copiesFromContext(build, "tsconfig.base.json")
    ? []
    : [{ file, line: null, rule: "pruned-root", message: "the stage that runs @ostra/db generate and next build must COPY tsconfig.base.json, which turbo prune leaves out" }];
};

/** The index of the first instruction in `stage` that `test` matches, or -1. */
const indexOf = (stage: Stage | undefined, test: (instruction: Instruction) => boolean): number => stage?.instructions.findIndex(test) ?? -1;

const installsOpenssl = (instruction: Instruction): boolean => instruction.keyword === "RUN" && /apt-get install\b[^;&|]*\sopenssl(?:\s|$)/.test(instruction.args);

/**
 * Prisma's schema engine, which runs the migrations when the server's `core` or `all` starts, links
 * OpenSSL, which the slim image lacks. The build installs it before `pnpm install`, whose Prisma
 * postinstall picks the engine by the OpenSSL it finds (with none it takes the OpenSSL 1.1 build,
 * which bookworm can't load), and the final stage installs it to run that engine.
 */
const prismaOpenssl = (file: string, stages: readonly Stage[], final: Stage | undefined): Problem[] => {
  const problem = (message: string): Problem => ({ file, line: null, rule: "openssl", message });
  const build = stageRunning(stages, "pnpm install --frozen-lockfile");
  const openssl = indexOf(build, installsOpenssl);
  const install = indexOf(build, (instruction) => instruction.keyword === "RUN" && instruction.args.includes("pnpm install --frozen-lockfile"));
  return [
    ...(openssl >= 0 && openssl < install ? [] : [problem("the build stage must apt-get install openssl before pnpm install, so Prisma fetches the engine for it")]),
    ...(indexOf(final, installsOpenssl) >= 0 ? [] : [problem("the final stage must apt-get install openssl, which Prisma's schema engine links")]),
  ];
};

/** A RUN option's value: `--out /x` gives `/x`. */
const optionOf = (args: string, option: string): string | null => new RegExp(String.raw`(?:^|\s)${option}\s+(\S+)`).exec(args)?.[1] ?? null;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * The image's THIRD_PARTY_NOTICES (milestone 7's ticket 29): `turbo prune` keeps the workspace
 * packages `imageBundles` names, the install is `--prod` when the bundle is, `notices-main.ts`
 * writes the notices from `pnpm licenses list --json --recursive` of that install (checking them
 * against the install's store, and that OpenCode isn't in it when the bundle carries no agent),
 * and the final stage copies them to NOTICES_PATH.
 */
const notices = (name: ImageName, file: string, instructions: readonly Instruction[], final: Stage | undefined): Problem[] => {
  const problem = (message: string, line: number | null = null): Problem => ({ file, line, rule: "notices", message });
  const bundle = imageBundles[name];
  const runs = instructions.filter((instruction) => instruction.keyword === "RUN");
  const problems: Problem[] = [];
  const prune = runs.find((run) => / prune .* --docker/.test(run.args));
  const pruned = / prune ((?:@[\w./-]+\s+)+)--docker/.exec(prune?.args ?? "")?.[1]?.trim().split(/\s+/) ?? [];
  if (!sameSet(pruned, bundle.workspaces)) {
    problems.push(problem(`turbo prune must keep ${bundle.workspaces.join(" ")}, which imageBundles says the notices list`, prune?.line ?? null));
  }
  const install = runs.find((run) => run.args.includes("pnpm install --frozen-lockfile"));
  if (install === undefined || /\s--prod(?:\s|$)/.test(install.args) !== bundle.prod) {
    problems.push(problem(`the install must ${bundle.prod ? "" : "not "}be --prod, as imageBundles says`, install?.line ?? null));
  }
  const generate = runs.find((run) => run.args.includes("notices-main.ts"));
  if (generate === undefined) {
    return [...problems, problem("no RUN writes the notices with notices-main.ts")];
  }
  const listing = /pnpm licenses list --json --recursive( --prod)? > (\S+)/.exec(generate.args);
  if (listing === null || (listing[1] !== undefined) !== bundle.prod) {
    problems.push(problem(`the notices must read pnpm licenses list --json --recursive${bundle.prod ? " --prod" : ""} > <file>`, generate.line));
  }
  if (optionOf(generate.args, "--image") !== name || optionOf(generate.args, "--pnpm-licenses") !== (listing?.[2] ?? null) || optionOf(generate.args, "--pnpm-store") === null) {
    problems.push(problem(`notices-main.ts must run with --image ${name}, the listing as --pnpm-licenses and the install's store as --pnpm-store`, generate.line));
  }
  if (!bundle.agent && !/\s--without-agent(?:\s|$)/.test(generate.args)) {
    problems.push(problem("the install carries no agent, so notices-main.ts must check it with --without-agent", generate.line));
  }
  if (name === "base" && (optionOf(generate.args, "--npm-modules") === null || optionOf(generate.args, "--extra") === null)) {
    problems.push(problem("the base image's notices also read OpenCode's npm install (--npm-modules) and the catalog's notice (--extra)", generate.line));
  }
  const out = optionOf(generate.args, "--out");
  const copied = final?.instructions.some((instruction) => {
    const words = instruction.args.split(/\s+/);
    return instruction.keyword === "COPY" && (words[0] ?? "").startsWith("--from=") && words.at(-1) === NOTICES_PATH && words.at(-2) === out;
  });
  if (out === null || copied !== true) {
    problems.push(problem(`the final stage must COPY --from the notices notices-main.ts wrote (its --out) to ${NOTICES_PATH}`));
  }
  return problems;
};

/** The runner image installs no agent: in a box, the agent runs in the base image. */
const noAgent = (file: string, instructions: readonly Instruction[]): Problem[] =>
  instructions
    .filter((instruction) => instruction.keyword === "RUN" && /@opencode\/cli@|\bopencode-ai\b/.test(instruction.args))
    .map((instruction): Problem => ({ file, line: instruction.line, rule: "no-agent", message: "the runner image installs no agent: in a box, the agent runs in the base image" }));

/** Checks one Dockerfile. */
export const checkDockerfile = (name: ImageName, text: string, entrypoint: string): readonly Problem[] => {
  const file = dockerfileOf(name);
  const instructions = parseDockerfile(text);
  const stages = stagesOf(instructions);
  const final = stages.at(-1);
  const own = ((): Problem[] => {
    switch (name) {
      case "server":
        return [...serverImage(file, final, entrypoint), ...prunedRoot(file, stages), ...prismaOpenssl(file, stages, final)];
      case "runner":
        return [...nonRoot(file, final), ...entrypointIs(file, final, ["ostra"]), ...noAgent(file, instructions)];
      case "base":
        return baseImage(file, instructions, final);
      default:
        return name satisfies never;
    }
  })();
  return [...fromDigests(file, stages, instructions), ...secrets(file, instructions), ...own, ...notices(name, file, instructions, final)];
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
