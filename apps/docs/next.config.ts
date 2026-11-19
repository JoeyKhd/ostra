import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// The docs site (ADR 0063): exported as static files for GitHub Pages, under the repo's Pages path.
const basePath = "/ostra";

/**
 * The release the docs describe: `OSTRA_DOCS_VERSION` (docs.yml sets it from the release), else the
 * newest tag, else `dev`.
 */
const docsVersion = async (): Promise<string> => {
  const fromEnv = process.env["OSTRA_DOCS_VERSION"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv.replace(/^v/, "");
  }
  try {
    const { stdout } = await promisify(execFile)("git", ["describe", "--tags", "--abbrev=0"]);
    return stdout.trim().replace(/^v/, "") || "dev";
  } catch {
    return "dev";
  }
};

const withMDX = createMDX();

const config = async (): Promise<NextConfig> =>
  withMDX({
    output: "export",
    basePath,
    trailingSlash: true,
    reactStrictMode: true,
    poweredByHeader: false,
    images: { unoptimized: true },
    env: {
      NEXT_PUBLIC_DOCS_BASE_PATH: basePath,
      NEXT_PUBLIC_DOCS_VERSION: await docsVersion(),
    },
  });

export default config;
