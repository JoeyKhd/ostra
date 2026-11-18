// Delivers the handoff to the sidecar over its Unix socket, from inside the
// sidecar's own container (Kubernetes, where loopback is shared with the
// agent and so can't be trusted). The runner runs:
//
//   kubectl exec -i -c sidecar <pod> -- node src/sidecar/handoff-client.ts < handoff.json
//
// The handoff arrives on stdin, never in argv. The socket path is the
// sidecar's own OSTRA_HANDOFF_SOCKET. Prints the sidecar's one-line answer;
// exits 1 if the handoff was refused. Prints no part of the handoff.

import { connect } from "node:net";
import { z } from "zod";

const env = z.object({ OSTRA_HANDOFF_SOCKET: z.string().min(1) }).parse(process.env);

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
const line = Buffer.concat(chunks).toString("utf8").trim();
if (line === "" || line.includes("\n")) {
  process.stderr.write("handoff-client: expected one JSON line on stdin\n");
  process.exit(2);
}

const answer = await new Promise<string>((resolve, reject) => {
  const socket = connect({ path: env.OSTRA_HANDOFF_SOCKET }, () => {
    socket.write(`${line}\n`);
  });
  socket.setTimeout(10_000);
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  socket.once("timeout", () => {
    socket.destroy();
    reject(new Error("timeout"));
  });
  socket.once("error", reject);
  socket.once("close", () => {
    resolve(buffer.trim());
  });
});

const ok = z.strictObject({ ok: z.literal(true) }).safeParse(answer === "" ? undefined : JSON.parse(answer));
process.stdout.write(`${JSON.stringify({ ok: ok.success })}\n`);
if (!ok.success) process.exitCode = 1;
