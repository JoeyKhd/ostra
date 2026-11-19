// The two charts' files (`deploy/helm/<chart>/`): `values.yaml`, `examples/*.yaml` and the generated
// `values.schema.json`. YAML is read with `@kubernetes/client-node`'s reader (js-yaml), so no YAML
// library is added (ADR 0060).

import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadYaml } from "@kubernetes/client-node";
import { z } from "zod";

import { readRepoFile, repoRoot } from "../repo.ts";
import { valuesSchemaOf } from "./values.ts";
import type { ChartName } from "./values.ts";

export const chartDir = (chart: ChartName): string => `deploy/helm/${chart}`;

/** A YAML file's one document, as untyped data for a schema to check. */
export const readYaml = (text: string): unknown => loadYaml<unknown>(text) ?? {};

export type ValuesFile = { readonly file: string; readonly values: unknown };

/** The chart's `values.yaml`. */
export const readDefaults = async (chart: ChartName): Promise<ValuesFile> => {
  const file = `${chartDir(chart)}/values.yaml`;
  return { file, values: readYaml(await readRepoFile(file)) };
};

/** Every file in the chart's `examples/`, by name. */
export const readExamples = async (chart: ChartName): Promise<readonly ValuesFile[]> => {
  const dir = `${chartDir(chart)}/examples`;
  const names = (await readdir(path.join(repoRoot, ...dir.split("/")))).filter((name) => name.endsWith(".yaml")).sort();
  return Promise.all(names.map(async (name) => ({ file: `${dir}/${name}`, values: readYaml(await readRepoFile(`${dir}/${name}`)) })));
};

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Helm's merge of a user's values over the chart's: maps merge key by key, anything else is replaced. */
export const mergeValues = (defaults: unknown, user: unknown): unknown => {
  if (!isMap(defaults) || !isMap(user)) {
    return user === undefined ? defaults : user;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    out[key] = mergeValues(defaults[key], value);
  }
  return out;
};

/** The chart's `values.schema.json`, generated from its Zod schema, as the committed file must read. */
export const generatedSchema = (chart: ChartName): string => {
  const schema = z.toJSONSchema(valuesSchemaOf(chart), { target: "draft-7" });
  return `${JSON.stringify({ ...schema, title: `${chart} values`, description: "Generated from packages/deploy-checks/src/helm/values.ts by pnpm check:helm --write-schemas. Don't edit it by hand." }, null, 2)}\n`;
};

export const schemaFile = (chart: ChartName): string => `${chartDir(chart)}/values.schema.json`;

/** The chart's `Chart.yaml`, as far as the checks read it. */
export const chartYamlSchema = z.looseObject({
  apiVersion: z.literal("v2"),
  name: z.string(),
  version: z.string(),
  appVersion: z.string(),
  kubeVersion: z.string(),
});

export const readChartYaml = async (chart: ChartName): Promise<z.infer<typeof chartYamlSchema>> =>
  chartYamlSchema.parse(readYaml(await readRepoFile(`${chartDir(chart)}/Chart.yaml`)));
