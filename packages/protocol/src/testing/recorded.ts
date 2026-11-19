import { readFile } from "node:fs/promises";

import { z } from "zod";

// The runner protocol's compatibility matrix (F-061, ADR 0034, ADR 0022; milestone 5's ticket 16):
// frames as builds one and two minors apart send and read them, recorded once into
// `./recorded/minor-<n>.json` and never re-recorded, so a change to today's codecs that would break
// an older or a newer runner fails the matrix's tests.
//
// - Minors 3, 4 and 5 are inside a minor-4 server's window. Each file holds that build's `hello`,
//   a `status` it sends after the minor is negotiated, and a `dispatch` as it reads it.
// - Minor 5 is synthetic, as spike 6's was: minor 4 with one more optional field in `hello`
//   (`spoolLimitBytes`), which a minor-4 server ignores; it then speaks minor 4.
// - Minors 2 and 6 are outside the window: a `hello` only, which the server refuses with the fix.

/** One recorded build. The frames are raw JSON, as they went over the wire. */
export const recordedBuildSchema = z.strictObject({
  /** Which build it stands for: milestone 3's, milestone 4's, or a synthetic one. */
  build: z.string().min(1),
  minor: z.number().int().nonnegative(),
  hello: z.unknown(),
  /** The minor it speaks with a minor-4 server; absent for a build that server refuses. */
  negotiated: z.number().int().nonnegative().optional(),
  status: z.unknown().optional(),
  dispatch: z.unknown().optional(),
});
export type RecordedBuild = z.infer<typeof recordedBuildSchema>;

/** The recorded minors, oldest first. */
export const recordedMinors = [2, 3, 4, 5, 6] as const;

/** The server minor the recordings were made against. */
export const RECORDED_SERVER_MINOR = 4;

/** Reads one recorded build. */
export const readRecordedBuild = async (minor: (typeof recordedMinors)[number]): Promise<RecordedBuild> =>
  recordedBuildSchema.parse(JSON.parse(await readFile(new URL(`./recorded/minor-${String(minor)}.json`, import.meta.url), "utf8")));
