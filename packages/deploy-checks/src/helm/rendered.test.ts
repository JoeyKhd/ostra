import { describe, expect, it } from "vitest";

import { imageNamespace, readRepoFile, releaseVersion } from "../repo.ts";
import { readExamples } from "./charts.ts";
import { atKeptRelease, checkRender, helmChecks, helmVersion, KEPT_RELEASE, keptRenderFile, normalizeRender } from "./renders.ts";
import { chartNames } from "./values.ts";
import type { ChartName } from "./values.ts";

// Milestone 5's ticket 23 (F-118): the rendered checks, on the renders `pnpm check:helm --keep`
// kept from Helm (context/specs/m5-the-fleet/demo/helm/), so they run in CI with no Helm. Where Helm
// is installed (GitHub's Ubuntu runners have it, so CI's `pnpm test` does), Helm's part of
// `pnpm check:helm` runs here as well, so a chart changed without `--keep` fails before a release.

/** Helm's version, or `null` where `helm` isn't on the PATH. */
const helm = await helmVersion();

const kept = async (chart: ChartName, example: string): Promise<string> => readRepoFile(keptRenderFile(chart, example));

const exampleValues = async (chart: ChartName, name: string): Promise<unknown> => {
  const example = (await readExamples(chart)).find((item) => item.file.endsWith(`/${name}`));
  expect(example, name).toBeDefined();
  return example?.values;
};

const rulesOf = async (chart: ChartName, render: string, example = "required-values.yaml"): Promise<readonly string[]> =>
  (await checkRender(chart, render, await exampleValues(chart, example))).map((problem) => problem.rule);

const changed = (text: string, from: string | RegExp, to: string): string => {
  const out = text.replace(from, to);
  expect(out, String(from)).not.toBe(text);
  return out;
};

const CLUSTER_ROLE = `---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ostra-ostra-runner
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
`;

describe("the kept renders", () => {
  it("F-118/c1: every example's render passes the rendered checks: a namespaced role, one shared secret, the baseline's ranges", async () => {
    for (const chart of chartNames) {
      for (const example of await readExamples(chart)) {
        const name = example.file.split("/").at(-1) ?? "";
        expect(await checkRender(chart, await kept(chart, name), example.values), `${chart} ${name}`).toEqual([]);
      }
    }
  });

  it("F-118/c1: a stamped release's render compares with the kept one: only its version labels and images are put back", async () => {
    const release = { version: "1.0.0-rc.0", namespace: "localhost:5000/ostra" };
    for (const chart of chartNames) {
      for (const example of await readExamples(chart)) {
        const name = example.file.split("/").at(-1) ?? "";
        const text = await kept(chart, name);
        // The render a tree stamped with `release` gives: what the stamp reaches, and nothing else.
        const stamped = text
          .replaceAll(/^(\s+app\.kubernetes\.io\/version: )"0\.0\.0"$/gm, `$1"${release.version}"`)
          .replaceAll(/^(\s+helm\.sh\/chart: ostra-(?:server|runner)-)0\.0\.0$/gm, `$1${release.version}`)
          .replaceAll(/(?<![\w./:-])ostra\/(server|runner|base):0\.0\.0/g, `${release.namespace}/$1:${release.version}`);
        expect(stamped, `${chart} ${name}`).not.toBe(text);
        expect(stamped, `${chart} ${name}`).not.toMatch(/ostra\/(?:server|runner|base):0\.0\.0|ostra-(?:server|runner)-0\.0\.0/);
        expect(atKeptRelease(stamped, release), `${chart} ${name}`).toBe(text);
        expect(atKeptRelease(text, KEPT_RELEASE), `${chart} ${name}`).toBe(text);
      }
    }
    // Anything else the render changes still differs from the kept one, and another release's images too.
    const text = await kept("ostra-runner", "required-values.yaml");
    expect(atKeptRelease(changed(text, "cidr: 0.0.0.0/0", "cidr: 10.0.0.0/0"), release)).not.toBe(text);
    expect(atKeptRelease(changed(text, /ostra\/base:0\.0\.0/, "ghcr.io/other/base:1.0.0-rc.0"), release)).not.toBe(text);
  });
});

describe("the charts as Helm renders them", () => {
  it.skipIf(helm === null)("F-118/c1,c2: where Helm is installed, every example lints, passes the rendered checks, renders as its kept render and is refused on Kubernetes 1.28", async () => {
    const release = { version: await releaseVersion(), namespace: await imageNamespace() };
    for (const chart of chartNames) {
      for (const example of await readExamples(chart)) {
        const { checks } = await helmChecks(chart, example, { release, keep: false });
        expect(checks.filter((check) => !check.ok).map((check) => check.line), `helm ${helm ?? ""}, ${example.file}`).toEqual([]);
      }
    }
  });

  it("F-118/c1,c2: a render reads the same from Helm 3 and Helm 4, which leaves a blank line before each separator in a template file", async () => {
    for (const chart of chartNames) {
      for (const example of await readExamples(chart)) {
        const name = example.file.split("/").at(-1) ?? "";
        const text = (await kept(chart, name)).replace(/\r\n/g, "\n");
        // Helm 4.3.2's form of the same render: a blank line before every separator but the first line's.
        const four = text.replace(/(?<=.)\n---$/gm, "\n\n---");
        expect(four, `${chart} ${name}`).not.toBe(text);
        expect(normalizeRender(four), `${chart} ${name}`).toBe(text);
        expect(normalizeRender(text), `${chart} ${name}`).toBe(text);
      }
    }
    // A blank line anywhere else is still a change.
    const text = await kept("ostra-runner", "required-values.yaml");
    expect(normalizeRender(changed(text, "kind: Namespace\n", "kind: Namespace\n\n"))).not.toBe(text);
  });
});

describe("the runner chart's render", () => {
  it("F-118/c2: a cluster role in the runner chart's render fails the rendered check", async () => {
    const render = await kept("ostra-runner", "required-values.yaml");
    expect(await rulesOf("ostra-runner", `${render}${CLUSTER_ROLE}`)).toContain("cluster-role");
    expect(await rulesOf("ostra-runner", `${render}${CLUSTER_ROLE.replace("kind: ClusterRole", "kind: ClusterRoleBinding")}`)).toContain("cluster-role");
    // A Role outside the box and build namespaces is as wide as the rest of that namespace.
    expect(await rulesOf("ostra-runner", changed(render, /(kind: Role\nmetadata:\n  name: ostra-ostra-runner\n  namespace: )ostra-boxes/, "$1kube-system"))).toContain("role-scope");
  });

  it("F-118/c2: the role holds the executor's rights and no more: network policies are read only, and no wildcard", async () => {
    const render = await kept("ostra-runner", "required-values.yaml");
    expect(await rulesOf("ostra-runner", changed(render, 'resources: ["networkpolicies"]\n    verbs: ["list"]', 'resources: ["networkpolicies"]\n    verbs: ["list", "delete"]'))).toContain("role-rights");
    expect(await rulesOf("ostra-runner", changed(render, 'resources: ["secrets"]\n    verbs: ["create", "get", "list", "patch", "delete"]', 'resources: ["secrets"]\n    verbs: ["*"]'))).toContain("role-rights");
    expect(await rulesOf("ostra-runner", changed(render, 'verbs: ["create", "get", "list", "watch", "delete"]', 'verbs: ["create", "get", "list", "delete"]'))).toContain("role-rights");
  });

  it("F-118/c2: the baseline is egress.ts's policy, ranges and all, and the build namespace has its own", async () => {
    const render = await kept("ostra-runner", "external-server.yaml");
    expect(await rulesOf("ostra-runner", changed(render, "              - 169.254.0.0/16\n", ""), "external-server.yaml")).toContain("baseline-policy");
    expect(await rulesOf("ostra-runner", changed(render, "cidr: 203.0.113.10/32", "cidr: 0.0.0.0/0"), "external-server.yaml")).toContain("baseline-policy");
    expect(await rulesOf("ostra-runner", changed(render, "ostra.dev/role: snapshot-build", "ostra.dev/role: box"), "external-server.yaml")).toContain("build-policy");
  });

  it("F-118/c2: the runner runs as ostra runner --executor kubernetes, with its join token from the admin's secret", async () => {
    const render = await kept("ostra-runner", "required-values.yaml");
    expect(await rulesOf("ostra-runner", changed(render, '"--executor", "kubernetes"', '"--executor", "docker"'))).toContain("runner-deployment");
    expect(await rulesOf("ostra-runner", changed(render, "secretName: ostra-join-token", "secretName: another"))).toContain("join-token");
  });
});

describe("the server chart's render", () => {
  it("F-118/c1: the server's processes share one secret made once, kept on upgrade, with the three keys", async () => {
    const render = await kept("ostra-server", "required-values.yaml");
    expect(await rulesOf("ostra-server", changed(render, "    helm.sh/resource-policy: keep\n", ""))).toContain("shared-secret");
    expect(await rulesOf("ostra-server", changed(render, /(name: OSTRA_RUNNER_TOKEN_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: )ostra-ostra-server-keys/, "$1another"))).toContain("shared-secret");
    const second = `${render}---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: second\ndata:\n  OSTRA_SECRETS_KEY: "eA=="\n`;
    expect(await rulesOf("ostra-server", second)).toContain("shared-secret");
    // With an existing secret the chart makes none.
    expect(await checkRender("ostra-server", await kept("ostra-server", "existing-secrets.yaml"), await exampleValues("ostra-server", "existing-secrets.yaml"))).toEqual([]);
  });

  it("F-091/c4: the server's processes make no bootstrap join token, since each replica's data folder is its own", async () => {
    const render = await kept("ostra-server", "required-values.yaml");
    expect(await rulesOf("ostra-server", render)).toEqual([]);
    expect(await rulesOf("ostra-server", changed(render, /\n\s+- name: OSTRA_BOOTSTRAP_JOIN_TOKEN\n\s+value: "false"/g, ""))).toContain("server-deployments");
  });

  it("F-118/c1: web and core run as their own deployments with their replicas, and the ingress raises the idle timeout", async () => {
    const render = await kept("ostra-server", "ingress.yaml");
    expect(await rulesOf("ostra-server", changed(render, /replicas: 3/, "replicas: 1"), "ingress.yaml")).toContain("server-deployments");
    expect(await rulesOf("ostra-server", changed(render, 'proxy-read-timeout: "3600"', 'proxy-read-timeout: "60"'), "ingress.yaml")).toContain("ingress");
  });
});
