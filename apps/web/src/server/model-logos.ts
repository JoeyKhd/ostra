import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CatalogEntry } from "@ostra/adapter-sdk";

// The logo behind `/model-logos/<id>.svg` (F-088, ADR 0021): the panel never loads an image from a
// vendor, so the server fetches a provider's logo from models.dev once, keeps it in
// `OSTRA_DATA_DIR`, and serves it from there. The route is public, so what it fetches is bounded by
// the catalog: only an id some catalog entry points its `logoPath` at is ever requested, and a
// failed fetch is remembered for a while instead of being repeated on every request.

export const PLAIN_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="#000" stroke-width="1.5"/></svg>';

const LOGO_PREFIX = "/model-logos/";
const FILE_PATTERN = /^([a-z0-9][a-z0-9._-]{0,63})\.svg$/;
const FAILURE_TTL_MS = 60 * 60 * 1000;

export type LogoResult = {
  readonly svg: string;
  /** False for the plain mark that stands in for a logo, which a browser should not keep for long. */
  readonly found: boolean;
};

export type LogoServerInput = {
  readonly catalog: { readonly entries: () => Promise<readonly CatalogEntry[]> };
  readonly dataDir: string;
  /** `OSTRA_CATALOG_FETCH`. Off: nothing is fetched, and what was kept before is still served. */
  readonly fetchEnabled: boolean;
  /** Replaces `fetch`, for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Replaces the clock, for tests. */
  readonly now?: () => number;
};

const looksLikeSvg = (text: string): boolean => text.trimStart().startsWith("<svg") && text.length < 200_000;

/** The file name (`openai.svg`) a catalog `logoPath` serves, or `null` for any other path. */
const fileOf = (logoPath: string | null): string | null => {
  if (!logoPath?.startsWith(LOGO_PREFIX)) return null;
  try {
    return decodeURIComponent(logoPath.slice(LOGO_PREFIX.length));
  } catch {
    return null;
  }
};

/** The id in a logo file name (`openai.svg`), or `null` when it isn't a well-formed one. */
export const logoIdOf = (file: string): string | null => FILE_PATTERN.exec(file)?.[1] ?? null;

export const createLogoServer = (input: LogoServerInput): { readonly logo: (id: string) => Promise<LogoResult> } => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const failedUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<LogoResult>>();
  const plain: LogoResult = { svg: PLAIN_MARK, found: false };

  const download = async (id: string, cacheFile: string): Promise<LogoResult> => {
    try {
      const response = await fetchImpl(`https://models.dev/logos/${id}.svg`, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      if (response.ok && looksLikeSvg(text)) {
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, text, "utf8");
        return { svg: text, found: true };
      }
    } catch {
      // Remembered below, like a refusal.
    }
    failedUntil.set(id, now() + FAILURE_TTL_MS);
    return plain;
  };

  const logo = async (id: string): Promise<LogoResult> => {
    const known = (await input.catalog.entries()).some((entry) => fileOf(entry.logoPath) === `${id}.svg`);
    if (!known) return plain;
    const cacheFile = path.join(input.dataDir, "model-logos", `${id}.svg`);
    try {
      return { svg: await readFile(cacheFile, "utf8"), found: true };
    } catch {
      // Not kept yet.
    }
    if (!input.fetchEnabled) return plain;
    const until = failedUntil.get(id);
    if (until !== undefined) {
      if (now() < until) return plain;
      failedUntil.delete(id);
    }
    const pending = inFlight.get(id) ?? download(id, cacheFile).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
    return pending;
  };

  return { logo };
};
