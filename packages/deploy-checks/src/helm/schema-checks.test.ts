import { describe, expect, it } from "vitest";

import { readRepoFile } from "../repo.ts";
import { generatedSchema, mergeValues, readDefaults, readExamples, schemaFile } from "./charts.ts";
import { checkChartYaml, checkReference, checkSchemaFile, checkValues } from "./schema-checks.ts";
import { chartNames, requiredPaths, runnerValuesSchema, serverValuesSchema, valuePaths, valuesSchemaOf } from "./values.ts";

// Milestone 5's ticket 23 (F-118): the charts' checks that need no Helm, so they run in CI.

const reference = await readRepoFile("docs/configuration.md");

describe("the charts' values", () => {
  it("F-118/c3: values.yaml and each example parse against the Zod schema, and values.yaml lacks exactly the required values", async () => {
    for (const chart of chartNames) {
      expect(await checkValues(chart), chart).toEqual([]);
      const defaults = await readDefaults(chart);
      const failed = valuesSchemaOf(chart).safeParse(defaults.values);
      expect(failed.success, chart).toBe(false);
      expect([...new Set(failed.error?.issues.map((issue) => issue.path.join(".")))].sort(), chart).toEqual([...requiredPaths[chart]].sort());
      const examples = await readExamples(chart);
      expect(examples.map((example) => example.file.split("/").at(-1)), chart).toContain("required-values.yaml");
      for (const example of examples) {
        expect(valuesSchemaOf(chart).safeParse(mergeValues(defaults.values, example.values)).success, example.file).toBe(true);
      }
    }
  });

  it("F-118/c3: a mistyped key, a missing required value or both database sources at once is refused", async () => {
    const server = (await readDefaults("ostra-server")).values;
    const runner = (await readDefaults("ostra-runner")).values;
    const database = { database: { url: "postgres://ostra@db:5432/ostra" } };
    expect(serverValuesSchema.safeParse(mergeValues(server, database)).success).toBe(true);
    expect(serverValuesSchema.safeParse(mergeValues(server, { ...database, web: { replica: 3 } })).success).toBe(false);
    expect(serverValuesSchema.safeParse(mergeValues(server, { database: { url: "postgres://db/ostra", existingSecret: "db" } })).success).toBe(false);
    const runnerRequired = {
      server: { url: "http://core:8787", egress: { cidr: "10.0.0.5", port: 8787 } },
      joinToken: { existingSecret: "join" },
    };
    expect(runnerValuesSchema.safeParse(mergeValues(runner, runnerRequired)).success).toBe(true);
    expect(runnerValuesSchema.safeParse(mergeValues(runner, { ...runnerRequired, joinToken: {} })).success).toBe(false);
    expect(runnerValuesSchema.safeParse(mergeValues(runner, { ...runnerRequired, server: { url: "http://core:8787", egress: { cidr: "10.0.0.5", namespace: "ostra", port: 1 } } })).success).toBe(false);
  });

  it("F-118/c3: the generated values.schema.json matches the committed one", async () => {
    for (const chart of chartNames) {
      expect(await checkSchemaFile(chart), chart).toEqual([]);
      const committed: unknown = JSON.parse(await readRepoFile(schemaFile(chart)));
      expect(committed, chart).toEqual(JSON.parse(generatedSchema(chart)));
      // Helm reads it as draft-07, and a mistyped key is refused at install.
      expect(Reflect.get(Object(committed), "$schema"), chart).toBe("http://json-schema.org/draft-07/schema#");
      expect(Reflect.get(Object(committed), "additionalProperties"), chart).toBe(false);
    }
  });

  it("F-118/c3: every value is in the configuration reference, with (required) exactly where values.yaml has no default", async () => {
    for (const chart of chartNames) {
      const defaults = (await readDefaults(chart)).values;
      expect(checkReference(chart, reference, defaults), chart).toEqual([]);
      expect(valuePaths(valuesSchemaOf(chart)).length, chart).toBeGreaterThan(15);
    }
    const defaults = (await readDefaults("ostra-runner")).values;
    const dropped = reference.replace(/^\| `runner\.slots` \|.*\n/m, "");
    expect(dropped).not.toBe(reference);
    expect(checkReference("ostra-runner", dropped, defaults).map((problem) => problem.message)).toContain("runner.slots has no line in docs/configuration.md (The Helm charts, ostra-runner)");
    const stray = reference.replace("| `runner.slots` |", "| `runner.slotz` |");
    expect(checkReference("ostra-runner", stray, defaults).map((problem) => problem.rule)).toContain("reference");
    const unmarked = reference.replace("| `server.url` | (required) |", "| `server.url` | `http://localhost:8787` |");
    expect(unmarked).not.toBe(reference);
    expect(checkReference("ostra-runner", unmarked, defaults).map((problem) => problem.message)).toContain("server.url's default must say (required)");
  });

  it("F-118/c3: both charts are versioned with the release and need Kubernetes 1.29, for native sidecars", async () => {
    for (const chart of chartNames) {
      expect(await checkChartYaml(chart), chart).toEqual([]);
    }
  });
});
