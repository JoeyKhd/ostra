// `pnpm dev:fake-kube [--process]`: ticket 06's fake Kubernetes API on loopback until Ctrl-C, with
// its kubeconfig in `.ostra-dev/fake-kube/kubeconfig` for a `--executor kubernetes` runner and for
// scripts. `--process` runs each pod's containers as local processes, with no isolation and no
// limits (every line it writes says so): the runner image's `ostra` is this checkout's CLI, the base
// image's `sh` this machine's shell. From another terminal, `pnpm dev:fake-kube hold 40s` holds the
// next pods unschedulable with a scale-up event, `fail-pull <image>` fails an image's pull,
// `clear-pull-failures` undoes it, and `minor 28` reports Kubernetes 1.28. Development and test only.

import { request } from "node:https";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { startFakeKubeApi } from "@ostra/adapter-executor-kubernetes/testing";
import { z } from "zod";

import { devDataDir, devToolAllowed, parseDuration, portFrom, refuseOutsideDev, repoRoot, say, serveUntilStopped } from "./common.ts";

const kubeconfigSchema = z.looseObject({
  clusters: z.array(z.looseObject({ cluster: z.looseObject({ server: z.string(), "certificate-authority-data": z.string() }) })).min(1),
  users: z.array(z.looseObject({ user: z.looseObject({ token: z.string() }) })).min(1),
});

/** Sends a switch to the running fake, as its kubeconfig names it. */
const sendSwitch = async (kubeconfigPath: string, name: string, body: Readonly<Record<string, unknown>>): Promise<number> => {
  let text: string;
  try {
    text = await readFile(kubeconfigPath, "utf8");
  } catch {
    process.stderr.write(`No fake Kubernetes API is running here (no ${kubeconfigPath}): start one with pnpm dev:fake-kube.\n`);
    return 1;
  }
  const config = kubeconfigSchema.parse(JSON.parse(text));
  const server = new URL(config.clusters[0]?.cluster.server ?? "");
  const ca = Buffer.from(config.clusters[0]?.cluster["certificate-authority-data"] ?? "", "base64").toString("utf8");
  const payload = JSON.stringify(body);
  const status = await new Promise<number>((resolve) => {
    const call = request(
      {
        host: server.hostname,
        port: server.port,
        method: "POST",
        path: `/_fake/${name}`,
        ca,
        headers: { authorization: `Bearer ${config.users[0]?.user.token ?? ""}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    call.on("error", () => {
      resolve(0);
    });
    call.end(payload);
  });
  if (status !== 200) {
    process.stderr.write(status === 0 ? "The fake Kubernetes API didn't answer: is pnpm dev:fake-kube running?\n" : `The fake refused the switch (${String(status)}).\n`);
    return 1;
  }
  say(`fake Kubernetes API: ${name} ${JSON.stringify(body)}`);
  return 0;
};

const main = async (): Promise<number> => {
  if (!devToolAllowed(process.env)) return refuseOutsideDev("The fake Kubernetes API");
  const dir = path.join(devDataDir(process.env), "fake-kube");
  const kubeconfigPath = path.join(dir, "kubeconfig");
  const [command, value] = process.argv.slice(2);

  switch (command) {
    case "hold": {
      const ms = parseDuration(value ?? "");
      if (ms === null) {
        process.stderr.write("Usage: pnpm dev:fake-kube hold <duration>, such as 40s.\n");
        return 2;
      }
      return sendSwitch(kubeconfigPath, "hold", { ms });
    }
    case "fail-pull":
      if (value === undefined || value === "") {
        process.stderr.write("Usage: pnpm dev:fake-kube fail-pull <image prefix>.\n");
        return 2;
      }
      return sendSwitch(kubeconfigPath, "fail-pull", { image: value });
    case "clear-pull-failures":
      return sendSwitch(kubeconfigPath, "clear-pull-failures", {});
    case "minor": {
      const minor = Number(value);
      if (!Number.isInteger(minor) || minor <= 0) {
        process.stderr.write("Usage: pnpm dev:fake-kube minor <n>, such as 28.\n");
        return 2;
      }
      return sendSwitch(kubeconfigPath, "minor", { minor });
    }
    case undefined:
    case "--process":
      break;
    default:
      process.stderr.write("Usage: pnpm dev:fake-kube [--process] | hold <duration> | fail-pull <image> | clear-pull-failures | minor <n>\n");
      return 2;
  }

  const port = portFrom(process.env, "OSTRA_DEV_FAKE_KUBE_PORT", 16_443);
  if (port === null) {
    process.stderr.write("OSTRA_DEV_FAKE_KUBE_PORT is a port number.\n");
    return 2;
  }
  const processMode = command === "--process";
  await mkdir(dir, { recursive: true });
  const fake = await startFakeKubeApi({
    port,
    ...(processMode
      ? {
          processMode: {
            root: path.join(dir, "pods"),
            commands: { ostra: [process.execPath, path.join(repoRoot, "apps", "runner", "src", "main.ts")], sh: [process.platform === "win32" ? "bash" : "sh"] },
            log: say,
          },
        }
      : {}),
  });
  await writeFile(kubeconfigPath, fake.kubeconfig("default"), { mode: 0o600 });
  await chmod(kubeconfigPath, 0o600);
  say(`Fake Kubernetes API on ${fake.url} (loopback only), kubeconfig in ${kubeconfigPath}`);
  say(processMode ? "Process mode: each container runs as a local process here, with NO isolation and NO limits." : "Containers are simulated: they run until their pod is deleted.");
  return serveUntilStopped({ url: fake.url, kubeconfig: kubeconfigPath }, async () => {
    await fake.close();
  });
};

process.exitCode = await main();
