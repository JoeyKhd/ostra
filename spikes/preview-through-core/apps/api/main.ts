import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// The app's API process on 3001: /api/hello for the frontend, /api/echo that returns the headers it got (to see
// what reached the app through the tunnel), and a WebSocket echo at /api/ws.
const port = Number(process.env["SPIKE_API_PORT"] ?? "3001");

const server = createServer((request, response) => {
  if (request.url === "/api/hello") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `hello from the API on ${String(port)}` }));
    return;
  }
  if (request.url?.startsWith("/api/echo") === true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers }));
    return;
  }
  if (request.url?.startsWith("/api/big") === true) {
    const size = 2 * 1024 * 1024;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
    response.end(Buffer.alloc(size, 97));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/api/ws") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    ws.on("message", (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`api listening on ${String(port)}\n`);
});
