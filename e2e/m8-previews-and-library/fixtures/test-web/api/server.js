import { createServer } from "node:http";

import { WebSocketServer } from "ws";

// The app's API, on 3001: the frontend calls it as /api/... on its own origin, and Vite's
// server.proxy sends the call here (ADR 0068, "One origin is the convention"). /api/ws echoes
// each WebSocket message back, through the same proxy.
const port = Number(process.env["TEST_WEB_API_PORT"] ?? "3001");
const started = Date.now();

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  switch (path) {
    case "/api/hello":
      json(response, 200, { message: `hello from the API on ${String(port)}`, upMs: Date.now() - started });
      return;
    case "/api/version":
      json(response, 200, { version: "1.0.0" });
      return;
    case "/api/headers":
      // What reached the API: a test reads Host and X-Forwarded-Host here.
      json(response, 200, { host: request.headers.host ?? null, forwardedHost: request.headers["x-forwarded-host"] ?? null });
      return;
    default:
      json(response, 404, { error: "not found" });
  }
});

const echo = new WebSocketServer({ noServer: true });
echo.on("connection", (socket) => {
  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? data : `echo: ${data.toString()}`);
  });
});
server.on("upgrade", (request, socket, head) => {
  if ((request.url ?? "").split("?")[0] !== "/api/ws") {
    socket.destroy();
    return;
  }
  echo.handleUpgrade(request, socket, head, (client) => echo.emit("connection", client, request));
});

server.listen(port, "localhost", () => {
  console.log(`api listening on ${String(port)}`);
});
