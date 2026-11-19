import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { killTree } from "@ostra/adapter-sdk";

import type { FakeContainerSpec, FakePodSpec } from "./kube-schemas.ts";

// The fake Kubernetes API's process mode (ticket 06, spec section 8): each container of a pod runs
// as a local process, with the container's environment, and the pod's secret volumes written as
// files under a folder of the pod's own. A path under a volume's mount, in an argument, an
// environment value or the working folder, is read as the same path under the volume's folder.
// The pod's loopback is this machine's loopback. There's NO isolation and NO limits: a container
// here can read and do anything this account can, and every log line says so. Test and dev only.

/** Starts every log line the process mode writes: it isolates nothing and limits nothing. */
export const PROCESS_MODE_NOTICE = "[fake-kube process mode: no isolation, no limits]";

export type ProcessModeOptions = {
  /** Where each pod gets its folder: `<root>/<namespace>/<pod>-<uid>`. */
  readonly root: string;
  /**
   * A command's first word, mapped to what runs here: `{ ostra: [process.execPath, "<repo>/apps/runner/src/main.ts"] }`
   * runs ostra's runner image's `ostra` as the built ostra, `{ sh: ["bash"] }` the base image's shell as this machine's.
   */
  readonly commands?: Readonly<Record<string, readonly string[]>>;
  /** What a container with no `command` runs, by its image's name without a tag or digest: its image's entrypoint. */
  readonly imageCommands?: Readonly<Record<string, readonly string[]>>;
  readonly log: (line: string) => void;
};

export type ContainerRun = {
  readonly name: string;
  readonly image: string;
  /** An init container: `sidecar` when it's a native sidecar (`restartPolicy: Always`). */
  readonly role: "init" | "sidecar" | "main";
  state: "waiting" | "running" | "exited";
  pid: number | null;
  exitCode: number | null;
  /** Why it never started: its command didn't resolve, or it failed to spawn. */
  reason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type PodProcessesInput = {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly spec: FakePodSpec;
  /** A secret's data, decoded, by name; `undefined` when there's none. */
  readonly secret: (name: string) => Readonly<Record<string, Buffer>> | undefined;
  /** Called after every change of a container's state. */
  readonly onChange: () => void;
};

export type PodProcesses = {
  /** The pod's own folder: its volumes are under `volumes/<name>`. */
  readonly dir: string;
  readonly containers: () => readonly ContainerRun[];
  /** What a container wrote, both streams, the last 64 KiB. */
  readonly logs: (container: string) => string;
  /** Kills every container's process tree and removes the pod's folder. */
  readonly stop: () => Promise<void>;
};

const LOG_CAP = 64 * 1024;

/** The host's variables a process needs to start at all, which a container's environment doesn't carry. */
const hostBasics = (): Record<string, string> => {
  const names = process.platform === "win32" ? ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE"] : ["PATH", "HOME", "TMPDIR"];
  const basics: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) basics[name] = value;
  }
  return basics;
};

const imageName = (image: string): string => {
  const noDigest = image.split("@")[0] ?? image;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
};

/** Every mount of a container: its path in the container, and the folder that stands for it here. */
type Mount = { readonly mountPath: string; readonly hostPath: string };

const rewrite = (value: string, mounts: readonly Mount[]): string => {
  const match = mounts.filter((mount) => value === mount.mountPath || value.startsWith(`${mount.mountPath}/`)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (match === undefined) return value;
  const rest = value.slice(match.mountPath.length).replace(/^\//, "");
  return rest === "" ? match.hostPath : path.join(match.hostPath, ...rest.split("/"));
};

export const runPodProcesses = async (input: PodProcessesInput, options: ProcessModeOptions): Promise<PodProcesses> => {
  const say = (line: string): void => {
    options.log(`${PROCESS_MODE_NOTICE} ${input.namespace}/${input.name}: ${line}`);
  };
  const dir = path.join(options.root, input.namespace, `${input.name}-${input.uid.slice(0, 8)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "volumes"), { recursive: true });

  // The volumes: a secret's keys as files, readable by this account only where modes mean something; an emptyDir as a folder.
  const volumeDirs = new Map<string, string>();
  for (const volume of input.spec.volumes ?? []) {
    const volumeDir = path.join(dir, "volumes", volume.name);
    await mkdir(volumeDir, { recursive: true });
    volumeDirs.set(volume.name, volumeDir);
    if (volume.secret !== undefined) {
      const data = input.secret(volume.secret.secretName) ?? {};
      const items = volume.secret.items ?? Object.keys(data).map((key) => ({ key, path: key }));
      for (const item of items) {
        const content = data[item.key];
        if (content === undefined) continue;
        const file = path.join(volumeDir, ...item.path.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, { mode: 0o400 });
        await chmod(file, 0o400);
      }
    }
  }

  const runs: ContainerRun[] = [];
  const children = new Map<string, ChildProcess>();
  const logs = new Map<string, string>();
  const life = { stopping: false };
  // Read through a call: a stop can land while the containers run.
  const isStopping = (): boolean => life.stopping;

  const containerEnv = (container: FakeContainerSpec, mounts: readonly Mount[]): Record<string, string> => {
    const env: Record<string, string> = { ...hostBasics(), OSTRA_FAKE_KUBE_POD_DIR: dir };
    for (const from of container.envFrom ?? []) {
      const data = from.secretRef === undefined ? undefined : input.secret(from.secretRef.name);
      for (const [key, value] of Object.entries(data ?? {})) env[key] = value.toString("utf8");
    }
    for (const variable of container.env ?? []) {
      if (variable.value !== undefined) {
        env[variable.name] = rewrite(variable.value, mounts);
        continue;
      }
      const secretRef = variable.valueFrom?.secretKeyRef;
      if (secretRef !== undefined) {
        const value = input.secret(secretRef.name)?.[secretRef.key];
        if (value !== undefined) env[variable.name] = value.toString("utf8");
        continue;
      }
      const field = variable.valueFrom?.fieldRef?.fieldPath;
      const fields: Readonly<Record<string, string>> = {
        "metadata.name": input.name,
        "metadata.namespace": input.namespace,
        "metadata.uid": input.uid,
        "status.podIP": "127.0.0.1",
      };
      const value = field === undefined ? undefined : fields[field];
      if (value !== undefined) env[variable.name] = value;
    }
    return env;
  };

  const argvOf = (container: FakeContainerSpec): readonly string[] | null => {
    const image = container.image ?? "";
    const entry = container.command ?? options.imageCommands?.[imageName(image)] ?? [];
    const argv = [...entry, ...(container.args ?? [])];
    const [first, ...rest] = argv;
    if (first === undefined) return null;
    const mapped = options.commands?.[first];
    return mapped === undefined ? argv : [...mapped, ...rest];
  };

  /** Starts one container; resolves once it's running (or failed to start). Its exit is reported through `onChange`. */
  const start = (container: FakeContainerSpec, run: ContainerRun): Promise<void> =>
    new Promise((resolve) => {
      const mounts = (container.volumeMounts ?? []).flatMap((mount): Mount[] => {
        const base = volumeDirs.get(mount.name);
        if (base === undefined) return [];
        return [{ mountPath: mount.mountPath.replace(/\/+$/, ""), hostPath: mount.subPath === undefined ? base : path.join(base, mount.subPath) }];
      });
      const argv = argvOf(container);
      const finish = (code: number, reason: string | null): void => {
        run.state = "exited";
        run.exitCode = code;
        run.reason = reason;
        run.finishedAt = new Date();
        input.onChange();
      };
      if (argv === null) {
        say(`container ${container.name} has no command, and its image ${run.image} has none here`);
        finish(127, "no command");
        resolve();
        return;
      }
      const [command = "", ...args] = argv.map((part) => rewrite(part, mounts));
      const cwd = container.workingDir === undefined ? dir : rewrite(container.workingDir, mounts);
      const child = spawn(command, args, {
        cwd: cwd.startsWith("/") && process.platform === "win32" ? dir : cwd,
        env: containerEnv(container, mounts),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      children.set(container.name, child);
      const keep = (chunk: Buffer): void => {
        const next = (logs.get(container.name) ?? "") + chunk.toString("utf8");
        logs.set(container.name, next.length > LOG_CAP ? next.slice(-LOG_CAP) : next);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.once("spawn", () => {
        run.state = "running";
        run.pid = child.pid ?? null;
        run.startedAt = new Date();
        say(`container ${container.name} started as process ${String(child.pid ?? "?")}`);
        input.onChange();
        resolve();
      });
      child.once("error", (error) => {
        say(`container ${container.name} failed to start: ${error.message}`);
        if (run.state !== "exited") finish(128, "failed to start");
        resolve();
      });
      child.once("exit", (code, signal) => {
        say(`container ${container.name} exited with ${code === null ? `signal ${String(signal)}` : String(code)}`);
        children.delete(container.name);
        if (run.state !== "exited") finish(code ?? 137, null);
      });
    });

  const waitExit = (name: string): Promise<void> =>
    new Promise((resolve) => {
      const child = children.get(name);
      if (child?.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => {
        resolve();
      });
    });

  const stopAll = async (): Promise<void> => {
    await Promise.all(
      [...children.values()].map(async (child) => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await killTree(child.pid);
      }),
    );
  };

  for (const container of input.spec.initContainers ?? []) {
    runs.push({ name: container.name, image: container.image ?? "", role: container.restartPolicy === "Always" ? "sidecar" : "init", state: "waiting", pid: null, exitCode: null, reason: null, startedAt: null, finishedAt: null });
  }
  for (const container of input.spec.containers) {
    runs.push({ name: container.name, image: container.image ?? "", role: "main", state: "waiting", pid: null, exitCode: null, reason: null, startedAt: null, finishedAt: null });
  }
  say(`runs each container as a local process; folder ${dir}`);

  // Init containers in order: a sidecar starts and stays, a plain one runs to its end first. Then every main container.
  const runAll = async (): Promise<void> => {
    for (const container of input.spec.initContainers ?? []) {
      const run = runs.find((item) => item.name === container.name);
      if (run === undefined || life.stopping) return;
      await start(container, run);
      if (run.role === "init") {
        await waitExit(container.name);
        if (run.exitCode !== 0) return;
      }
    }
    const main = input.spec.containers.flatMap((container) => {
      const run = runs.find((item) => item.name === container.name);
      return run === undefined ? [] : [{ container, run }];
    });
    if (life.stopping) return;
    await Promise.all(main.map(({ container, run }) => start(container, run)));
    await Promise.all(main.map(({ container }) => waitExit(container.name)));
    // The main containers ended: the native sidecars are stopped, as the kubelet does.
    if (!isStopping()) await stopAll();
  };
  void runAll();

  return {
    dir,
    containers: () => runs,
    logs: (container) => logs.get(container) ?? "",
    stop: async () => {
      life.stopping = true;
      await stopAll();
      await Promise.all([...children.keys()].map(waitExit));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      say("stopped every container and removed the pod's folder");
    },
  };
};
