// Rendering the charts with Helm, and the renders kept as live evidence. `helm` is a tool on the
// machine, never a dependency (ADR 0060): every call takes its arguments as an array.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readRepoFile, repoRoot } from "../repo.ts";
import { chartDir, mergeValues, readDefaults } from "./charts.ts";
import type { ValuesFile } from "./charts.ts";
import { checkRunnerRender, checkServerRender, parseRender } from "./rendered.ts";
import type { RenderProblem } from "./rendered.ts";
import { runnerValuesSchema, serverValuesSchema } from "./values.ts";
import type { ChartName } from "./values.ts";

const run = promisify(execFile);

/** The release the renders use: `helm template ostra <chart> --namespace ostra`. */
export const RELEASE = { name: "ostra", namespace: "ostra" } as const;

/** Where `pnpm check:helm --keep` keeps each example's render. */
export const keptRenderFile = (chart: ChartName, example: string): string => `context/specs/m5-the-fleet/demo/helm/${chart}/${example}`;

/**
 * A render with the generated keys' values replaced, so it reads the same on every run, and the
 * same from Helm 3 and Helm 4: Helm 4 leaves a blank line before each `---` between the documents
 * of one template file, where Helm 3 leaves none (Helm 3.22.1 on GitHub's Ubuntu image failed every
 * render kept with 4.3.2: the Release dry run 44962714535). A blank line there means nothing in YAML.
 */
export const normalizeRender = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\n\s*\n(?=---$)/gm, "\n")
    .replace(/^(\s+)(OSTRA_SECRETS_KEY|BETTER_AUTH_SECRET|OSTRA_RUNNER_TOKEN_KEY): "[^"\n]+"$/gm, '$1$2: "PGdlbmVyYXRlZCBhdCBpbnN0YWxsPg=="');

/** The release the kept renders are made at: a clone's, version 0.0.0 with its images under `ostra`. */
export const KEPT_RELEASE = { version: "0.0.0", namespace: "ostra" } as const;

const literally = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A render of a stamped tree (release.yml's, after `node scripts/version.ts`) as it reads at the
 * kept renders' release: the chart's version labels and the images' references, the only places
 * the stamp reaches, are put back to `KEPT_RELEASE`, so the comparison still catches any other
 * change. A clone's render is unchanged.
 */
export const atKeptRelease = (render: string, release: { readonly version: string; readonly namespace: string }): string => {
  const version = `${literally(release.version)}(?![0-9A-Za-z.-])`;
  return render
    .replaceAll(new RegExp(`^(\\s+app\\.kubernetes\\.io/version: )"${version}"$`, "gm"), `$1"${KEPT_RELEASE.version}"`)
    .replaceAll(new RegExp(`^(\\s+helm\\.sh/chart: ostra-(?:server|runner)-)${version}$`, "gm"), `$1${KEPT_RELEASE.version}`)
    .replaceAll(new RegExp(`(?<![\\w./:-])${literally(release.namespace)}/(server|runner|base):${version}`, "g"), `${KEPT_RELEASE.namespace}/$1:${KEPT_RELEASE.version}`);
};

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

/** A line of `pnpm check:helm`'s Helm part, and whether it's a failure. */
export type HelmCheck = { readonly ok: boolean; readonly line: string };

/**
 * Helm's checks of one example, as `pnpm check:helm` runs them and `rendered.test.ts` in `pnpm test`
 * (where `helm` is on the PATH): `helm lint --strict`, `helm template` and the rendered checks, the
 * render compared with its kept one at the kept renders' release (left out with `keep`, which
 * writes it), and the chart refused on Kubernetes 1.28. `render` is the render as it's kept, or
 * `null` when Helm couldn't render the example.
 */
export const helmChecks = async (
  chart: ChartName,
  example: ValuesFile,
  options: { readonly release: { readonly version: string; readonly namespace: string }; readonly keep: boolean },
): Promise<{ readonly checks: readonly HelmCheck[]; readonly render: string | null }> => {
  const name = example.file.split("/").at(-1) ?? example.file;
  const checks: HelmCheck[] = [];
  const lint = await helmLint(chart, example.file);
  checks.push({ ok: lint.ok, line: `${lint.ok ? "pass" : "FAIL"} helm lint --strict ${chart} -f ${name}${lint.ok ? "" : `\n${lint.output.trim()}`}` });
  const render = await helmTemplate(chart, example.file, "1.29.0");
  if (!render.ok) {
    checks.push({ ok: false, line: `FAIL helm template ${chart} -f ${name}\n${render.output.trim()}` });
    return { checks, render: null };
  }
  const problems = await checkRender(chart, render.output, example.values);
  checks.push(...problems.map((problem) => ({ ok: false, line: `FAIL ${chart} -f ${name}: ${problem.rule}: ${problem.message}` })));
  checks.push({ ok: problems.length === 0, line: `${problems.length === 0 ? "pass" : "FAIL"} helm template ${chart} -f ${name}: the rendered checks` });
  // A stamped tree (release.yml's) renders its release's version and images: compared at the kept renders' release.
  const kept = atKeptRelease(normalizeRender(render.output), options.release);
  if (!options.keep) {
    const file = keptRenderFile(chart, name);
    const previous = await readRepoFile(file).catch(() => "");
    if (previous.replace(/\r\n/g, "\n") !== kept) {
      checks.push({ ok: false, line: `FAIL ${file} isn't this render: run pnpm check:helm --keep` });
    }
  }
  const old = await helmTemplate(chart, example.file, "1.28.0");
  const refused = !old.ok && old.output.includes("kubeVersion");
  checks.push({ ok: refused, line: `${refused ? "pass" : "FAIL"} helm template ${chart} -f ${name} --kube-version 1.28.0 is refused: native sidecars need 1.29` });
  return { checks, render: kept };
};
