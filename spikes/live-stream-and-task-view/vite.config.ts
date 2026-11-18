import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is served by the spike's own server from dist/web, so the page and the API share an origin.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: false, target: "es2023" },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
