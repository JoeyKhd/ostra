// `pnpm check:helm` (ADR 0060, F-118). Always: the checks that need no Helm (`schema-checks.ts`).
// Where `helm` is on the PATH: `helm lint --strict` and `helm template` of both charts with every
// file in their `examples/` (one holds only the required values), the rendered manifests checked
// (`rendered.ts`), each render compared with the one kept in context/specs/m5-the-fleet/demo/helm/
// (a release's stamped tree at the kept renders' release, `atKeptRelease`), and the charts refused
// on Kubernetes 1.28 and accepted on 1.29. Where it isn't, it says the render didn't run.
//
//   pnpm check:helm                    check
//   pnpm check:helm --write-schemas    write each chart's values.schema.json from values.ts first
//   pnpm check:helm --keep             write the renders it compares with (after a chart changes)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { readExamples, generatedSchema, schemaFile } from "./helm/charts.ts";
import { atKeptRelease, helmLint, helmTemplate, helmVersion, keptRenderFile, normalizeRender, checkRender } from "./helm/renders.ts";
import { checkChartsWithoutHelm } from "./helm/schema-checks.ts";
import { chartNames } from "./helm/values.ts";
import { imageNamespace, readRepoFile, releaseVersion, repoRoot } from "./repo.ts";

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const writeRepoFile = async (file: string, text: string): Promise<void> => {
  const full = path.join(repoRoot, ...file.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, text, "utf8");
};

const main = async (): Promise<number> => {
  let failures = 0;
  if (process.argv.includes("--write-schemas")) {
    for (const chart of chartNames) {
      await writeRepoFile(schemaFile(chart), generatedSchema(chart));
      out(`wrote ${schemaFile(chart)}`);
    }
  }
  const schemaProblems = await checkChartsWithoutHelm();
  for (const problem of schemaProblems) {
    out(`FAIL ${problem.chart}: ${problem.rule}: ${problem.message}`);
  }
  failures += schemaProblems.length;
  out(`schema check: values.schema.json, values.yaml, ${String(chartNames.length)} charts' examples, the configuration reference: ${schemaProblems.length === 0 ? "pass" : `${String(schemaProblems.length)} problem(s)`}`);

  const version = await helmVersion();
  if (version === null) {
    out("helm isn't on the PATH: the render didn't run (helm lint, helm template and the rendered checks). Only the schema check ran.");
    return failures === 0 ? 0 : 1;
  }
  out(`helm ${version}`);
  const keep = process.argv.includes("--keep");
  const release = { version: await releaseVersion(), namespace: await imageNamespace() };
  for (const chart of chartNames) {
    for (const example of await readExamples(chart)) {
      const name = example.file.split("/").at(-1) ?? example.file;
      const lint = await helmLint(chart, example.file);
      out(`${lint.ok ? "pass" : "FAIL"} helm lint --strict ${chart} -f ${name}`);
      if (!lint.ok) {
        out(lint.output.trim());
        failures += 1;
      }
      const render = await helmTemplate(chart, example.file, "1.29.0");
      if (!render.ok) {
        out(`FAIL helm template ${chart} -f ${name}\n${render.output.trim()}`);
        failures += 1;
        continue;
      }
      const problems = await checkRender(chart, render.output, example.values);
      for (const problem of problems) {
        out(`FAIL ${chart} -f ${name}: ${problem.rule}: ${problem.message}`);
      }
      failures += problems.length;
      out(`${problems.length === 0 ? "pass" : "FAIL"} helm template ${chart} -f ${name}: the rendered checks`);
      // A stamped tree (release.yml's) renders its release's version and images: compared at the kept renders' release.
      const normalized = atKeptRelease(normalizeRender(render.output), release);
      const kept = keptRenderFile(chart, name);
      if (keep) {
        await writeRepoFile(kept, normalized);
        out(`kept ${kept}`);
      } else {
        const previous = await readRepoFile(kept).catch(() => "");
        if (previous.replace(/\r\n/g, "\n") !== normalized) {
          out(`FAIL ${kept} isn't this render: run pnpm check:helm --keep`);
          failures += 1;
        }
      }
      const old = await helmTemplate(chart, example.file, "1.28.0");
      const refused = !old.ok && old.output.includes("kubeVersion");
      out(`${refused ? "pass" : "FAIL"} helm template ${chart} -f ${name} --kube-version 1.28.0 is refused: native sidecars need 1.29`);
      failures += refused ? 0 : 1;
    }
  }
  out(failures === 0 ? "check:helm: pass" : `check:helm: ${String(failures)} failure(s)`);
  return failures === 0 ? 0 : 1;
};

process.exitCode = await main();
