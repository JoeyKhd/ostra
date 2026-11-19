import { parseServerSettings } from "@ostra/domain";

import { getApiDeps } from "@/server/deps";
import { createLogoServer, logoIdOf, PLAIN_MARK } from "@/server/model-logos";

// Model logos, served by ostra (F-088, ADR 0021): the panel never loads an image from a vendor.
// The server fetches a catalog provider's logo from models.dev once, keeps it in `OSTRA_DATA_DIR`,
// and serves it from here (`server/model-logos.ts`). With `OSTRA_CATALOG_FETCH=false`, for an id the
// catalog doesn't list, or when the fetch fails, it serves a plain mark. An SVG is served with a
// policy that lets nothing in it run.

const headers = (found: boolean) => ({
  "content-type": "image/svg+xml",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cache-control": found ? "public, max-age=86400" : "public, max-age=300",
});

// One per process: it holds the memory of failed fetches.
let server: ReturnType<typeof createLogoServer> | undefined;

export const GET = async (_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> => {
  const { file } = await context.params;
  const id = logoIdOf(file);
  if (id === null) return new Response(PLAIN_MARK, { status: 404, headers: headers(false) });
  const parsed = parseServerSettings(process.env);
  if (!parsed.ok) return new Response(PLAIN_MARK, { headers: headers(false) });
  const { catalog } = await getApiDeps();
  server ??= createLogoServer({
    catalog,
    dataDir: parsed.settings.dataDir,
    fetchEnabled: parsed.settings.catalogFetch,
  });
  const { svg, found } = await server.logo(id);
  return new Response(svg, { headers: headers(found) });
};
