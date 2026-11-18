// `pnpm spike --real=docker|k8s`: the box for real. It needs a host with
// Docker and the two images built, or a cluster with the manifests applied;
// none of that exists on the machine this was written on, so this mode has
// been typechecked but not yet run. Every criterion it can't reach stays
// SKIPPED with the input it needs.
//
// Per target:
//   1. box A: generate the nonces and a Zod-validated handoff, start the box
//      (`docker compose -p ostra-<id> up -d`, or `kubectl apply` of the pod
//      filled in here), deliver the handoff (TCP on Docker, `kubectl exec` to
//      the sidecar's Unix socket on Kubernetes), and time "up" to phase=ready
//   2. box B, a second box, as the "another box" target of A's checklist
//   3. the shared lifecycle (box-run.ts) on A: the checklist through the
//      bridge AND as a shell in the agent's container (`docker exec -u
//      1000:1000` / `kubectl exec ... setpriv`), the turns, the 20-minute turn
//      when --long>=1200, the process tree and the stop, counted in the
//      agent's container
//   4. Docker: N boxes at once (--boxes, default 50), each timed to ready,
//      the sidecars' RSS sampled while every box holds a live task
//   5. Docker: a snapshot built with rootless BuildKit from a generated
//      Dockerfile, every layer scanned for the setup secret's canary, and a
//      negative control that bakes the canary and must be caught
//   6. teardown (`docker compose down -v`, `kubectl delete`), always
//
// Secrets (the nonces, the control token, the stub keys) are made here, per
// box, and go to the tools on stdin or in their env, never in argv.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checklistReportSchema, type AttackConfigInput, type ChecklistReport } from "../attack/checklist.ts";
import { boxId as toBoxId, type BoxId } from "../bridge/protocol.ts";
import { PS_ARGS, parsePsOutput, type ProcessInfo } from "../lib/process-tree.ts";
import { handoffSchema } from "../sidecar/handoff.ts";
import { generateSnapshotDockerfile } from "../snapshot/dockerfile.ts";
import { scanOciTarball } from "../snapshot/image-scan.ts";
import { BAR_IDS, driveBox, emptyBar, waitForStatus, type BarId, type BoxKind, type ControlClient, type ControlReply, type Recorded } from "./box-run.ts";
import { buildctlAvailable, clusterAvailable, dockerAvailable, dockerHasRuntime, dockerImagesPresent, runCommand, type CommandResult } from "./commands.ts";
import { check, fail, skip, type Check } from "./report.ts";
import { DEPLOY_DIR } from "./validate-files.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_DIR = path.resolve(here, "..", "..");
const COMPOSE_FILE = path.join(DEPLOY_DIR, "docker", "compose.box.yaml");
const POD_FILE = path.join(DEPLOY_DIR, "k8s", "box-pod.yaml");
const BUILD_SCRIPT = path.join(DEPLOY_DIR, "snapshot", "build-rootless.sh");
const NAMESPACE = "ostra-boxes";
const IMAGES = ["ostra/base:spike3", "ostra/runner:spike3"] as const;

/** The bar's working values. */
export const READY_LIMIT_MS: Readonly<Record<RealTarget, number>> = { docker: 10_000, kubernetes: 60_000 };
export const SIDECAR_LIMIT_MB = 100;

export type RealTarget = "docker" | "kubernetes";

export type RealOptions = {
  readonly longSeconds: number;
  /** Boxes to start at once on one Docker host; 0 skips that run. */
  readonly boxes: number;
  /** Docker: the agent container's runtime (runc, or runsc for gVisor). */
  readonly dockerRuntime: string;
  /** Kubernetes: the RuntimeClass ("" for the node's default, gvisor). */
  readonly runtimeClass: string;
  readonly snapshot: boolean;
};

export type RealRun = {
  readonly target: RealTarget;
  /** The agent container's runtime in this run. */
  readonly runtime: string;
  readonly gvisor: boolean;
  readonly byBar: Readonly<Record<BarId, readonly Check[]>>;
  readonly recorded: Readonly<Recorded>;
  /** Set when the run could not start: the input it needs. */
  readonly skippedFor?: string;
};

type BoxSecrets = {
  readonly boxId: BoxId;
  readonly handoffNonce: string;
  readonly bridgeNonce: string;
  readonly controlToken: string;
  readonly modelMarker: string;
  readonly gitMarker: string;
  readonly pgPassword: string;
  /** The handoff, one JSON line, validated. */
  readonly handoffLine: string;
};

type RealBox = {
  readonly secrets: BoxSecrets;
  readonly upAt: number;
  readonly control: ControlClient;
  readonly attackConfig: AttackConfigInput;
  readonly listAgentProcesses: () => Promise<ProcessInfo[]>;
  readonly execAttack: (config: AttackConfigInput) => Promise<{ readonly exitCode: number | null; readonly report: ChecklistReport }>;
  /** An address of this box another box would try to reach. */
  readonly peerAddress: () => Promise<string>;
  readonly sidecarRssMb: () => Promise<number | undefined>;
  readonly down: () => Promise<void>;
};

const token = (bytes: number): string => randomBytes(bytes).toString("base64url");

const newBoxSecrets = (): BoxSecrets => {
  const boxId = toBoxId(`box-${randomBytes(4).toString("hex")}`);
  const handoffNonce = token(32);
  const bridgeNonce = token(32);
  const controlToken = token(32);
  const modelMarker = `OSTRA-MODEL-SECRET-${randomBytes(6).toString("hex")}`;
  const gitMarker = `OSTRA-GIT-SECRET-${randomBytes(6).toString("hex")}`;
  const handoff = handoffSchema.parse({
    version: 1,
    nonce: handoffNonce,
    taskId: `t-${randomBytes(4).toString("hex")}`,
    bridgeNonce,
    controlToken,
    // The lifecycle needs the stub's scripted steps (approval, long, tree).
    model: { kind: "stub", apiKey: `${modelMarker}-${token(12)}`, format: "openai" },
    git: { upstream: "stub", token: `${gitMarker}-${token(12)}`, repo: "ostra-test/box-fixture", taskBranch: "ostra/t-fixture" },
  });
  return { boxId, handoffNonce, bridgeNonce, controlToken, modelMarker, gitMarker, pgPassword: randomBytes(16).toString("hex"), handoffLine: JSON.stringify(handoff) };
};

const firstLine = (text: string): string => (text.split("\n").find((line) => line.trim() !== "") ?? "").slice(0, 200);

const must = (result: CommandResult, what: string): string => {
  if (result.code !== 0) throw new Error(`${what} exited ${String(result.code)}: ${firstLine(result.stderr)}`);
  return result.stdout;
};

const sleep = async (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses a size like "45.2MiB", "45Mi", "512kB" into MB. */
export const parseMegabytes = (text: string): number | undefined => {
  const match = /^([\d.]+)\s*([KMGT]?i?B?)$/i.exec(text.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase().replace(/b$/, "");
  const factor: Readonly<Record<string, number>> = { "": 1 / (1024 * 1024), k: 1 / 1024, ki: 1 / 1024, m: 1, mi: 1, g: 1024, gi: 1024, t: 1024 * 1024, ti: 1024 * 1024 };
  const f = factor[unit];
  return f === undefined || Number.isNaN(value) ? undefined : value * f;
};

const fetchControl = (addr: string, controlToken: string): ControlClient => async (method, pathname, body) => {
  const response = await fetch(`http://${addr}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

/** Sends the handoff to a TCP port, retrying until the sidecar answers {ok:true}. */
const sendHandoffTcp = async (addr: string, line: string, timeoutMs: number): Promise<void> => {
  const [host = "", portText = "0"] = addr.split(":");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await new Promise<string>((resolve) => {
      const socket = connect({ host, port: Number(portText) }, () => {
        socket.write(`${line}\n`);
      });
      let buffer = "";
      socket.setTimeout(5000);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
      });
      socket.once("timeout", () => {
        socket.destroy();
      });
      socket.once("error", () => {
        resolve("");
      });
      socket.once("close", () => {
        resolve(buffer.trim());
      });
    });
    if (z.strictObject({ ok: z.literal(true) }).safeParse(answer === "" ? undefined : JSON.parse(answer)).success) return;
    if (Date.now() > deadline) throw new Error("the sidecar did not accept the handoff");
    await sleep(500);
  }
};

const execReport = (result: CommandResult, what: string): { readonly exitCode: number | null; readonly report: ChecklistReport } => {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (line === "") throw new Error(`${what}: no report (exit ${String(result.code)}): ${firstLine(result.stderr)}`);
  return { exitCode: result.code, report: checklistReportSchema.parse(JSON.parse(line)) };
};

// ---------------------------------------------------------------- Docker

const docker = async (args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: string; readonly timeoutMs?: number } = {}): Promise<CommandResult> =>
  runCommand("docker", args, { timeoutMs: options.timeoutMs ?? 300_000, ...(options.env === undefined ? {} : { env: options.env }), ...(options.input === undefined ? {} : { input: options.input }) });

const subnetBase = (): string => {
  const base = process.env["OSTRA_BOX_SUBNET_BASE"] ?? "10.89";
  if (!/^\d{1,3}\.\d{1,3}$/.test(base)) throw new Error("OSTRA_BOX_SUBNET_BASE must look like 10.89");
  return base;
};

const startDockerBox = async (index: number, options: RealOptions): Promise<RealBox> => {
  const secrets = newBoxSecrets();
  const project = `ostra-${secrets.boxId}`;
  const prefix = `${subnetBase()}.${String(index)}.`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OSTRA_BOX_ID: secrets.boxId,
    OSTRA_BOX_SUBNET: `${prefix}0/24`,
    OSTRA_HANDOFF_NONCE: secrets.handoffNonce,
    OSTRA_BRIDGE_NONCE: secrets.bridgeNonce,
    OSTRA_PGPASSWORD: secrets.pgPassword,
    OSTRA_AGENT_RUNTIME: options.dockerRuntime,
  };
  const compose = (args: readonly string[]): Promise<CommandResult> => docker(["compose", "-p", project, "-f", COMPOSE_FILE, ...args], { env });
  const down = async (): Promise<void> => {
    await compose(["down", "-v", "--timeout", "5"]);
  };
  const upAt = Date.now();
  try {
    must(await compose(["up", "-d", "--no-build", "--pull", "never"]), "docker compose up");
    const portOf = async (port: number): Promise<string> => {
      const addr = must(await compose(["port", "sidecar", String(port)]), "docker compose port").trim();
      if (!/^127\.0\.0\.1:\d{1,5}$/.test(addr)) throw new Error("unexpected published address");
      return addr;
    };
    const containerOf = async (service: string): Promise<string> => {
      const id = must(await compose(["ps", "-q", service]), "docker compose ps").trim();
      if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`no ${service} container`);
      return id;
    };
    const handoffAddr = await portOf(7100);
    const controlAddr = await portOf(7102);
    await sendHandoffTcp(handoffAddr, secrets.handoffLine, 60_000);
    const agent = await containerOf("agent");
    const sidecar = await containerOf("sidecar");
    const running = async (container: string): Promise<boolean> => (await docker(["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() === "true";
    return {
      secrets,
      upAt,
      control: fetchControl(controlAddr, secrets.controlToken),
      attackConfig: {
        modelMarker: secrets.modelMarker,
        gitMarker: secrets.gitMarker,
        controlAddr: "sidecar:7102",
        handoffAddr: "sidecar:7100",
        bridgeAddr: "sidecar:7101",
        privateAddr: process.env["OSTRA_ATTACK_PRIVATE_ADDR"] ?? "192.168.0.1:80",
        dbAddr: "postgres:5432",
        roots: ["/task"],
        skipEgress: false,
      },
      listAgentProcesses: async () => {
        const result = await docker(["exec", "-e", "LC_ALL=C", agent, "ps", ...PS_ARGS]);
        if (result.code === 0) return parsePsOutput(result.stdout);
        // A stopped container has no processes left; anything else is an error.
        if (!(await running(agent))) return [];
        throw new Error(`ps in the agent container exited ${String(result.code)}`);
      },
      execAttack: async (config) => execReport(await docker(["exec", "-i", "-u", "1000:1000", agent, "attack", "--json", "--config-stdin"], { input: JSON.stringify(config) }), "docker exec attack"),
      peerAddress: async () => {
        const ips = must(await docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", sidecar]), "docker inspect").trim().split(/\s+/);
        const ip = ips.find((candidate) => candidate.startsWith(prefix));
        if (ip === undefined) throw new Error("the sidecar has no address on its box network");
        return ip;
      },
      sidecarRssMb: async () => {
        const result = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", sidecar]);
        return result.code === 0 ? parseMegabytes(result.stdout.split("/")[0] ?? "") : undefined;
      },
      down,
    };
  } catch (error) {
    await down();
    throw error;
  }
};

// ---------------------------------------------------------------- Kubernetes

const kubectl = async (args: readonly string[], options: { readonly input?: string; readonly timeoutMs?: number } = {}): Promise<CommandResult> =>
  runCommand("kubectl", args, { timeoutMs: options.timeoutMs ?? 300_000, ...(options.input === undefined ? {} : { input: options.input }) });

/** Fills ${NAME} placeholders; an unknown one is an error. Drops an empty `runtimeClassName:` line. */
export const fillTemplate = (text: string, values: Readonly<Record<string, string>>): string =>
  text
    .replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`no value for \${${name}}`);
      return value;
    })
    .split("\n")
    .filter((line) => !/^\s*runtimeClassName:\s*$/.test(line))
    .join("\n");

const startK8sBox = async (_index: number, options: RealOptions): Promise<RealBox> => {
  const secrets = newBoxSecrets();
  const pod = `ostra-box-${secrets.boxId}`;
  const secretManifest = JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: pod, namespace: NAMESPACE, labels: { "app.kubernetes.io/part-of": "ostra", "ostra.dev/box": secrets.boxId } },
    type: "Opaque",
    stringData: { bridgeNonce: secrets.bridgeNonce, handoffNonce: secrets.handoffNonce, pgPassword: secrets.pgPassword },
  });
  const down = async (): Promise<void> => {
    await kubectl(["delete", "-n", NAMESPACE, "pod", pod, "--wait=false", "--ignore-not-found"]);
    await kubectl(["delete", "-n", NAMESPACE, "secret", pod, "--ignore-not-found"]);
  };
  const exec = (container: string, command: readonly string[], input?: string): Promise<CommandResult> =>
    kubectl(["exec", ...(input === undefined ? [] : ["-i"]), "-n", NAMESPACE, "-c", container, pod, "--", ...command], input === undefined ? {} : { input });
  const upAt = Date.now();
  try {
    must(await kubectl(["apply", "-f", "-"], { input: secretManifest }), "kubectl apply secret");
    const manifest = fillTemplate(await readFile(POD_FILE, "utf8"), { OSTRA_BOX_ID: secrets.boxId, OSTRA_RUNTIME_CLASS: options.runtimeClass });
    must(await kubectl(["apply", "-f", "-"], { input: manifest }), "kubectl apply pod");
    must(await kubectl(["wait", "-n", NAMESPACE, "--for=condition=Ready", `pod/${pod}`, "--timeout=180s"], { timeoutMs: 200_000 }), "kubectl wait");
    const deadline = Date.now() + 60_000;
    for (;;) {
      const result = await exec("sidecar", ["node", "src/sidecar/handoff-client.ts"], secrets.handoffLine);
      if (result.code === 0) break;
      if (Date.now() > deadline) throw new Error("the sidecar did not accept the handoff");
      await sleep(500);
    }
    const replySchema = z.strictObject({ status: z.number().int(), body: z.unknown() });
    const control: ControlClient = async (method, pathname, body): Promise<ControlReply> => {
      const input = JSON.stringify({ token: secrets.controlToken, method, path: pathname, ...(body === undefined ? {} : { body }) });
      const result = await exec("sidecar", ["node", "src/sidecar/control-client.ts"], input);
      const parsed = replySchema.parse(JSON.parse(must(result, "control-client").trim().split("\n").at(-1) ?? ""));
      return { status: parsed.status, body: parsed.body };
    };
    const terminated = async (): Promise<boolean> => {
      const result = await kubectl(["get", "pod", pod, "-n", NAMESPACE, "-o", "jsonpath={.status.containerStatuses[?(@.name==\"agent\")].state.terminated}"]);
      return result.code !== 0 || result.stdout.trim() !== "";
    };
    return {
      secrets,
      upAt,
      control,
      attackConfig: {
        modelMarker: secrets.modelMarker,
        gitMarker: secrets.gitMarker,
        // The handoff and control API are on Unix sockets: nothing listens on these.
        controlAddr: "127.0.0.1:7102",
        handoffAddr: "127.0.0.1:7100",
        bridgeAddr: "127.0.0.1:7101",
        privateAddr: process.env["OSTRA_ATTACK_PRIVATE_ADDR"] ?? "192.168.0.1:80",
        dbAddr: "127.0.0.1:5432",
        // A pod shares loopback with the sidecar and Postgres.
        knownPorts: [7101, 7200, 7201, 5432],
        roots: ["/task"],
        skipEgress: false,
      },
      listAgentProcesses: async () => {
        const result = await exec("agent", ["env", "LC_ALL=C", "ps", ...PS_ARGS]);
        if (result.code === 0) return parsePsOutput(result.stdout);
        if (await terminated()) return [];
        throw new Error(`ps in the agent container exited ${String(result.code)}`);
      },
      execAttack: async (config) => execReport(await exec("agent", ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "attack", "--json", "--config-stdin"], JSON.stringify(config)), "kubectl exec attack"),
      peerAddress: async () => {
        const ip = must(await kubectl(["get", "pod", pod, "-n", NAMESPACE, "-o", "jsonpath={.status.podIP}"]), "kubectl get pod").trim();
        if (!/^[\d.]+$/.test(ip)) throw new Error("the pod has no IPv4 address");
        return ip;
      },
      sidecarRssMb: async () => {
        const result = await kubectl(["top", "pod", pod, "-n", NAMESPACE, "--containers", "--no-headers"]);
        if (result.code !== 0) return undefined;
        const row = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((cols) => cols[1] === "sidecar");
        return row?.[3] === undefined ? undefined : parseMegabytes(row[3]);
      },
      down,
    };
  } catch (error) {
    await down();
    throw error;
  }
};

// ---------------------------------------------------------------- the run

const startBox = (target: RealTarget, index: number, options: RealOptions): Promise<RealBox> => (target === "docker" ? startDockerBox(index, options) : startK8sBox(index, options));

const timeToReady = async (box: RealBox): Promise<number> => {
  await waitForStatus(box.control, (status) => status.phase === "ready", 180_000);
  return Date.now() - box.upAt;
};

const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
};

/** N boxes on one host, each with a live task, then their sidecars' RSS. */
const runMany = async (target: RealTarget, options: RealOptions, bar: Record<BarId, Check[]>, recorded: Recorded): Promise<void> => {
  const n = options.boxes;
  const started: RealBox[] = [];
  const readyMs: number[] = [];
  let failed = 0;
  try {
    for (let first = 0; first < n; first += 10) {
      const wave = Array.from({ length: Math.min(10, n - first) }, (_, offset) => first + offset);
      const results = await Promise.allSettled(
        wave.map(async (j) => {
          const box = await startBox(target, 10 + j, options);
          started.push(box);
          readyMs.push(await timeToReady(box));
        }),
      );
      failed += results.filter((r) => r.status === "rejected").length;
    }
    recorded["manyBoxes"] = n;
    recorded["manyBoxesReady"] = readyMs.length;
    recorded["manyBoxesReadyP50Ms"] = percentile(readyMs, 50);
    recorded["manyBoxesReadyP100Ms"] = percentile(readyMs, 100);
    bar.P3.push(check(`${String(n)} boxes run on one host`, readyMs.length === n && failed === 0, `${String(readyMs.length)} of ${String(n)} reached ready (${String(failed)} failed); ready p50 ${String(percentile(readyMs, 50))} ms, p100 ${String(percentile(readyMs, 100))} ms`));
    // A live task in every box, then the sidecars' memory.
    await Promise.all(
      started.map(async (box) => {
        await box.control("POST", "/config", { approvals: "allow" });
        await box.control("POST", "/turn", { text: "Wait. [[stub:long 120]]" });
      }),
    );
    await sleep(15_000);
    const rss = (await Promise.all(started.map(async (box) => box.sidecarRssMb()))).filter((v): v is number => v !== undefined);
    const max = rss.length === 0 ? null : Math.max(...rss);
    recorded["manyBoxesSidecarRssMaxMb"] = max === null ? null : Math.round(max);
    bar.P3.push(
      max === null || rss.length < started.length
        ? skip(`sidecar < ${String(SIDECAR_LIMIT_MB)} MB with ${String(n)} live tasks`, target === "docker" ? "`docker stats` for every sidecar" : "metrics-server (`kubectl top`)")
        : check(`sidecar < ${String(SIDECAR_LIMIT_MB)} MB with ${String(n)} live tasks`, max < SIDECAR_LIMIT_MB, `max ${String(Math.round(max))} MB over ${String(rss.length)} sidecars (container memory)`),
    );
  } finally {
    await Promise.all(started.map(async (box) => box.down()));
  }
};

/** A snapshot from a generated Dockerfile, its layers scanned, and a negative control. Docker host only. */
const runSnapshot = async (bar: Record<BarId, Check[]>, recorded: Recorded): Promise<void> => {
  const baseImage = process.env["OSTRA_SNAPSHOT_BASE_IMAGE"] ?? "";
  if (baseImage === "") {
    bar.P4.push(skip("a snapshot builds from a generated Dockerfile (Docker, rootless BuildKit)", "OSTRA_SNAPSHOT_BASE_IMAGE: ostra/base pushed where BuildKit can pull it, pinned by digest (…@sha256:…)"));
    return;
  }
  if (!(await buildctlAvailable())) {
    bar.P4.push(skip("a snapshot builds from a generated Dockerfile (Docker, rootless BuildKit)", "buildctl and rootlesskit (rootless BuildKit) on this host"));
    return;
  }
  const work = await mkdtemp(path.join(tmpdir(), "ostra-snapshot-"));
  try {
    const canary = `OSTRA-SETUP-CANARY-${randomBytes(12).toString("hex")}`;
    const canaryFile = path.join(work, "canary.txt");
    await writeFile(canaryFile, canary, { mode: 0o600 });
    const build = async (name: string, dockerfile: string, setup: string): Promise<{ readonly ok: boolean; readonly tarball: string; readonly seconds: number }> => {
      const ctx = path.join(work, name);
      await mkdir(path.join(ctx, "repos", "ostra-test", "app"), { recursive: true });
      await writeFile(path.join(ctx, "Dockerfile"), dockerfile);
      await writeFile(path.join(ctx, "setup.sh"), setup);
      await writeFile(path.join(ctx, "repos", "ostra-test", "app", "README.md"), "snapshot fixture\n");
      const tarball = path.join(work, `${name}.oci.tar`);
      const started = Date.now();
      const result = await runCommand("bash", [BUILD_SCRIPT, ctx, `ostra/snapshot-${name}:spike3`], {
        env: { ...process.env, OSTRA_SETUP_SECRET_CANARY_FILE: canaryFile, OSTRA_SNAPSHOT_OUTPUT: `type=oci,dest=${tarball}` },
        timeoutMs: 1_800_000,
        cwd: SPIKE_DIR,
      });
      return { ok: result.code === 0, tarball, seconds: Math.round((Date.now() - started) / 1000) };
    };
    let generated: string;
    try {
      generated = generateSnapshotDockerfile({ baseImage, repos: [{ name: "ostra-test/app", commit: "0".repeat(40) }], setupScript: "", setupSecrets: [{ id: "canary", mountPath: "/run/secrets/canary" }] });
    } catch {
      bar.P4.push(skip("a snapshot builds from a generated Dockerfile (Docker, rootless BuildKit)", "OSTRA_SNAPSHOT_BASE_IMAGE pinned by digest (…@sha256:<64 hex>)"));
      return;
    }
    // The setup script reads the secret and uses it, without writing it anywhere.
    const setup = "set -eu\ntest -s /run/secrets/canary\necho setup-ran > /task/workspace/app/.ostra-setup-done\n";
    const clean = await build("clean", generated, setup);
    recorded["snapshotBuildSeconds"] = clean.seconds;
    bar.P4.push(check("a snapshot builds from a generated Dockerfile (Docker, rootless BuildKit)", clean.ok, clean.ok ? `built in ${String(clean.seconds)} s` : "the build failed"));
    if (clean.ok) {
      const scan = await scanOciTarball(clean.tarball, { canary });
      recorded["snapshotBlobsScanned"] = scan.blobs;
      bar.P4.push(check("the setup secret isn't found in any layer", scan.found.length === 0, `${String(scan.blobs)} blobs, ${String(Math.round(scan.bytesScanned / (1024 * 1024)))} MB scanned uncompressed; found ${String(scan.found.length)}`));
    }
    // Negative control: the same canary baked into a layer must be caught.
    const baked = await build("baked", `FROM ${baseImage}\nRUN echo ${canary} > /tmp/ostra-baked-canary\n`, "true\n");
    if (!baked.ok) bar.P4.push(fail("negative control: a baked secret is found by the layer scan", "the negative-control build failed"));
    else {
      const scan = await scanOciTarball(baked.tarball, { canary });
      bar.P4.push(check("negative control: a baked secret is found by the layer scan", scan.found.includes("canary"), `found ${String(scan.found.length)} in ${String(scan.blobs)} blobs`));
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
};

const skippedRun = (target: RealTarget, runtime: string, gvisor: boolean, needs: string): RealRun => ({ target, runtime, gvisor, byBar: emptyBar(), recorded: {}, skippedFor: needs });

/** One target, end to end. Never throws: a failure is a FAIL check. */
export const runRealTarget = async (target: RealTarget, options: RealOptions): Promise<RealRun> => {
  const runtime = target === "docker" ? options.dockerRuntime : options.runtimeClass === "" ? "default" : options.runtimeClass;
  const gvisor = target === "docker" ? options.dockerRuntime.startsWith("runsc") : options.runtimeClass === "gvisor";
  if (target === "docker") {
    if (!(await dockerAvailable())) return skippedRun(target, runtime, gvisor, "Docker (`docker info` fails on this machine)");
    if (!(await dockerImagesPresent(IMAGES))) return skippedRun(target, runtime, gvisor, "the images: `docker build -f deploy/docker/Dockerfile.base -t ostra/base:spike3 .` and `-f deploy/docker/Dockerfile.runner -t ostra/runner:spike3 .`");
    if (gvisor && !(await dockerHasRuntime(options.dockerRuntime))) return skippedRun(target, runtime, gvisor, `the ${options.dockerRuntime} runtime in Docker (deploy/gvisor/daemon.json)`);
  } else if (!(await clusterAvailable())) {
    return skippedRun(target, runtime, gvisor, "a Kubernetes cluster (`kubectl get --raw /readyz` fails), with deploy/k8s/namespace.yaml and the egress policy applied and the images pullable");
  }

  const bar = emptyBar();
  const recorded: Recorded = { runtime };
  const kind: BoxKind = target;
  const boxes: RealBox[] = [];
  try {
    const a = await startBox(target, 0, options);
    boxes.push(a);
    const readyMs = await timeToReady(a);
    recorded["readyMs"] = readyMs;
    bar.P3.push(check(`a box is ready in < ${String(READY_LIMIT_MS[target] / 1000)} s on ${target === "docker" ? "Docker (image present)" : "a warm Kubernetes node"}`, readyMs < READY_LIMIT_MS[target], `${String(readyMs)} ms from up to phase=ready`));

    const b = await startBox(target, 1, options);
    boxes.push(b);
    await timeToReady(b);
    const peer = await b.peerAddress();
    const config: AttackConfigInput = { ...a.attackConfig, otherBoxAddr: `${peer}:7200`, otherBoxGitProxyAddr: `${peer}:7201` };

    const result = await driveBox(
      { kind, control: a.control, attackConfig: config, modelMarker: a.secrets.modelMarker, listAgentProcesses: a.listAgentProcesses, execAttack: a.execAttack, startedAt: a.upAt },
      { longSeconds: options.longSeconds },
    );
    for (const id of BAR_IDS) bar[id].push(...result.byBar[id]);
    Object.assign(recorded, result.recorded);
    const rss = result.recorded["sidecarProcessRssMb"];
    bar.P3.push(typeof rss === "number" ? check(`sidecar < ${String(SIDECAR_LIMIT_MB)} MB (one box, live task)`, rss < SIDECAR_LIMIT_MB, `${String(rss)} MB RSS of the sidecar process`) : skip(`sidecar < ${String(SIDECAR_LIMIT_MB)} MB (one box, live task)`, "the sidecar's status"));
  } catch (error) {
    bar.P2.push(fail(`the ${target} box run`, error instanceof Error ? error.message.slice(0, 300) : "error"));
  } finally {
    await Promise.all(boxes.map(async (box) => box.down()));
  }

  if (target === "docker" && options.boxes > 0) {
    try {
      await runMany(target, options, bar, recorded);
    } catch (error) {
      bar.P3.push(fail(`${String(options.boxes)} boxes run on one host`, error instanceof Error ? error.message.slice(0, 300) : "error"));
    }
  } else if (target === "docker") {
    bar.P3.push(skip("50 boxes run on one host", "--boxes=50"));
  }

  if (target === "docker" && options.snapshot) {
    try {
      await runSnapshot(bar, recorded);
    } catch (error) {
      bar.P4.push(fail("the snapshot build", error instanceof Error ? error.message.slice(0, 300) : "error"));
    }
  } else if (target === "kubernetes") {
    bar.P4.push(skip("a snapshot builds in a rootless BuildKit Job (Kubernetes)", "not built yet: staging the build context into the Job's volume, plus OSTRA_REGISTRY for the push"));
  }
  return { target, runtime, gvisor, byBar: bar, recorded };
};
