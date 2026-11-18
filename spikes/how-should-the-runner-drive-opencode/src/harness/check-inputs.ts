// `pnpm check:inputs`: which inputs are present. Never prints a value.

import { MODEL_ENV_FILE, loadInputs } from "./inputs.ts";

const inputs = await loadInputs();
const mark = (present: boolean): string => (present ? "present" : "missing");

const lines: [string, string][] = [
  ["Model endpoint (OSTRA_DEV_MODEL_BASE_URL, _API_KEY, _ID)", inputs.model === undefined ? `missing: ${inputs.modelMissing.join(", ")}` : `present (from ${inputs.modelSource})`],
  ["OSTRA_DEV_MODEL_API_FORMAT (optional; detected when unset)", inputs.model?.apiFormat ?? "unset"],
  ["model.env file", `${MODEL_ENV_FILE}: ${inputs.modelSource === "model.env" ? "read" : "not used"}`],
  ["SPIKE_LONG=1 (20-minute turn, 10-minute permission wait)", inputs.long ? "set" : "unset"],
  ["Platform", `${process.platform} ${process.arch} (Linux-in-a-container and macOS runs are separate machines)`],
  ["LINEAR_*, GITHUB_*, DATABASE_URL", `not used by spike 1 (LINEAR_API_KEY ${mark((process.env["LINEAR_API_KEY"] ?? "") !== "")}, DATABASE_URL ${mark((process.env["DATABASE_URL"] ?? "") !== "")})`],
];

const width = Math.max(...lines.map(([name]) => name.length));
for (const [name, value] of lines) console.log(`${name.padEnd(width)}  ${value}`);
