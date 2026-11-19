import { runBuildStep } from "./build-steps.ts";

// A snapshot build's step in its pod (ticket 08): `ostra internal build-step <step>` runs this with
// the step as its last argument (the runner image's CLI routes it here, ticket 21).
const step = process.argv.at(-1) ?? "";
process.exitCode = await runBuildStep(step);
