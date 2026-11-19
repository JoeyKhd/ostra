import { createWriteStream } from "node:fs";
import http from "node:http";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

// The Docker Engine API, over its socket with `node:http` (answers section 4.6 allowed this over
// dockerode, and it adds no dependency). The pool runner uses it to create and remove boxes; it's
// root on the host (Q97), so pool runners belong on dedicated hosts. Every answer is a vendor's
// format: parsed with loose schemas, and only the fields ostra reads.

export const ENGINE_API_VERSION = "v1.43";

export type EngineAddress =
  /** A Unix socket (`/var/run/docker.sock`) or a Windows named pipe (`//./pipe/docker_engine`). */
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

/** `DOCKER_HOST` as Docker's own tools read it, or the platform's default socket. */
export const engineAddressFrom = (dockerHost: string | undefined, platform: NodeJS.Platform = process.platform): EngineAddress => {
  if (dockerHost === undefined || dockerHost === "") {
    return platform === "win32" ? { kind: "socket", path: "//./pipe/docker_engine" } : { kind: "socket", path: "/var/run/docker.sock" };
  }
  if (dockerHost.startsWith("unix://")) {
    return { kind: "socket", path: dockerHost.slice("unix://".length) };
  }
  if (dockerHost.startsWith("npipe://")) {
    return { kind: "socket", path: dockerHost.slice("npipe://".length) };
  }
  const tcp = /^tcp:\/\/([^:/]+):(\d+)\/?$/.exec(dockerHost);
  if (tcp?.[1] !== undefined && tcp[2] !== undefined) {
    return { kind: "tcp", host: tcp[1], port: Number(tcp[2]) };
  }
  throw new Error("DOCKER_HOST isn't unix://, npipe:// or tcp://host:port");
};

export type EngineError = { readonly status: number; readonly message: string };
export type EngineResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: EngineError };

const engineMessageSchema = z.looseObject({ message: z.string() });

export type Engine = {
  readonly call: <Schema extends z.ZodType>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: Schema,
    body?: unknown,
  ) => Promise<EngineResult<z.infer<Schema>>>;
  /** Runs a command in a running container and returns its output (the live suite's checks). */
  readonly exec: (containerId: string, cmd: readonly string[], user?: string) => Promise<EngineResult<{ readonly exitCode: number; readonly output: string }>>;
  /** Streams a GET's body to a file: an image's archive (`/images/<id>/get`) for the scan. */
  readonly download: (path: string, file: string) => Promise<EngineResult<void>>;
};

/** Docker's multiplexed stream (no TTY): 8-byte headers, then each frame's bytes. */
export const demultiplex = (raw: Buffer): string => {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
};

const execCreatedSchema = z.looseObject({ Id: z.string().min(1) });
const execInspectSchema = z.looseObject({ ExitCode: z.number().int().nullable() });

/** What a call that answers nothing (204) parses to. */
export const emptySchema = z.unknown();

const rawCall = (address: EngineAddress, method: "POST", path: string, body: unknown, timeoutMs: number): Promise<EngineResult<Buffer>> =>
  new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const target = address.kind === "socket" ? { socketPath: address.path } : { host: address.host, port: address.port };
    const request = http.request(
      {
        ...target,
        method,
        path: `/${ENGINE_API_VERSION}${path}`,
        headers: { "user-agent": "ostra-runner", "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 400 ? { ok: false, error: { status, message: `status ${String(status)}` } } : { ok: true, value: Buffer.concat(chunks) });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, error: { status: 0, message: `the Docker Engine is unreachable (${error.name})` } });
    });
    request.end(payload);
  });

export const createEngine = (address: EngineAddress, timeoutMs = 60_000): Engine => ({
  download: (path, file) =>
    new Promise((resolve) => {
      const target = address.kind === "socket" ? { socketPath: address.path } : { host: address.host, port: address.port };
      const request = http.request(
        { ...target, method: "GET", path: `/${ENGINE_API_VERSION}${path}`, headers: { "user-agent": "ostra-runner" }, timeout: timeoutMs },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 400) {
            response.resume();
            resolve({ ok: false, error: { status, message: `status ${String(status)}` } });
            return;
          }
          // An image is gigabytes: to the file as it comes, never in memory.
          pipeline(response, createWriteStream(file, { mode: 0o600 })).then(
            () => {
              resolve({ ok: true, value: undefined });
            },
            (error: unknown) => {
              resolve({ ok: false, error: { status: 0, message: `the download failed (${error instanceof Error ? error.name : "unknown"})` } });
            },
          );
        },
      );
      // Only while nothing comes: an export that streams for minutes isn't cut.
      request.on("timeout", () => {
        request.destroy(new Error("timeout"));
      });
      request.on("error", (error) => {
        resolve({ ok: false, error: { status: 0, message: `the Docker Engine is unreachable (${error.name})` } });
      });
      request.end();
    }),
  exec: async (containerId, cmd, user) => {
    const engine = createEngine(address, timeoutMs);
    const created = await engine.call("POST", `/containers/${containerId}/exec`, execCreatedSchema, {
      Cmd: [...cmd],
      AttachStdout: true,
      AttachStderr: true,
      ...(user === undefined ? {} : { User: user }),
    });
    if (!created.ok) {
      return created;
    }
    const started = await rawCall(address, "POST", `/exec/${created.value.Id}/start`, { Detach: false, Tty: false }, timeoutMs);
    if (!started.ok) {
      return started;
    }
    const inspected = await engine.call("GET", `/exec/${created.value.Id}/json`, execInspectSchema);
    return inspected.ok
      ? { ok: true, value: { exitCode: inspected.value.ExitCode ?? -1, output: demultiplex(started.value) } }
      : inspected;
  },
  call: (method, path, schema, body) =>
    new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const target = address.kind === "socket" ? { socketPath: address.path } : { host: address.host, port: address.port };
      const request = http.request(
        {
          ...target,
          method,
          path: `/${ENGINE_API_VERSION}${path}`,
          headers: {
            "user-agent": "ostra-runner",
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = null;
            try {
              json = text.length === 0 ? null : JSON.parse(text);
            } catch {
              json = null;
            }
            if (status >= 400) {
              const parsed = engineMessageSchema.safeParse(json);
              resolve({ ok: false, error: { status, message: parsed.success ? parsed.data.message.slice(0, 500) : `status ${String(status)}` } });
              return;
            }
            const parsed = schema.safeParse(json);
            resolve(parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { status, message: "the Engine's answer has an unexpected shape" } });
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("timeout"));
      });
      request.on("error", (error) => {
        resolve({ ok: false, error: { status: 0, message: `the Docker Engine is unreachable (${error.name})` } });
      });
      request.end(payload);
    }),
});
