import path from "node:path";
import { fileURLToPath } from "node:url";
import webpack from "webpack";
import WebpackDevServer from "webpack-dev-server";

// webpack-dev-server 5 through its Node API, with hot updates on and every option at its default otherwise
// (allowedHosts "auto", client.webSocketURL from the page's own host).
const app = fileURLToPath(new URL("../../apps/wds", import.meta.url));
const port = Number(process.env["SPIKE_WDS_PORT"] ?? "8080");

const compiler = webpack({
  mode: "development",
  context: app,
  entry: "./src/index.js",
  output: { path: path.join(app, "dist"), filename: "main.js", publicPath: "/" },
  devtool: false,
  infrastructureLogging: { level: "warn" },
  stats: "errors-only",
});

// SPIKE_WDS_AUTO_URL=1 sets client.webSocketURL to "auto://0.0.0.0:0/ws", the page's own host and port.
// Without it, a dev server given a host or a port bakes them into its client, whose HMR socket then dials
// localhost:<port> directly, past any proxy (lib/Server.js, the client entry's hostname and port).
const autoUrl = process.env["SPIKE_WDS_AUTO_URL"] === "1";
const client = autoUrl ? { overlay: false, webSocketURL: "auto://0.0.0.0:0/ws" } : { overlay: false };
const server = new WebpackDevServer({ port, host: "localhost", hot: true, static: { directory: path.join(app, "public") }, client }, compiler);
await server.start();
process.stdout.write(`wds listening on ${String(port)}\n`);
