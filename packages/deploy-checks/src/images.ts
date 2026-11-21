// The three images (ADR 0046) and how `pnpm images:build` builds them: one `docker build` each,
// from the repo's root, tagged with the release's namespace and version, the reference the release
// pushes and the compose file and charts name. Arguments are arrays, never a shell line.

export const imageNames = ["server", "runner", "base"] as const;
export type ImageName = (typeof imageNames)[number];

export type ImageBuild = {
  readonly name: ImageName;
  readonly dockerfile: string;
  readonly tag: string;
  /** `docker`'s arguments, the context last. */
  readonly args: readonly string[];
};

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const PATH_PART = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";

/** An image namespace: a registry host, with a port if it needs one, and a path, lowercase (`ghcr.io/owner`, `localhost:5000/ostra`, `ostra`). */
export const IMAGE_NAMESPACE = new RegExp(`^${PATH_PART}(?::\\d+)?(?:/${PATH_PART})*$`);

/**
 * The image's tag at a release: `<namespace>/<name>:<version>`, the namespace the root
 * package.json's `imageNamespace` (`ostra` in a clone, the registry's at a release).
 */
export const imageTag = (name: ImageName, version: string, namespace: string): string => `${namespace}/${name}:${version}`;

export const dockerfileOf = (name: ImageName): string => `deploy/Dockerfile.${name}`;

/** The builds, in the order `pnpm images:build` runs them. */
export const buildPlan = (version: string, namespace: string): readonly ImageBuild[] => {
  if (!RELEASE.test(version)) {
    throw new Error("the release version isn't a version");
  }
  if (!IMAGE_NAMESPACE.test(namespace)) {
    throw new Error("the image namespace isn't one");
  }
  return imageNames.map((name) => ({
    name,
    dockerfile: dockerfileOf(name),
    tag: imageTag(name, version, namespace),
    args: ["build", "--file", dockerfileOf(name), "--tag", imageTag(name, version, namespace), "--label", `org.opencontainers.image.version=${version}`, "."],
  }));
};

/** What an image's build installs, which its THIRD_PARTY_NOTICES list (F-039, ADR 0046). */
export type ImageBundle = {
  /** The workspace packages `turbo prune` keeps for the image, with their dependencies. */
  readonly workspaces: readonly string[];
  /** Whether the install takes production dependencies only (`pnpm install --prod`). */
  readonly prod: boolean;
  /** Whether OpenCode's npm packages stay in the pnpm install. The runner removes them: in a box, the agent runs in the base image. */
  readonly agent: boolean;
};

/**
 * Each image's pnpm install. The server builds the panel in its image, so it installs everything.
 * The base image installs OpenCode with npm in a stage of its own, which its notices read apart.
 */
export const imageBundles: Readonly<Record<ImageName, ImageBundle>> = {
  server: { workspaces: ["@ostra/core", "@ostra/web"], prod: false, agent: true },
  runner: { workspaces: ["@ostra/runner"], prod: true, agent: false },
  base: { workspaces: ["@ostra/adapter-executor-docker"], prod: true, agent: false },
};
