// One request to the sidecar's control API over its Unix socket, from inside
// the sidecar's own container (Kubernetes). The runner runs:
//
//   kubectl exec -i -c sidecar <pod> -- node src/sidecar/control-client.ts < request.json
//
// stdin: {"token": "...", "method": "GET", "path": "/status", "body": ...}.
// The control token arrives on stdin, never in argv. stdout: one JSON line,
// {"status": <http status>, "body": <the answer>}.

import { request } from "node:http";
import { z } from "zod";

const env = z.object({ OSTRA_CONTROL_SOCKET: z.string().min(1) }).parse(process.env);

/** ostra owns this format: strict. */
const requestSchema = z.strictObject({
  token: z.string().min(16).max(8192),
  method: z.enum(["GET", "POST"]),
  path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/),
  body: z.unknown().optional(),
});

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
const payload = input.body === undefined ? undefined : JSON.stringify(input.body);

const result = await new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
  const req = request(
    {
      socketPath: env.OSTRA_CONTROL_SOCKET,
      method: input.method,
      path: input.path,
      headers: { authorization: `Bearer ${input.token}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
      timeout: 180_000,
    },
    (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") });
      });
    },
  );
  req.once("timeout", () => {
    req.destroy(new Error("timeout"));
  });
  req.once("error", reject);
  req.end(payload);
});

const body: unknown = result.text === "" ? null : JSON.parse(result.text);
process.stdout.write(`${JSON.stringify({ status: result.status, body })}\n`);
