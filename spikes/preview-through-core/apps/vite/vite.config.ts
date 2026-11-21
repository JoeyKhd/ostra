import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Vite app: React, with /api sent to the API on 3001 by server.proxy (WebSockets too), and two routes of
// the spike's own: /__echo returns the headers Vite got, and /xfo is a page that refuses to be framed. No
// allowedHosts, no HMR option: the project is as a member would have it.
const apiPort = process.env["SPIKE_API_PORT"] ?? "3001";
const appPort = Number(process.env["SPIKE_VITE_PORT"] ?? "5173");

const spikeRoutes = (): Plugin => ({
  name: "spike-routes",
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/__echo") === true) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ url: request.url, headers: request.headers }));
        return;
      }
      if (request.url === "/xfo") {
        response.setHeader("content-type", "text/html");
        response.setHeader("x-frame-options", "DENY");
        response.setHeader("content-security-policy", "frame-ancestors 'none'");
        response.end("<!doctype html><title>xfo</title><p id=xfo>framed anyway</p>");
        return;
      }
      if (request.url === "/go-home") {
        response.statusCode = 302;
        response.setHeader("location", `http://localhost:${String(appPort)}/`);
        response.end();
        return;
      }
      next();
    });
  },
});

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), spikeRoutes()],
  server: {
    port: appPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true } },
  },
  logLevel: "warn",
  clearScreen: false,
});
