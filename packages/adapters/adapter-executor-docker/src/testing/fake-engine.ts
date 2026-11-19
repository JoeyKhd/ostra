import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A fake Docker Engine API for the docker executor's unit tests (spec section 8): it keeps
// networks, volumes and containers in memory, records every create body, and answers the calls
// `createDockerBoxes` makes, under the API version prefix. No container runs.

export type FakeContainer = {
  readonly id: string;
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
  status: "created" | "running" | "exited";
  exitCode: number;
  readonly networks: string[];
};

export type FakeEngine = {
  readonly address: { readonly kind: "tcp"; readonly host: string; readonly port: number };
  readonly networks: Map<string, Readonly<Record<string, unknown>>>;
  readonly volumes: Map<string, Readonly<Record<string, unknown>>>;
  readonly containers: Map<string, FakeContainer>;
  readonly calls: string[];
  /** Fails the next create of this kind with a status. */
  readonly failNext: Map<"container" | "network" | "volume", number>;
  readonly close: () => Promise<void>;
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") {
    return {};
  }
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
};

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const labelsOf = (body: Readonly<Record<string, unknown>>): Record<string, string> => {
  const labels: unknown = body["Labels"];
  return typeof labels === "object" && labels !== null ? Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])) : {};
};

const listOf = (value: unknown): readonly string[] => (Array.isArray(value) ? value.map(String) : []);

export const startFakeEngine = async (): Promise<FakeEngine> => {
  const networks = new Map<string, Readonly<Record<string, unknown>>>();
  const volumes = new Map<string, Readonly<Record<string, unknown>>>();
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];
  const failNext = new Map<"container" | "network" | "volume", number>();
  const byIdOrName = (key: string): FakeContainer | undefined => containers.get(key) ?? [...containers.values()].find((item) => item.name === key);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://engine.invalid");
    const method = request.method ?? "GET";
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    calls.push(`${method} ${path}`);
    if (request.headers["user-agent"] === undefined) {
      send(response, 400, { message: "no user agent" });
      return;
    }
    const failure = (kind: "container" | "network" | "volume"): boolean => {
      const status = failNext.get(kind);
      if (status === undefined) {
        return false;
      }
      failNext.delete(kind);
      send(response, status, { message: `fake ${kind} failure` });
      return true;
    };
    if (method === "GET" && path === "/_ping") {
      response.writeHead(200, { "content-type": "text/plain" }).end("OK");
      return;
    }
    if (method === "GET" && path === "/networks") {
      const filter: unknown = JSON.parse(url.searchParams.get("filters") ?? "{}");
      const names = listOf(Reflect.get(Object(filter), "name"));
      send(response, 200, [...networks.keys()].filter((name) => names.length === 0 || names.includes(name)).map((name) => ({ Id: name, Name: name })));
      return;
    }
    if (method === "POST" && path === "/networks/create") {
      if (failure("network")) {
        return;
      }
      const body = await readJson(request);
      const name = String(body["Name"]);
      if (networks.has(name)) {
        send(response, 409, { message: "network exists" });
        return;
      }
      networks.set(name, body);
      send(response, 201, { Id: name });
      return;
    }
    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (method === "POST" && connect?.[1] !== undefined) {
      const body = await readJson(request);
      const container = byIdOrName(String(body["Container"]));
      if (!networks.has(connect[1]) || container === undefined) {
        send(response, 404, { message: "no such network or container" });
        return;
      }
      container.networks.push(connect[1]);
      send(response, 200);
      return;
    }
    const network = /^\/networks\/([^/]+)$/.exec(path);
    if (method === "DELETE" && network?.[1] !== undefined) {
      const existed = networks.delete(network[1]);
      send(response, existed ? 204 : 404, existed ? undefined : { message: "no such network" });
      return;
    }
    if (method === "POST" && path === "/volumes/create") {
      if (failure("volume")) {
        return;
      }
      const body = await readJson(request);
      volumes.set(String(body["Name"]), body);
      send(response, 201, { Name: body["Name"] });
      return;
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "DELETE" && volume?.[1] !== undefined) {
      const existed = volumes.delete(volume[1]);
      send(response, existed ? 204 : 404, existed ? undefined : { message: "no such volume" });
      return;
    }
    if (method === "POST" && path === "/containers/create") {
      if (failure("container")) {
        return;
      }
      const body = await readJson(request);
      // As the Engine does: a container's name is unique.
      const wanted = url.searchParams.get("name");
      if (wanted !== null && [...containers.values()].some((container) => container.name === wanted)) {
        send(response, 409, { message: `Conflict. The container name "/${wanted}" is already in use` });
        return;
      }
      const id = randomBytes(16).toString("hex");
      const hostConfig: unknown = body["HostConfig"];
      const mode: unknown = Reflect.get(Object(hostConfig), "NetworkMode");
      containers.set(id, { id, name: url.searchParams.get("name") ?? id, body, status: "created", exitCode: 0, networks: typeof mode === "string" ? [mode] : [] });
      send(response, 201, { Id: id, Warnings: [] });
      return;
    }
    if (method === "GET" && path === "/containers/json") {
      const filter: unknown = JSON.parse(url.searchParams.get("filters") ?? "{}");
      const pairs = listOf(Reflect.get(Object(filter), "label")).map((item) => item.split("="));
      const matching = [...containers.values()].filter((container) => pairs.every(([key = "", value]) => labelsOf(container.body)[key] === value));
      send(response, 200, matching.map((container) => ({ Id: container.id, Names: [`/${container.name}`], Labels: labelsOf(container.body), State: container.status })));
      return;
    }
    const action = /^\/containers\/([^/]+)\/(start|stop|json)$/.exec(path);
    if (action?.[1] !== undefined) {
      const container = byIdOrName(action[1]);
      if (container === undefined) {
        send(response, 404, { message: "no such container" });
        return;
      }
      if (action[2] === "start") {
        container.status = "running";
        send(response, 204);
        return;
      }
      if (action[2] === "stop") {
        container.status = "exited";
        send(response, 204);
        return;
      }
      send(response, 200, { Id: container.id, State: { Status: container.status, Running: container.status === "running", ExitCode: container.exitCode } });
      return;
    }
    const removed = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && removed?.[1] !== undefined) {
      const container = byIdOrName(removed[1]);
      if (container === undefined) {
        send(response, 404, { message: "no such container" });
        return;
      }
      containers.delete(container.id);
      send(response, 204);
      return;
    }
    send(response, 404, { message: `the fake engine has no ${method} ${path}` });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      send(response, 500, { message: "fake engine failure" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    address: { kind: "tcp", host: "127.0.0.1", port },
    networks,
    volumes,
    containers,
    calls,
    failNext,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
