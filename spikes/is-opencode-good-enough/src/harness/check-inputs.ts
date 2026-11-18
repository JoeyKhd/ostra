// `pnpm check:inputs`: which inputs are present. Never prints a value.

import { access } from "node:fs/promises";
import path from "node:path";
import { MODEL_ENV_FILE, loadInputs } from "./inputs.ts";
import { resolveOpenCodeBinary } from "../lib/opencode.ts";
import { exec } from "../runner/exec.ts";
import { cleanWorkRoot, hostToolEnv } from "../runner/sandbox.ts";
import { SAMPLE_REPO, SPIKE_ROOT, TSC_BIN } from "../runner/workspace.ts";

const inputs = await loadInputs();
const mark = (present: boolean): string => (present ? "present" : "missing");
const exists = async (file: string): Promise<boolean> => access(file).then(() => true, () => false);

const git = await exec("git", ["--version"], { cwd: SPIKE_ROOT, timeoutMs: 15_000, env: await hostToolEnv() });
const opencode = await resolveOpenCodeBinary("v2").then(
  (binary) => `present (${binary.packageName}@${binary.packageVersion})`,
  () => "missing: run `pnpm install` in this folder",
);

const lines: [string, string][] = [
  ["Model endpoint (OSTRA_DEV_MODEL_BASE_URL, _API_KEY, _ID)", inputs.model === undefined ? `missing: ${inputs.modelMissing.join(", ")}` : `present (from ${inputs.modelSource})`],
  ["  needed by", "the real runs (`pnpm runs --real --host-run`); the dry-run needs none of it"],
  ["OSTRA_DEV_MODEL_API_FORMAT (optional; detected when unset)", inputs.model?.apiFormat ?? "unset"],
  ["model.env file (OSTRA_DEV_MODEL_ENV_FILE moves it)", `${MODEL_ENV_FILE}: ${inputs.modelSource === "model.env" ? "read" : "not used"}`],
  ["OSTRA_SPIKE_HOST_RUN (or --host-run: the real runs refuse to start without it)", process.env["OSTRA_SPIKE_HOST_RUN"] === "1" ? "set" : "unset"],
  ["Prices (OSTRA_SPIKE_PRICE_INPUT and _OUTPUT; optional)", inputs.pricing === undefined ? "unset: spend is reported in tokens only, B3 stays SKIPPED and --max-usd is refused" : `set (${inputs.priceVarsSet.join(", ")})`],
  ["Model limits (OSTRA_SPIKE_MODEL_CONTEXT, _OUTPUT; optional)", inputs.limitVarsSet.length === 0 ? `unset: ${String(inputs.limits.context)} context, ${String(inputs.limits.output)} output` : `set (${inputs.limitVarsSet.join(", ")})`],
  ["OpenCode binary", opencode],
  ["git", git.code === 0 ? `present (${git.stdout.trim()})` : "missing: runs need git"],
  ["Node", `${process.version} (needs 24 or newer, for type stripping and import.meta.main)`],
  ["TypeScript (for the CI check on a run's result)", mark(await exists(TSC_BIN))],
  ["The sample repo", mark(await exists(path.join(SAMPLE_REPO, "package.json")))],
  ["Platform", `${process.platform} ${process.arch}`],
  ["LINEAR_*, GITHUB_*, DATABASE_URL", "not used by spike 10: the tickets are in this folder, and the pull request is the diff on the task's branch"],
];

const width = Math.max(...lines.map(([name]) => name.length));
for (const [name, value] of lines) console.log(`${name.padEnd(width)}  ${value}`);
await cleanWorkRoot();
