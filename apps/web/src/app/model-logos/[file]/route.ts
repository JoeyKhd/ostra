import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseServerSettings } from "@ostra/domain";

// Model logos, served by ostra (F-088, ADR 0021): the panel never loads an image from a vendor.
// The server fetches a provider's logo from models.dev once, keeps it in `OSTRA_DATA_DIR`, and
// serves it from here. With `OSTRA_CATALOG_FETCH=false`, or when the fetch fails, it serves a
// plain mark. An SVG is served with a policy that lets nothing in it run.

const plain =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="#000" stroke-width="1.5"/></svg>';

const headers = {
  "content-type": "image/svg+xml",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cache-control": "public, max-age=86400",
};

const looksLikeSvg = (text: string): boolean => text.trimStart().startsWith("<svg") && text.length < 200_000;

export const GET = async (_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> => {
  const { file } = await context.params;
  const id = /^([a-z0-9][a-z0-9._-]{0,63})\.svg$/.exec(file)?.[1];
  if (id === undefined) return new Response(plain, { status: 404, headers });
  const parsed = parseServerSettings(process.env);
  if (!parsed.ok || !parsed.settings.catalogFetch) return new Response(plain, { headers });
  const cacheFile = path.join(parsed.settings.dataDir, "model-logos", `${id}.svg`);
  try {
    return new Response(await readFile(cacheFile, "utf8"), { headers });
  } catch {
    // Not kept yet: fetch it below.
  }
  try {
    const response = await fetch(`https://models.dev/logos/${id}.svg`, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (!response.ok || !looksLikeSvg(text)) return new Response(plain, { headers });
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, text, "utf8");
    return new Response(text, { headers });
  } catch {
    return new Response(plain, { headers });
  }
};
