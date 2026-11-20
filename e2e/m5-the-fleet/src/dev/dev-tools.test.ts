import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { afterAll, describe, expect, it } from "vitest";

import { nextPatch } from "./common.ts";

// Ticket 36: each of milestone 5's dev tools starts, answers its health check, does its one job
// from another process where it has one, stops cleanly, and refuses to start in production.

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = (name: string): string => path.join(here, `${name}.ts`);
const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

const dataDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ostra-m5-dev-"));
  folders.push(dir);
  return dir;
};

type Started = {
  readonly child: ChildProcess;
  readonly ready: Readonly<Record<string, unknown>>;
  readonly output: () => string;
  /** Sends `{ type: "stop" }` and answers the exit code. */
  readonly stop: () => Promise<number | null>;
};

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => {
      resolve(code);
    });
  });

const startTool = (name: string, env: Readonly<Record<string, string>>, args: readonly string[] = []): Promise<Started> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool(name), ...args], { env: { ...process.env, NODE_ENV: "test", ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} didn't say it was ready: ${text}`));
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${String(code)} before it was ready: ${text}`));
    });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "ready") return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      resolve({
        child,
        ready: Object.fromEntries(Object.entries(message)),
        output: () => text,
        stop: async () => {
          child.send({ type: "stop" });
          return exited(child);
        },
      });
    });
  });

const runOnce = (name: string, env: Readonly<Record<string, string>>, args: readonly string[] = []): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [tool(name), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    // A tool that should have refused and didn't is ended, so no case leaves one running.
    const timer = setTimeout(() => {
      child.kill();
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

const status = (url: string, options: https.RequestOptions = {}): Promise<number | "refused"> =>
  new Promise((resolve) => {
    const get = url.startsWith("https:") ? https.get : http.get;
    const call = get(url, options, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    call.on("error", () => {
      resolve("refused");
    });
  });

const text = (value: unknown): string => (typeof value === "string" ? value : "");

describe("milestone 5's dev tools (ticket 36)", () => {
  it("F-093: dev:fake-kube serves the fake API on loopback with its kubeconfig, holds a pod for a scale-up from another process, and stops cleanly", async () => {
    const dir = await dataDir();
    const env = { OSTRA_DEV_DATA_DIR: dir, OSTRA_DEV_FAKE_KUBE_PORT: "0" };
    const fake = await startTool("fake-kube", env);
    const url = text(fake.ready["url"]);
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const kubeconfigPath = path.join(dir, "fake-kube", "kubeconfig");
    expect(text(fake.ready["kubeconfig"])).toBe(kubeconfigPath);
    const config = new KubeConfig();
    config.loadFromString(await readFile(kubeconfigPath, "utf8"));
    const ca = Buffer.from(config.getCurrentCluster()?.caData ?? "", "base64").toString("utf8");
    expect(await status(`${url}/healthz`, { ca })).toBe(200);

    expect(await runOnce("fake-kube", { ...env, NODE_ENV: "test" }, ["hold", "30s"])).toMatchObject({ code: 0 });
    const core = config.makeApiClient(CoreV1Api);
    await core.createNamespacedPod({ namespace: "default", body: { metadata: { name: "held" }, spec: { containers: [{ name: "agent", image: "ghcr.io/ostra/base:1.0.0" }] } } });
    const pod = await core.readNamespacedPod({ name: "held", namespace: "default" });
    expect(pod.status?.conditions?.find((condition) => condition.type === "PodScheduled")?.reason).toBe("Unschedulable");
    const events = await core.listNamespacedEvent({ namespace: "default", fieldSelector: "involvedObject.name=held" });
    expect(events.items.map((event) => event.reason)).toContain("TriggeredScaleUp");

    expect(await fake.stop()).toBe(0);
    expect(await status(`${url}/healthz`, { ca })).toBe("refused");
    // With nothing running, a switch says so.
    await rm(kubeconfigPath);
    expect(await runOnce("fake-kube", { ...env, NODE_ENV: "test" }, ["hold", "5s"])).toMatchObject({ code: 1 });
  });

  it("F-093: dev:fake-kube --process starts in the process mode, says it has no isolation and no limits, and stops cleanly", async () => {
    const dir = await dataDir();
    const fake = await startTool("fake-kube", { OSTRA_DEV_DATA_DIR: dir, OSTRA_DEV_FAKE_KUBE_PORT: "0" }, ["--process"]);
    expect(fake.output()).toContain("NO isolation and NO limits");
    expect(await fake.stop()).toBe(0);
  });

  it("F-120: dev:registry serves the fake registry on loopback, prints its push and pull credentials once, answers /v2/ with its challenge, and stops cleanly", async () => {
    const registry = await startTool("registry", { OSTRA_DEV_REGISTRY_PORT: "0" });
    const url = text(registry.ready["url"]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await status(`${url}/v2/`)).toBe(401);
    expect(registry.output()).toMatch(/push credential: ostra-push \/ [0-9a-f]{24}/);
    expect(registry.output()).toMatch(/pull credential: ostra-pull \/ [0-9a-f]{24}/);
    expect(await registry.stop()).toBe(0);
    expect(await status(`${url}/v2/`)).toBe("refused");
  });

  it("F-061: dev:npm-registry serves the CLI at the checkout's version and one patch above, and stops cleanly", async () => {
    const npm = await startTool("npm-registry", { OSTRA_DEV_NPM_REGISTRY_PORT: "0" });
    const url = text(npm.ready["url"]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const runner: unknown = JSON.parse(await readFile(path.join(here, "..", "..", "..", "..", "apps", "runner", "package.json"), "utf8"));
    const version = typeof runner === "object" && runner !== null && "version" in runner && typeof runner.version === "string" ? runner.version : "";
    expect(npm.ready["versions"]).toEqual([version, nextPatch(version)]);
    const packument = await fetch(`${url}/ostra`);
    expect(packument.status).toBe(200);
    const body: unknown = await packument.json();
    expect(body).toMatchObject({ name: "ostra", "dist-tags": { latest: nextPatch(version) } });
    expect(JSON.stringify(body)).toMatch(/"integrity":"sha512-/);
    expect(await npm.stop()).toBe(0);
    expect(await status(`${url}/ostra`)).toBe("refused");
  });

  it("F-013: dev:net-proxies puts the three proxies in front of core on loopback, writes their CA, switches the inspecting proxy's mode while it runs, and stops cleanly", async () => {
    const dir = await dataDir();
    const core = http.createServer((_request, response) => {
      response.writeHead(200).end("core");
    });
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
    const address = core.address();
    const corePort = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const proxies = await startTool("net-proxies", { OSTRA_DEV_DATA_DIR: dir, OSTRA_DEV_NET_PROXIES_PORT: "0", OSTRA_CORE_PORT: String(corePort) });
      const control = `http://127.0.0.1:${String(proxies.ready["control"])}`;
      expect(await status(`${control}/healthz`)).toBe(200);
      expect(await readFile(text(proxies.ready["ca"]), "utf8")).toContain("BEGIN CERTIFICATE");

      // The CONNECT proxy asks for Basic auth, and with the credentials in its file reaches core,
      // behind TLS, by its test name, end to end.
      const proxyUrl = new URL((await readFile(text(proxies.ready["connectUrlFile"]), "utf8")).trim());
      expect(JSON.stringify(proxies.ready)).not.toContain(proxyUrl.password);
      const tunnel = (authorization: string | null) =>
        new Promise<{ readonly status: number; readonly socket: Duplex | null }>((resolve) => {
          const call = http.request({
            host: "127.0.0.1",
            port: Number(proxies.ready["connect"]),
            method: "CONNECT",
            path: `ostra-core.test:${String(corePort)}`,
            ...(authorization === null ? {} : { headers: { "proxy-authorization": authorization } }),
          });
          call.once("connect", (answer, socket) => {
            resolve({ status: answer.statusCode ?? 0, socket });
          });
          call.once("error", () => {
            resolve({ status: 0, socket: null });
          });
          call.end();
        });
      const refused = await tunnel(null);
      refused.socket?.destroy();
      expect(refused.status).toBe(407);
      const basic = `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`;
      const opened = await tunnel(basic);
      expect(opened.status).toBe(200);
      const ca = await readFile(text(proxies.ready["ca"]), "utf8");
      const answer = await new Promise<string>((resolve, reject) => {
        const secure = tls.connect({ ...(opened.socket === null ? {} : { socket: opened.socket }), servername: "ostra-core.test", ca: [ca] }, () => {
          secure.write("GET / HTTP/1.1\r\nhost: ostra-core.test\r\nconnection: close\r\n\r\n");
        });
        let body = "";
        secure.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        secure.on("end", () => {
          resolve(body);
        });
        secure.on("error", reject);
      });
      expect(answer).toContain("core");

      const switched = await fetch(`${control}/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "block" }) });
      expect(await switched.json()).toMatchObject({ mode: "block" });
      expect(await proxies.stop()).toBe(0);
      expect(await status(`${control}/healthz`)).toBe("refused");
    } finally {
      core.closeAllConnections();
      await new Promise<void>((resolve) => {
        core.close(() => {
          resolve();
        });
      });
    }
  });

  it.each(["fake-kube", "registry", "npm-registry", "net-proxies"])("F-093: %s refuses to start with NODE_ENV=production", async (name) => {
    const dir = await dataDir();
    const result = await runOnce(name, { NODE_ENV: "production", OSTRA_DEV_DATA_DIR: dir });
    expect(result.code).toBe(1);
    expect(result.output).toContain("runs only when NODE_ENV is development or test");
  });
});
