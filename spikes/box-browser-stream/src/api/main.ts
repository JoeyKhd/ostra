import { createServer } from "node:http";

// The app's API process: the frontend calls it as /api/... on its own origin, and Vite's server.proxy sends
// the call here (ADR 0068, "One origin is the convention").
const port = Number(process.env["SPIKE_API_PORT"] ?? "3001");
const started = Date.now();

const server = createServer((request, response) => {
  if (request.url === "/api/hello") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `hello from the API on ${String(port)}`, upMs: Date.now() - started }));
    return;
  }
  if (request.url === "/api/version") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "0.0.0-spike" }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`api listening on ${String(port)}\n`);
});
