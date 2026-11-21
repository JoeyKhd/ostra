import path from "node:path";

// The Next.js 16 app as a member would have it: no allowedDevOrigins, nothing for ostra's proxy
// (spike 08). Turbopack's root is the repo's, since the fixture sits in its workspace. Next.js
// writes no AGENTS.md of its own into the fixture.
const config = { turbopack: { root: path.resolve(import.meta.dirname, "../../../..") }, agentRules: false };
export default config;
