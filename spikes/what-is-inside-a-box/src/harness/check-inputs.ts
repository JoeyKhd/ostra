// `pnpm check:inputs`: which inputs are present, and which criteria they
// unlock. Never prints a value: only present / missing.

import { MODEL_ENV_FILE, loadInputs } from "./model-inputs.ts";
import { buildctlAvailable, clusterAvailable, dockerAvailable, dockerHasRuntime, dockerImagesPresent, succeeds } from "./commands.ts";

const mark = (present: boolean): string => (present ? "present" : "missing");
const set = (name: string): boolean => (process.env[name] ?? "") !== "";

const inputs = await loadInputs();
const docker = await dockerAvailable();
const images = docker && (await dockerImagesPresent(["ostra/base:spike3", "ostra/runner:spike3"]));
const runsc = docker && (await dockerHasRuntime("runsc"));
const kubectl = await succeeds("kubectl", ["version", "--client"]);
const cluster = kubectl && (await clusterAvailable());

const lines: [string, string][] = [
  ["Model endpoint (OSTRA_DEV_MODEL_BASE_URL, _API_KEY, _ID) — [endpoint] turn", inputs.model === undefined ? `missing: ${inputs.modelMissing.join(", ")}` : `present (from ${inputs.modelSource})`],
  ["model.env file", `${MODEL_ENV_FILE}: ${inputs.modelSource === "model.env" ? "read" : "not used"}`],
  ["Docker (`docker info`) — --real=docker", mark(docker)],
  ["Images ostra/base:spike3 + ostra/runner:spike3", docker ? mark(images) : "n/a (no Docker)"],
  ["Docker runtime runsc (gVisor) — P5 on Docker", docker ? mark(runsc) : "n/a (no Docker)"],
  ["kubectl", mark(kubectl)],
  ["A cluster (`kubectl get --raw /readyz`) — --real=k8s", kubectl ? mark(cluster) : "n/a (no kubectl)"],
  ["buildctl (rootless BuildKit) — P4 snapshot", mark(await buildctlAvailable())],
  ["OSTRA_SNAPSHOT_BASE_IMAGE (ostra/base by digest, pullable) — P4 snapshot", mark(set("OSTRA_SNAPSHOT_BASE_IMAGE"))],
  ["OSTRA_REGISTRY (for the k8s snapshot Job, not built yet)", mark(set("OSTRA_REGISTRY"))],
  ["Platform", `${process.platform} ${process.arch}`],
  ["LINEAR_*, GITHUB_*, DATABASE_URL", "not used by spike 3 (the git upstream and the database are the box's own)"],
];

const width = Math.max(...lines.map(([name]) => name.length));
for (const [name, value] of lines) console.log(`${name.padEnd(width)}  ${value}`);
