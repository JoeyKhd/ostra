// The licensor and copyright holder (ADR 0048; Q110's answer is the line as it is on 2026-11-19),
// in one place: the root LICENSE, NOTICE and every published package's `author` say it, and
// `pnpm check:release` fails when any differs (`scripts/release.ts`). A company that later becomes
// the licensor is one edit here, then `node scripts/release.ts --write-licensor` and the two lines of
// LICENSE and NOTICE. No dependency, so the CLI's pack (`apps/runner`) imports it too.

export const LICENSOR = "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra";

/** The year the root LICENSE and NOTICE put before the licensor. */
export const COPYRIGHT_YEAR = "2026";

/** The repository every published package names. */
export const REPOSITORY_URL = "git+https://github.com/JoeyKhd/ostra.git";
