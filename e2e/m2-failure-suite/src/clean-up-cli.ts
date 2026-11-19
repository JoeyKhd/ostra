// `pnpm --filter @ostra/e2e-m2-failures clean-up`: what a run that was interrupted left behind
// (ticket 38). It closes the PRs on test1 that link a task on the suite's panel, deletes their
// branches and hidden refs, archives OST's tickets whose title starts "Failure suite:", and deletes
// the suite's webhook on Linear. Nothing of another stack is touched.

import { demoGitHub } from "@ostra/e2e-m1/github";
import { deleteWebhook, linearTool, listWebhooks } from "@ostra/e2e-m2/linear";

import { archiveSuiteTickets, cleanUpRepo } from "./clean-up.ts";
import { SUITE_WEBHOOK_LABEL } from "./live/world.ts";
import { suiteSettings } from "./settings.ts";

const settings = suiteSettings(process.env, process.argv);
const github = await demoGitHub(settings.m2);
const cleaned = await cleanUpRepo(github, settings.m2.publicUrl);
const tool = linearTool(settings.m2.linearApiKey);
const archived = await archiveSuiteTickets(tool, settings.m2.linearTeamId);
let hooks = 0;
for (const hook of await listWebhooks(tool)) {
  if (hook.label !== SUITE_WEBHOOK_LABEL) continue;
  await deleteWebhook(tool, hook.id);
  hooks += 1;
}
process.stdout.write(`[clean-up] closed ${String(cleaned.closed)} PRs, deleted ${String(cleaned.deleted)} refs, archived ${String(archived)} tickets, deleted ${String(hooks)} webhooks\n`);
