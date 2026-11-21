import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app the box's browser shows: a Vite and React frontend whose /api goes to the API process on 3001
// through Vite's own proxy, the one-origin convention (ADR 0068). The ports are the ticket's.
const apiPort = process.env["SPIKE_API_PORT"] ?? "3001";
const appPort = Number(process.env["SPIKE_APP_PORT"] ?? "5173");

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: appPort,
    strictPort: true,
    host: "localhost",
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  logLevel: "warn",
  clearScreen: false,
});
