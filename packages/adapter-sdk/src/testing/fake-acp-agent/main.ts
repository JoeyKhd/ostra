import { readFile, writeFile } from "node:fs/promises";

import { exportFakeSession, importFakeSession } from "./archive.ts";
import { serveFakeAgent } from "./agent.ts";
import type { FakeAgentProfile } from "./agent.ts";

// The fake ACP agent as a program: `node main.ts --profile=rich|plain`, speaking ACP on its
// stdio. The adapter under test starts it as it would start OpenCode. Milestone 2 adds the two
// commands that move a session to another box, run beside the agent as OpenCode's are:
//   node main.ts export --data=<dir> --session=<id> --out=<file>
//   node main.ts import --data=<dir> --in=<file> --directory=<workspace>
// Sessions are kept in `FAKE_AGENT_DATA` (or `--data`), when it's set.

const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const command = process.argv[2];
const dataDir = flag("data") ?? process.env["FAKE_AGENT_DATA"];

if (command === "export" || command === "import") {
  const required = (name: string): string => {
    const value = name === "data" ? dataDir : flag(name);
    if (value === undefined || value === "") {
      process.stderr.write(`--${name} is required\n`);
      process.exit(2);
    }
    return value;
  };
  if (command === "export") {
    await writeFile(required("out"), await exportFakeSession(required("data"), required("session")));
  } else {
    const id = await importFakeSession(required("data"), await readFile(required("in"), "utf8"), required("directory"));
    process.stdout.write(`${id}\n`);
  }
} else {
  const profileArg = flag("profile");
  const profile: FakeAgentProfile = profileArg === "plain" ? "plain" : "rich";
  await serveFakeAgent(process.stdin, process.stdout, {
    profile,
    env: process.env,
    crash: () => {
      process.exit(3);
    },
    ...(dataDir === undefined || dataDir === "" ? {} : { dataDir }),
  });
}
