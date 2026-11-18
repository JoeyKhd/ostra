// `pnpm --filter @ostra/e2e-m1 clean-up`: closes the demo's PRs on the test repo and deletes its
// branches and hidden refs. `--keep <number>` leaves one PR, its branch and its hidden ref open.

import { cleanUp, demoGitHub } from "./github.ts";
import { demoSettings } from "./settings.ts";

const keepIndex = process.argv.indexOf("--keep");
const keepArgument = keepIndex === -1 ? undefined : process.argv[keepIndex + 1];
const keep = new Set(keepArgument === undefined ? [] : [Number(keepArgument)]);
const github = await demoGitHub(demoSettings(process.env));
const result = await cleanUp(github, keep);
process.stdout.write(`closed ${String(result.closed)} PRs, deleted ${String(result.deleted)} refs in ${github.owner}/${github.repo}\n`);
