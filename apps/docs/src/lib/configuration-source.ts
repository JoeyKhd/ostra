import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TOCItemType } from "fumadocs-core/toc";

import { parseConfigurationReference } from "./configuration-reference";
import type { ConfigurationReference } from "./configuration-reference";

/** `docs/configuration.md`, read at build time (ADR 0063: never copied, never imported from `packages/domain`). */
export const configurationPath = path.join(process.cwd(), "..", "..", "docs", "configuration.md");

export const loadConfigurationReference = async (): Promise<ConfigurationReference> =>
  parseConfigurationReference(await readFile(configurationPath, "utf8"));

/** The reference's "On this page": the file's `##` headings, in its order. */
export const referenceToc = async (): Promise<TOCItemType[]> =>
  (await loadConfigurationReference()).groups.map((group) => ({ title: group.heading, url: `#${group.slug}`, depth: 2 }));
