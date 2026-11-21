import { connect, createServer } from "node:net";
import { splice } from "./headers.ts";
import { parseArgs } from "node:util";

// The `docker` forwarder's logic: in the agent's container, the init listens on the box network's address at a
// port it picks for each app port, takes connections only from the sidecar's address, and dials the app at
// localhost, so an app bound to the container's own loopback is reachable (ADR 0068). Here the "box network"
// is a second loopback address (127.0.0.3) and the sidecar's address another (127.0.0.2): the logic runs, the
// container networking doesn't.

const { values: args } = parseArgs({
  options: {
    listen: { type: "string", default: "127.0.0.3" },
    allow: { type: "string", default: "127.0.0.2" },
    ports: { type: "string", default: "5173,3002,8080,3001" },
    offset: { type: "string", default: "10000" },
  },
});

const refusedFrom: string[] = [];
const stats = { accepted: 0, refused: 0, refusedFrom };
const normalise = (address: string | undefined) => (address ?? "").replace(/^::ffff:/, "");

for (const port of args.ports.split(",").map(Number)) {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    const from = normalise(socket.remoteAddress);
    if (from !== args.allow) {
      stats.refused += 1;
      stats.refusedFrom.push(from);
      process.stdout.write(`refused ${from} on ${String(port)}\n`);
      socket.destroy();
      return;
    }
    stats.accepted += 1;
    const app = connect({ host: "localhost", port, autoSelectFamily: true });
    app.on("error", () => {
      socket.destroy();
    });
    splice(socket, app);
  });
  server.listen(port + Number(args.offset), args.listen, () => {
    process.stdout.write(`forwarder ${args.listen}:${String(port + Number(args.offset))} -> localhost:${String(port)}, from ${args.allow} only\n`);
  });
}
