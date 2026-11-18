// The pass bar's own bullets (context/build-order.md, spike 3), each a
// criterion, P1 to P5, plus V1 for the deploy artifacts (not a bar bullet).
//
// Where a check comes from is in its name: [loopback] for the rehearsal on
// this machine, [docker] and [kubernetes] for the real boxes, [endpoint] for
// the real-model turn. A real-box check that didn't run is SKIPPED with the
// exact input it needs. A criterion is PASS only when every check in it
// passed, so the loopback half alone can never make a bullet PASS.

import os from "node:os";
import { check, fail, skip, statusOf, type Check, type Criterion } from "./report.ts";
import type { BarId, BoxRunResult, Recorded } from "./box-run.ts";
import type { RealRun, RealTarget } from "./real-box.ts";
import type { FileFinding, Validation } from "./validate-files.ts";

const fileChecks = (findings: readonly FileFinding[]): Check[] => findings.map((f) => check(f.file, f.ok, f.note));

const tagged = (tag: string, checks: readonly Check[]): Check[] => checks.map((c) => ({ ...c, name: `[${tag}] ${c.name}` }));

export type EndpointSmoke = { readonly checks: readonly Check[] } | { readonly skipped: string } | { readonly error: string };

export type PassBarInput = {
  readonly loopback: BoxRunResult | undefined;
  readonly loopbackError: string | undefined;
  readonly endpoint: EndpointSmoke;
  readonly real: readonly RealRun[];
  readonly files: Validation;
};

const REAL_FLAG: Readonly<Record<RealTarget, string>> = { docker: "--real=docker", kubernetes: "--real=k8s" };
const REAL_NEEDS: Readonly<Record<RealTarget, string>> = {
  docker: "a host with Docker and the images ostra/base:spike3 + ostra/runner:spike3",
  kubernetes: "a Kubernetes cluster with deploy/k8s applied and the images pullable",
};

const pick = (recorded: Readonly<Recorded> | undefined, prefix: string, keys: readonly string[]): Recorded => {
  const out: Recorded = {};
  if (recorded === undefined) return out;
  for (const key of keys) {
    const value = recorded[key];
    if (value !== undefined) out[`${prefix}.${key}`] = value;
  }
  return out;
};

export const buildPassBar = (input: PassBarInput): Criterion[] => {
  const { loopback, loopbackError, files } = input;

  const loopbackPart = (id: BarId): Check[] => {
    if (loopback !== undefined) return tagged("loopback", loopback.byBar[id]);
    return [loopbackError === undefined ? skip("[loopback] the rehearsal", "it was turned off (--no-box)") : fail("[loopback] the rehearsal", loopbackError)];
  };

  const realPart = (id: BarId, target: RealTarget, name: string): Check[] => {
    const run = input.real.find((r) => r.target === target);
    if (run === undefined) return [skip(`[${target}] ${name}`, `${REAL_NEEDS[target]}; then \`pnpm spike ${REAL_FLAG[target]}\``)];
    if (run.skippedFor !== undefined) return [skip(`[${target}] ${name}`, run.skippedFor)];
    const checks = run.byBar[id];
    return checks.length > 0 ? tagged(target, checks) : [skip(`[${target}] ${name}`, "not produced by this run")];
  };

  const endpointChecks = ((): Check[] => {
    const smoke = input.endpoint;
    if ("checks" in smoke) return tagged("endpoint", smoke.checks);
    if ("skipped" in smoke) return [skip("[endpoint] a real turn through the key proxy", smoke.skipped)];
    return [fail("[endpoint] a real turn through the key proxy", smoke.error)];
  })();

  const realRecorded = (keys: readonly string[]): Recorded => {
    const out: Recorded = {};
    for (const run of input.real) Object.assign(out, pick(run.recorded, run.target, keys));
    return out;
  };

  const criteria: Criterion[] = [];

  criteria.push({
    id: "P1",
    title: "From a shell in the agent's container, none of the attacks works (no key/token from env, process list, files or network; no self-approval; no private/metadata/other box or its git proxy; no OpenCode loopback port)",
    checks: [
      ...loopbackPart("P1"),
      ...endpointChecks,
      ...realPart("P1", "docker", "the checklist in the agent's container, egress included"),
      ...realPart("P1", "kubernetes", "the checklist in the agent's container, egress included"),
    ],
  });

  criteria.push({
    id: "P2",
    title: "The bridge carries a 20-minute turn, and stopping a task leaves no process",
    checks: [...loopbackPart("P2"), ...realPart("P2", "docker", "the lifecycle in a real box"), ...realPart("P2", "kubernetes", "the lifecycle in a real box")],
    recorded: {
      ...pick(loopback?.recorded, "loopback", ["sidecarReadyMs", "bridgeTurnSeconds", "treeProcessesBeforeStop", "leftoverAfterStop", "leftoverReportedBySidecar"]),
      ...realRecorded(["bridgeTurnSeconds", "treeProcessesBeforeStop", "leftoverAfterStop", "leftoverReportedBySidecar"]),
    },
  });

  criteria.push({
    id: "P3",
    title: "A box is ready in < 10 s on Docker (image present), < 60 s on a warm k8s node; 50 boxes on one host; sidecar < 100 MB",
    checks: [...realPart("P3", "docker", "ready time, 50 boxes, sidecar RSS"), ...realPart("P3", "kubernetes", "ready time on a warm node")],
    recorded: {
      // The loopback number is the whole harness process (sidecar, driver,
      // stubs and harness together), not the sidecar: recorded, never asserted.
      ...pick(loopback?.recorded, "loopback", ["harnessProcessRssMb"]),
      ...realRecorded(["readyMs", "sidecarProcessRssMb", "manyBoxes", "manyBoxesReady", "manyBoxesReadyP50Ms", "manyBoxesReadyP100Ms", "manyBoxesSidecarRssMaxMb"]),
    },
  });

  criteria.push({
    id: "P4",
    title: "A snapshot builds from a generated Dockerfile on both; a setup secret isn't in any layer; a DB service is reachable from the agent's container",
    checks: [...realPart("P4", "docker", "snapshot build, layer scan, database"), ...realPart("P4", "kubernetes", "snapshot Job, database")],
    recorded: realRecorded(["snapshotBuildSeconds", "snapshotBlobsScanned"]),
  });

  const gvisorRun = (target: RealTarget, flag: string): Check => {
    const run = input.real.find((r) => r.target === target && r.gvisor);
    const name = `[${target}] the same checks pass under gVisor`;
    if (run === undefined) return skip(name, `${flag} on ${target === "docker" ? "a Docker host with runsc (deploy/gvisor/daemon.json)" : "a cluster with a gVisor node (deploy/gvisor/runtimeclass.yaml)"}`);
    if (run.skippedFor !== undefined) return skip(name, run.skippedFor);
    const all = (["P1", "P2", "P3", "P4"] as const).flatMap((id) => run.byBar[id]);
    const status = statusOf(all);
    return status === "PASS" ? check(name, true, `${String(all.length)} checks passed with runtime ${run.runtime}`) : status === "FAIL" ? fail(name, `a check failed under ${run.runtime}`) : skip(name, `some checks were SKIPPED under ${run.runtime}`);
  };
  criteria.push({
    id: "P5",
    title: "The same checks pass with gVisor as the runtime",
    checks: [...fileChecks(files.gvisor), gvisorRun("docker", "`--real=docker --runtime=runsc`"), gvisorRun("kubernetes", "`--real=k8s --runtime-class=gvisor`")],
  });

  // The deploy artifacts and the snapshot generator: read here, run by the
  // real-box mode. Not a bar bullet.
  criteria.push({
    id: "V1",
    title: "The deploy artifacts are valid and have the required shape (read here, not run; not a bar bullet)",
    checks: [...fileChecks(files.yaml), ...fileChecks(files.shape), ...fileChecks(files.dockerfiles), ...fileChecks(files.snapshot)],
  });

  return criteria;
};

export const platformLine = (): string => `${process.platform} ${process.arch}, Node ${process.version}, ${os.release()}`;
