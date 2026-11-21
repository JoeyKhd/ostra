import path from "node:path";

// The Next.js 16 app as a member would have it: no allowedDevOrigins, nothing for the proxy. Turbopack's root
// is the spike's folder, since the repo around it has a lockfile of its own.
const config = { turbopack: { root: path.resolve(import.meta.dirname, "../..") } };
export default config;
