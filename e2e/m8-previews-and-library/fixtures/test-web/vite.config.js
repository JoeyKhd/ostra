import { defineConfig } from "vite";

// The frontend: on 5173, with /api behind its own dev-server proxy to the API on 3001, the
// one-origin convention ostra tells agents to keep (ADR 0068). Every port can be moved by a
// variable, so tests run it on free ports. Two pages come from the dev server itself:
// - /frame-deny sends `X-Frame-Options: DENY`, which the native preview's proxy replaces (F-144);
// - /host-url builds a URL from the request's Host, as an app that makes its OAuth callback from
//   it does, which `hostRewrite` off keeps working (Q304).
const port = Number(process.env["TEST_WEB_PORT"] ?? "5173");
const apiPort = process.env["TEST_WEB_API_PORT"] ?? "3001";
// In an ostra box the API's in-box address comes in `OSTRA_APP_API_URL` (ADR 0068): the proxy's
// target, as a project written for ostra reads it.
const apiTarget = process.env["OSTRA_APP_API_URL"] ?? `http://localhost:${apiPort}`;

/** The two pages, before Vite's own handling. */
const testPages = {
  name: "test-web-pages",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/frame-deny") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
        response.end("<!doctype html><title>Framing refused</title><h1>This page sends X-Frame-Options: DENY</h1>");
        return;
      }
      if (path === "/host-url") {
        const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "unknown";
        const proto = request.headers["x-forwarded-proto"] ?? "http";
        const callback = `${String(proto)}://${String(host)}/auth/callback`;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Host URL</title><p id="callback">${callback.replace(/[<>&"]/g, "")}</p>`);
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  // Tests that run several copies at once give each its own cache folder.
  ...(process.env["TEST_WEB_CACHE_DIR"] === undefined ? {} : { cacheDir: process.env["TEST_WEB_CACHE_DIR"] }),
  plugins: [testPages],
  // React's automatic runtime, from Vite's own transform: no plugin beyond what the lock holds.
  oxc: { jsx: { runtime: "automatic" } },
  server: {
    port,
    strictPort: true,
    host: "localhost",
    proxy: {
      "/api": { target: apiTarget, ws: true },
    },
  },
  clearScreen: false,
});
