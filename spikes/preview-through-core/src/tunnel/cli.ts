import { connect as h2connect } from "node:http2";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { WebSocket, createWebSocketStream } from "ws";
import { pipeFailed, splice, trace } from "./headers.ts";

// An `ostra preview`-like local forward: it opens wss://<core>/cli/v1/tunnel?ticket=… and speaks HTTP/2 on it as
// the client; each TCP connection to the member's localhost:<local> becomes one CONNECT stream to the box's port.

const { values: args } = parseArgs({
  options: {
    core: { type: "string", default: "ws://127.0.0.1:8800" },
    ticket: { type: "string" },
    port: { type: "string", default: "5173" },
    local: { type: "string", default: "15173" },
  },
});
if (args.ticket === undefined) throw new Error("--ticket is required");

const socket = new WebSocket(`${args.core}/cli/v1/tunnel?ticket=${encodeURIComponent(args.ticket)}`);
await new Promise<void>((resolve, reject) => {
  socket.once("open", () => {
    resolve();
  });
  socket.once("error", reject);
  socket.once("unexpected-response", (_request, response) => {
    reject(new Error(`refused: ${String(response.statusCode)}`));
  });
});
const duplex = createWebSocketStream(socket);
duplex.on("error", () => undefined);
const session = h2connect("http://core.invalid", { createConnection: () => duplex });
session.on("error", pipeFailed("cli session"));
session.on("goaway", (code) => {
  trace(`cli session goaway ${String(code)}`);
});
socket.on("close", (code) => {
  trace(`cli socket closed ${String(code)}`);
});
let streams = 0;

const server = createServer((local) => {
  local.on("error", () => undefined);
  streams += 1;
  const stream = session.request({ ":method": "CONNECT", ":authority": `localhost:${args.port}` });
  stream.on("error", () => {
    local.destroy();
  });
  stream.on("response", (headers) => {
    if (Number(headers[":status"]) !== 200) {
      local.destroy();
      return;
    }
    splice(local, stream);
  });
});

server.listen(Number(args.local), "127.0.0.1", () => {
  process.stdout.write(`forwarding http://localhost:${args.local} to the box's ${args.port}\n`);
});
socket.on("close", () => {
  process.stdout.write(`tunnel closed after ${String(streams)} streams\n`);
  process.exit(0);
});
