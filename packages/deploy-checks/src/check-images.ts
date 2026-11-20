// `pnpm check:images`: the three images' and the compose file's static checks, anywhere, with no
// Docker (ADR 0046), and each image's THIRD_PARTY_NOTICES made from this checkout's install, which
// fail on a license the license check doesn't know or a bundled package they miss (milestone 7's
// ticket 29). Prints each problem with its file and line, and exits 1 when there is one.
import { checkoutNotices } from "./checkout-notices.ts";
import { readDeployFiles } from "./deploy-files.ts";
import { checkImages } from "./image-checks.ts";
import { imageNames } from "./images.ts";

const notices = await Promise.all(imageNames.map((name) => checkoutNotices(name)));
const problems = [...checkImages(await readDeployFiles()), ...notices.flatMap((image) => image.problems)];
for (const problem of problems) {
  process.stderr.write(`${problem.file}${problem.line === null ? "" : `:${String(problem.line)}`}: ${problem.rule}: ${problem.message}\n`);
}
const counts = notices.map((image) => `${image.image} ${String(image.bundled.length)}`).join(", ");
process.stdout.write(
  problems.length === 0
    ? `check:images: the three images and the compose file pass; their notices list every package they bundle (${counts}), each under a known license\n`
    : `check:images: ${String(problems.length)} problem(s)\n`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
