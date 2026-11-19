// The site's constants, written once (docs-home.md, open point 2: the repo's address comes from one
// constant, never typed in pages).

/** The repo on GitHub. */
export const repoUrl = "https://github.com/JoeyKhd/ostra";

/** The site's address: the repo's GitHub Pages address until a domain is registered (ADR 0063). */
export const siteUrl = "https://joeykhd.github.io/ostra/";

/** The Pages base path every URL of the export sits under; next.config.ts sets it. */
export const basePath = process.env["NEXT_PUBLIC_DOCS_BASE_PATH"] ?? "";

/**
 * The release the docs describe (ADR 0063: "the docs carry the version they describe"), from the
 * release tag at build time; `dev` for a build no release made.
 */
export const docsVersion = process.env["NEXT_PUBLIC_DOCS_VERSION"] ?? "dev";

/** The version as the chip shows it. */
export const versionLabel = /^\d/.test(docsVersion) ? `v${docsVersion}` : docsVersion;

/** A page's source on `main`, for "Edit on GitHub". */
export const editUrl = (repoPath: string): string => `${repoUrl}/edit/main/${repoPath}`;

/** A file on `main`, for reading. */
export const blobUrl = (repoPath: string): string => `${repoUrl}/blob/main/${repoPath}`;

/** The pages the search dialog lists before anything is typed (docs-search.md, open point 1). */
export const startHere = [
  { title: "Install with Docker Compose", url: "/docs/install/docker-compose" },
  { title: "Setup in the panel", url: "/docs/install/setup" },
  { title: "Personal runners", url: "/docs/runners/personal" },
  { title: "Configuration reference", url: "/docs/reference/configuration" },
] as const;
