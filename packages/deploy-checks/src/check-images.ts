// `pnpm check:images`: the three images' and the compose file's static checks, anywhere, with no
// Docker (ADR 0046). Prints each problem with its file and line, and exits 1 when there is one.
import { readDeployFiles } from "./deploy-files.ts";
import { checkImages } from "./image-checks.ts";

const problems = checkImages(await readDeployFiles());
for (const problem of problems) {
  process.stderr.write(`${problem.file}${problem.line === null ? "" : `:${String(problem.line)}`}: ${problem.rule}: ${problem.message}\n`);
}
process.stdout.write(problems.length === 0 ? "check:images: the three images and the compose file pass\n" : `check:images: ${String(problems.length)} problem(s)\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
