// Rendering the charts with Helm, and the renders kept as live evidence. `helm` is a tool on the
// machine, never a dependency (ADR 0060): every call takes its arguments as an array.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { repoRoot } from "../repo.ts";
import { chartDir, mergeValues, readDefaults } from "./charts.ts";
import { checkRunnerRender, checkServerRender, parseRender } from "./rendered.ts";
import type { RenderProblem } from "./rendered.ts";
import { runnerValuesSchema, serverValuesSchema } from "./values.ts";
import type { ChartName } from "./values.ts";

const run = promisify(execFile);

/** The release the renders use: `helm template ostra <chart> --namespace ostra`. */
export const RELEASE = { name: "ostra", namespace: "ostra" } as const;

/** Where `pnpm check:helm --keep` keeps each example's render. */
export const keptRenderFile = (chart: ChartName, example: string): string => `context/specs/m5-the-fleet/demo/helm/${chart}/${example}`;

/** A render with the generated keys' values replaced, so it reads the same on every run. */
export const normalizeRender = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/^(\s+)(OSTRA_SECRETS_KEY|BETTER_AUTH_SECRET|OSTRA_RUNNER_TOKEN_KEY): "[^"\n]+"$/gm, '$1$2: "PGdlbmVyYXRlZCBhdCBpbnN0YWxsPg=="');

export type HelmResult = { readonly ok: boolean; readonly output: string };

const helm = async (args: readonly string[]): Promise<HelmResult> => {
  try {
    const { stdout, stderr } = await run("helm", [...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const stdout: unknown = Reflect.get(Object(error), "stdout");
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    return { ok: false, output: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}` };
  }
};

/** Helm's version, or `null` when `helm` isn't on the PATH. */
export const helmVersion = async (): Promise<string | null> => {
  const version = await helm(["version", "--short"]);
  return version.ok ? version.output.trim() : null;
};

export const helmLint = (chart: ChartName, valuesFile: string): Promise<HelmResult> => helm(["lint", chartDir(chart), "--strict", "--values", valuesFile]);

export const helmTemplate = (chart: ChartName, valuesFile: string, kubeVersion: string): Promise<HelmResult> =>
  helm(["template", RELEASE.name, chartDir(chart), "--namespace", RELEASE.namespace, "--kube-version", kubeVersion, "--values", valuesFile]);

const fullname = (chart: ChartName): string => (RELEASE.name.includes(chart) ? RELEASE.name : `${RELEASE.name}-${chart}`);

/** Runs the rendered checks of a chart's render against the example's values merged over the chart's. */
export const checkRender = async (chart: ChartName, render: string, exampleValues: unknown): Promise<readonly RenderProblem[]> => {
  const merged = mergeValues((await readDefaults(chart)).values, exampleValues);
  const manifests = parseRender(render);
  switch (chart) {
    case "ostra-server": {
      const values = serverValuesSchema.parse(merged);
      return checkServerRender(manifests, values, values.secrets.existingSecret === "" ? `${fullname(chart)}-keys` : values.secrets.existingSecret);
    }
    case "ostra-runner":
      return checkRunnerRender(manifests, runnerValuesSchema.parse(merged), { namespace: RELEASE.namespace, serviceAccount: fullname(chart) });
    default:
      return chart satisfies never;
  }
};
