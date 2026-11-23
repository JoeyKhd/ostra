// `pnpm check:binaries`: the runner's native downloads' names, its pinned Bun and `release.yml`'s
// build job (F-085, ticket 01; ADR 0075), anywhere, with no network, no Bun and no certificate.
// Prints each problem with its file and rule, and exits 1 when there is one.
import { releaseFiles } from "@ostra/protocol";

import { binaryProblems } from "./binaries.ts";
import { readRepoFile } from "./repo.ts";

const workflow = await readRepoFile(".github/workflows/release.yml");
const problems = binaryProblems({ releaseFiles }, workflow);
for (const problem of problems) {
  process.stderr.write(`${problem.file}: ${problem.rule}: ${problem.message}\n`);
}
process.stdout.write(problems.length === 0 ? "check:binaries: the pin, the three downloads and their release.yml build hold\n" : `check:binaries: ${String(problems.length)} problem(s)\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
