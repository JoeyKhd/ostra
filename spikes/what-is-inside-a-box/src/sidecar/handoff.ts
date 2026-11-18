// How the sidecar gets the task's credentials without an environment
// variable, an argument or a file (ADR 0030).
//
// The sidecar starts with one one-time nonce in its environment and listens
// on its handoff port. The pool runner (or, in this spike, the harness acting
// as the server) connects from outside the box, presents the nonce and sends
// one JSON document: the real model key, the GitHub token, the bridge nonce and
// the control token. The sidecar keeps it in memory, answers, and closes the
// port. The first valid handoff wins; anything from inside the box is refused
// before it is read.
//
// In the product, the handoff carries a short-lived task token instead, and
// the sidecar fetches the credentials from the server over the runner protocol
// (ADR 0029). The shape of the boundary is the same.
//
// Where it listens:
//   - Docker: a TCP port, published to the host loopback only. A connection
//     from the box network (the agent, a service) is refused by address.
//   - Kubernetes: the agent shares the pod's network namespace, so loopback is
//     the agent's too, and `kubectl port-forward` / `kubectl exec` arrive from
//     loopback as well: no address tells them apart. There the sidecar listens
//     on a Unix socket in a volume only the sidecar container mounts, and the
//     runner delivers with `kubectl exec -c sidecar ... handoff-client.ts`.

import { timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { createLineSplitter } from "../bridge/framing.ts";
import type { BoxId } from "../bridge/protocol.ts";
import { TaskIdSchema } from "../lib/ids.ts";
import { isInsideBox, type BoxNetwork } from "./box-network.ts";

const secret = z.string().min(16).max(8192);

/** `owner/name`, and neither part may be `.` or `..` (it becomes a path and a build-context path). */
export const repoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."), { message: "no . or .. segments" });

export const handoffSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().min(32).max(128),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).pipe(TaskIdSchema),
  /** For the init's hello. */
  bridgeNonce: z.string().min(32).max(128),
  /** Bearer token of the control API (the stand-in for the server connection). */
  controlToken: secret,
  model: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("endpoint"),
      baseUrl: z.url(),
      apiKey: secret,
      modelId: z.string().min(1).max(256),
      format: z.enum(["openai", "anthropic"]),
    }),
    /** A stub model server inside the sidecar, which accepts `apiKey` only. */
    z.strictObject({ kind: z.literal("stub"), apiKey: secret, format: z.enum(["openai", "anthropic"]) }),
  ]),
  git: z.strictObject({
    /** The upstream remote base, e.g. https://github.com. Stub: served by the sidecar itself. */
    upstream: z.union([z.url(), z.literal("stub")]),
    token: secret,
    /** `owner/name`. */
    repo: repoNameSchema,
    taskBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
  }),
});
export type Handoff = z.infer<typeof handoffSchema>;

export type HandoffListener = {
  /** The TCP port; 0 when listening on a Unix socket. */
  readonly port: number;
  readonly received: Promise<Handoff>;
  readonly refused: () => number;
  readonly close: () => Promise<void>;
};

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const listenForHandoff = async (options: {
  readonly boxId: BoxId;
  readonly nonce: string;
  readonly host: string;
  readonly port: number;
  /** When set, listen on this Unix socket (or Windows named pipe) instead of TCP. */
  readonly socketPath?: string | undefined;
  readonly network: BoxNetwork;
  readonly log: (line: Readonly<Record<string, string | number | boolean | null>>) => void;
}): Promise<HandoffListener> => {
  let accepted = false;
  let refused = 0;
  let open = true;
  let resolveReceived: (handoff: Handoff) => void = () => undefined;
  const received = new Promise<Handoff>((resolve) => {
    resolveReceived = resolve;
  });
  const refuse = (socket: Socket, reason: string): void => {
    refused += 1;
    options.log({ event: "handoff_refused", boxId: options.boxId, reason });
    socket.destroy();
  };

  const server = createServer((socket) => {
    if (accepted) {
      refuse(socket, "already accepted");
      return;
    }
    // The address check is for TCP only: a Unix socket has no remote address,
    // and only the sidecar container can reach its path.
    if (options.socketPath === undefined && isInsideBox(socket.remoteAddress ?? "", options.network)) {
      refuse(socket, "from inside the box");
      return;
    }
    const splitter = createLineSplitter(64 * 1024);
    const timer = setTimeout(() => {
      refuse(socket, "timeout");
    }, 5000);
    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        refuse(socket, "too long");
        return;
      }
      const line = lines[0];
      if (line === undefined) return;
      clearTimeout(timer);
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        refuse(socket, "not JSON");
        return;
      }
      const parsed = handoffSchema.safeParse(raw);
      if (!parsed.success || !sameSecret(parsed.data.nonce, options.nonce) || accepted) {
        refuse(socket, parsed.success ? "bad nonce" : "invalid handoff");
        return;
      }
      accepted = true;
      server.close();
      open = false;
      socket.end(`${JSON.stringify({ ok: true })}\n`);
      options.log({ event: "handoff_received", boxId: options.boxId, taskId: parsed.data.taskId, model: parsed.data.model.kind });
      resolveReceived(parsed.data);
    });
    socket.on("error", () => {
      clearTimeout(timer);
    });
    socket.on("close", () => {
      if (!accepted) clearTimeout(timer);
    });
  });
  const socketPath = options.socketPath;
  // A stale socket file from an earlier sidecar would make listen fail.
  if (socketPath !== undefined && process.platform !== "win32") await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.off("error", reject);
      resolve();
    };
    if (socketPath === undefined) server.listen(options.port, options.host, onListening);
    else server.listen(socketPath, onListening);
  });
  const address = server.address();
  return {
    port: socketPath !== undefined ? 0 : typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : options.port,
    received,
    refused: () => refused,
    close: async () => {
      if (!open) return;
      open = false;
      await new Promise<void>((resolve) => server.close(() => {
        resolve();
      }));
    },
  };
};
