import { minorWindow } from "@ostra/protocol";

// A runner's version against its server's (F-061, ADR 0022, ADR 0034). The protocol's window is
// one minor either way (`minorWindow` in `@ostra/protocol`): a runner inside it works, and the
// panel says whether it's behind or ahead; one outside it is refused at `hello`.

/** Where a runner's version stands against the server's. */
export type RunnerVersionState = "current" | "behind" | "ahead" | "outside";

/** A version as the state reads it: the protocol minor it speaks, and its release. */
export type VersionFacts = {
  readonly minor: number;
  /** The release, such as `0.5.0`; `null` when it isn't known. */
  readonly version: string | null;
};

/** The numeric parts of a `major.minor.patch` release, or `null` for anything else. */
const releaseParts = (version: string | null): readonly [number, number, number] | null => {
  const match = version === null ? null : /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Compares two releases: negative when `a` is older, positive when newer, 0 when equal or unknown. */
const compareReleases = (a: string | null, b: string | null): number => {
  const left = releaseParts(a);
  const right = releaseParts(b);
  if (left === null || right === null) {
    return 0;
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * A runner's version state (F-061): `outside` when its minor is outside the server's window,
 * else `behind` or `ahead` by its minor, and at the same minor by its release; `current` when
 * both match, or the releases can't be compared.
 */
export const runnerVersionState = (server: VersionFacts, runner: VersionFacts): RunnerVersionState => {
  const window = minorWindow(server.minor);
  if (!Number.isInteger(runner.minor) || runner.minor < window.min || runner.minor > window.max) {
    return "outside";
  }
  if (runner.minor < server.minor) {
    return "behind";
  }
  if (runner.minor > server.minor) {
    return "ahead";
  }
  const release = compareReleases(runner.version, server.version);
  return release < 0 ? "behind" : release > 0 ? "ahead" : "current";
};
