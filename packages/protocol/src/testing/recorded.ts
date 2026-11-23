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
// - Milestone 6 moved the server to minor 5, whose window is minors 4 to 6: the files above stay as
//   they were recorded against a minor-4 server (`negotiated` is that server's answer), and minor 7
//   (synthetic, a `hello` only) is two ahead of a minor-5 server. Minor 6's file is one ahead of it.
// - Milestone 7 moved the server to minor 6 (F-138), whose window is minors 5 to 7: minor 8
//   (synthetic, a `hello` only) is two ahead of it, and minor 4's build is one behind the window.
// - Milestone 8 moved the server to minor 7 (ADR 0068), whose window is minors 6 to 8: minor 9
//   (synthetic, a `hello` only) is two ahead of it, and minor 5's build is one behind the window.
// - Milestone 9 moved the server to minor 8 (ADR 0070), whose window is minors 7 to 9: minor 10
//   (synthetic, a `hello` only) is two ahead of it, and minor 6's build is one behind the window.
// - Milestone 10 moved the server to minor 9 (F-151), whose window is minors 8 to 10: minor 11
//   (synthetic, a `hello` only) is two ahead of it, and minor 7's build is one behind the window.
//   Minor 9's own `hello` is the synthetic one recorded two ahead of minor 7, which now speaks 9.
// - Post-v1 (F-052) moved the server to minor 10, whose window is minors 9 to 11: minor 11
//   (synthetic) is one ahead of it, and minor 8's build is one behind the window.

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
export const recordedMinors = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

/** The server minor the recordings were made against: `negotiated` in each file is that server's answer. */
export const RECORDED_SERVER_MINOR = 4;

/** Reads one recorded build. */
export const readRecordedBuild = async (minor: (typeof recordedMinors)[number]): Promise<RecordedBuild> =>
  recordedBuildSchema.parse(JSON.parse(await readFile(new URL(`./recorded/minor-${String(minor)}.json`, import.meta.url), "utf8")));
