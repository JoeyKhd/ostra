// The charts' checks that need no Helm, so they run everywhere, CI included (ADR 0060, F-118): the
// committed `values.schema.json` is the generated one, `values.yaml` has a default for every value
// but the required ones, every example parses, every value has its line in the configuration
// reference, and each chart is versioned with the release and needs Kubernetes 1.29.

import { readRepoFile, releaseVersion, repoRoot } from "../repo.ts";
import { generatedSchema, mergeValues, readChartYaml, readDefaults, readExamples, schemaFile } from "./charts.ts";
import { referencedValues } from "./reference.ts";
import { chartNames, requiredPaths, valuePaths, valuesSchemaOf } from "./values.ts";
import type { ChartName } from "./values.ts";

export type SchemaRule = "schema-drift" | "defaults" | "example" | "reference" | "chart-version";

export type SchemaProblem = { readonly chart: ChartName; readonly rule: SchemaRule; readonly message: string };

/** The minimum Kubernetes version both charts state: native sidecars (ADR 0029, ADR 0060). */
export const KUBE_VERSION = ">=1.29.0-0";

/** The paths a parse failed at, dotted. */
const failedPaths = (chart: ChartName, values: unknown): readonly string[] => {
  const parsed = valuesSchemaOf(chart).safeParse(values);
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))].sort();
};

export const checkSchemaFile = async (chart: ChartName): Promise<readonly SchemaProblem[]> => {
  let committed: string;
  try {
    committed = await readRepoFile(schemaFile(chart));
  } catch {
    committed = "";
  }
  return committed.replace(/\r\n/g, "\n") === generatedSchema(chart)
    ? []
    : [{ chart, rule: "schema-drift", message: `${schemaFile(chart)} isn't the one values.ts generates: run pnpm check:helm --write-schemas` }];
};

/** `values.yaml` alone fails on exactly the required values; with each example, it passes. */
export const checkValues = async (chart: ChartName): Promise<readonly SchemaProblem[]> => {
  const problems: SchemaProblem[] = [];
  const defaults = await readDefaults(chart);
  const missing = failedPaths(chart, defaults.values);
  const required = [...requiredPaths[chart]].sort();
  if (JSON.stringify(missing) !== JSON.stringify(required)) {
    problems.push({
      chart,
      rule: "defaults",
      message: `values.yaml must default every value but the required ones (${required.join(", ")}); it fails at: ${missing.join(", ") || "nothing"}`,
    });
  }
  const examples = await readExamples(chart);
  if (examples.length === 0) {
    problems.push({ chart, rule: "example", message: "the chart has no examples/" });
  }
  for (const example of examples) {
    const failed = failedPaths(chart, mergeValues(defaults.values, example.values));
    if (failed.length > 0) {
      problems.push({ chart, rule: "example", message: `${example.file} doesn't parse: ${failed.join(", ")}` });
    }
  }
  return problems;
};

/** Whether a dotted path has a value in a values file. */
const hasPath = (values: unknown, path: string): boolean => {
  let current: unknown = values;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return false;
    }
    current = Reflect.get(current, key);
  }
  return true;
};

/** Every value has its line under "The Helm charts" in docs/configuration.md, and no line names a value that isn't. */
export const checkReference = (chart: ChartName, markdown: string, defaults: unknown): readonly SchemaProblem[] => {
  const listed = referencedValues(markdown)[chart] ?? [];
  const paths = valuePaths(valuesSchemaOf(chart));
  const problems: SchemaProblem[] = [];
  for (const path of paths.filter((item) => !listed.some((row) => row.path === item))) {
    problems.push({ chart, rule: "reference", message: `${path} has no line in docs/configuration.md (The Helm charts, ${chart})` });
  }
  for (const row of listed.filter((item) => !paths.includes(item.path))) {
    problems.push({ chart, rule: "reference", message: `docs/configuration.md lists ${row.path}, which ${chart} doesn't have` });
  }
  for (const row of listed) {
    // Required: values.yaml has no default for it.
    const required = !hasPath(defaults, row.path);
    if (required !== row.defaultValue.startsWith("(required")) {
      problems.push({ chart, rule: "reference", message: `${row.path}'s default must ${required ? "" : "not "}say (required)` });
    }
  }
  return problems;
};

/** The chart is versioned with the release, in this repo or another checkout (`root`), in a test. */
export const checkChartYaml = async (chart: ChartName, root: string = repoRoot): Promise<readonly SchemaProblem[]> => {
  const yaml = await readChartYaml(chart, root);
  const version = await releaseVersion(root);
  const problems: SchemaProblem[] = [];
  if (yaml.name !== chart || yaml.version !== version || yaml.appVersion !== version) {
    problems.push({ chart, rule: "chart-version", message: `Chart.yaml's version and appVersion are the release's, ${version}` });
  }
  if (yaml.kubeVersion !== KUBE_VERSION) {
    problems.push({ chart, rule: "chart-version", message: `Chart.yaml's kubeVersion is ${KUBE_VERSION}: native sidecars` });
  }
  return problems;
};

/** Every check that needs no Helm, over both charts. */
export const checkChartsWithoutHelm = async (): Promise<readonly SchemaProblem[]> => {
  const markdown = await readRepoFile("docs/configuration.md");
  const out: SchemaProblem[] = [];
  for (const chart of chartNames) {
    out.push(...(await checkSchemaFile(chart)), ...(await checkValues(chart)), ...checkReference(chart, markdown, (await readDefaults(chart)).values), ...(await checkChartYaml(chart)));
  }
  return out;
};
