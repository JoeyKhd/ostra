import { describeInputs } from "./env.ts";

// Prints which inputs are present. Never prints a value.
const statuses = describeInputs(process.env);

console.log("auth-foundation: inputs (values are never printed)");
for (const status of statuses) {
  const mark = status.present ? "present" : "absent ";
  const note = status.present ? "" : `  -> ${status.whenMissing}`;
  console.log(`  ${mark}  ${status.name}${note}`);
}
console.log("");
console.log("Not needed by this spike: a model endpoint (OSTRA_DEV_MODEL_*), LINEAR_*, GITHUB_*, a mail server.");
console.log("Every pass-bar criterion can run with none of the inputs above.");
