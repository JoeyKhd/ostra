import { serveFakeAgent } from "./agent.ts";
import type { FakeAgentProfile } from "./agent.ts";

// The fake ACP agent as a program: `node main.ts --profile=rich|plain`, speaking ACP on its
// stdio. The adapter under test starts it as it would start OpenCode.

const profileArg = process.argv.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length);
const profile: FakeAgentProfile = profileArg === "plain" ? "plain" : "rich";

await serveFakeAgent(process.stdin, process.stdout, {
  profile,
  env: process.env,
  crash: () => {
    process.exit(3);
  },
});
