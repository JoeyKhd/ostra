// The three images (ADR 0046) and how `pnpm images:build` builds them: one `docker build` each,
// from the repo's root, tagged with the release version. Arguments are arrays, never a shell line.

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

/** The image's tag at a release: `ostra/<name>:<version>`. Nothing is pushed before milestone 7. */
export const imageTag = (name: ImageName, version: string): string => `ostra/${name}:${version}`;

export const dockerfileOf = (name: ImageName): string => `deploy/Dockerfile.${name}`;

/** The builds, in the order `pnpm images:build` runs them. */
export const buildPlan = (version: string): readonly ImageBuild[] => {
  if (!RELEASE.test(version)) {
    throw new Error("the release version isn't a version");
  }
  return imageNames.map((name) => ({
    name,
    dockerfile: dockerfileOf(name),
    tag: imageTag(name, version),
    args: ["build", "--file", dockerfileOf(name), "--tag", imageTag(name, version), "--label", `org.opencontainers.image.version=${version}`, "."],
  }));
};
