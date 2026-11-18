import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CRITERIA, INPUTS } from "./criteria.ts";
import { missingForCriterion, presentInputs } from "./env.ts";

// Reports which inputs are present. It prints names and yes/no, never a value.
const main = async (): Promise<void> => {
  const present = presentInputs(process.env);
  console.log("Inputs for spike 5 (linear-agent-mode). Values are never printed.\n");
  for (const spec of INPUTS) {
    const flag = present[spec.name] ? "present" : spec.optional ? "missing (optional)" : "missing";
    console.log(`  ${spec.name.padEnd(24)} ${flag.padEnd(20)} from ${spec.file}`);
    console.log(`  ${"".padEnd(24)} ${spec.purpose}`);
  }

  console.log("\nFiles in ~/.config/ostra-dev (existence only; load them into the shell first):");
  const dir = join(homedir(), ".config", "ostra-dev");
  for (const file of ["linear.env", "tunnel.env"]) {
    const exists = await access(join(dir, file)).then(
      () => true,
      () => false,
    );
    console.log(`  ${file.padEnd(12)} ${exists ? "found" : "not found"}`);
  }

  console.log("\nWhat each pass-bar bullet can run here:");
  for (const criterion of CRITERIA) {
    const missing = missingForCriterion(process.env, criterion.id);
    const real = criterion.realInputs.length === 0 ? "local only" : missing.length === 0 ? "real run possible (needs " + criterion.realNeeds + ")" : `real run blocked, missing ${missing.join(", ")}`;
    console.log(`  ${String(criterion.n)}. ${criterion.id.padEnd(15)} ${real}`);
  }

  console.log("\nNot needed by this spike: OSTRA_DEV_MODEL_* (no model is called; no runner is involved).");
};

await main();
