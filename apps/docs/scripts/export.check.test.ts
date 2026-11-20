// The checked build (ticket 21, F-058): run after `next build`, by `pnpm check:export` and docs.yml.
// It reads the static export in `out/`, so it is not part of `pnpm test`.
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfigurationReference, settingsOf } from "@/lib/configuration-reference";

const app = path.join(import.meta.dirname, "..");
const out = path.join(app, "out");

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const readJson = async <T,>(file: string, schema: z.ZodType<T>): Promise<T> => schema.parse(JSON.parse(await readFile(file, "utf8")));

// Next's build manifests are Next's format, so unknown fields are tolerated.
const routesSchema = z.record(z.string(), z.string());
const prerenderSchema = z.looseObject({
  routes: z.record(z.string(), z.unknown()),
  dynamicRoutes: z.record(z.string(), z.looseObject({ fallback: z.union([z.literal(false), z.string(), z.null()]) })),
});
const exportSchema = z.looseObject({ success: z.boolean() });

/** The site's pages, from `content/`'s files and the guides read from `docs/`. */
const pageSlugs = async (): Promise<string[]> => {
  const { glob } = await import("node:fs/promises");
  const slugs: string[] = [];
  for await (const file of glob("**/*.mdx", { cwd: path.join(app, "content") })) {
    slugs.push(file.replaceAll("\\", "/").replace(/\.mdx$/, ""));
  }
  return slugs;
};

describe("the docs site's static export", () => {
  it("F-058/c1: the export builds with no server route: every route is a file in out/, and no page is rendered on request", async () => {
    expect((await readJson(path.join(app, ".next", "export-detail.json"), exportSchema)).success).toBe(true);
    const routes = Object.values(await readJson(path.join(app, ".next", "app-path-routes-manifest.json"), routesSchema));
    const prerender = await readJson(path.join(app, ".next", "prerender-manifest.json"), prerenderSchema);
    for (const route of routes) {
      if (route.includes("[")) {
        // A dynamic route is exported only for its listed pages, never rendered on demand.
        expect(prerender.dynamicRoutes[route]?.fallback, route).toBe(false);
        continue;
      }
      if (route.startsWith("/_")) {
        continue;
      }
      const file = route.startsWith("/api/") ? path.join(out, route) : path.join(out, route, "index.html");
      expect(await exists(file), `${route} has no file in out/`).toBe(true);
    }
    for (const slug of await pageSlugs()) {
      expect(await exists(path.join(out, "docs", slug, "index.html")), `docs/${slug} was not exported`).toBe(true);
    }
    for (const repoPage of ["development", "agents-domain", "agents-issue-tracker", "agents-triage-labels"]) {
      expect(await exists(path.join(out, "docs", "contributing", repoPage, "index.html")), repoPage).toBe(true);
    }
  });

  it("F-058/c1: the search index is built with the export, as a static file holding the pages and the settings", async () => {
    const index = await readFile(path.join(out, "api", "search"), "utf8");
    expect(JSON.parse(index)).toMatchObject({ type: "advanced" });
    expect(index).toContain("/docs/install/docker-compose");
    expect(index).toContain("OSTRA_JOIN_TOKEN_FILE");
  });

  it("F-058/c1: the search index holds plain text, and every heading a text record sits under is in the headings file, as written", async () => {
    // The index and the headings file are the export's own files; only the fields read here are checked.
    const recordSchema = z.looseObject({ type: z.string(), url: z.string(), content: z.string() });
    const indexSchema = z.looseObject({ docs: z.looseObject({ docs: z.record(z.string(), recordSchema) }) });
    const records = Object.values((await readJson(path.join(out, "api", "search"), indexSchema)).docs.docs);
    const headings = await readJson(path.join(out, "api", "search-headings"), z.record(z.string(), z.string()));
    expect(records.length).toBeGreaterThan(500);
    for (const record of records) {
      // Bold marks around words, backticks, alert markers, link targets, quote and table lines. A glob
      // such as `**/migrations/**` is text, and stays.
      expect(record.content, `${record.url} keeps Markdown in the index`).not.toMatch(
        /(^|\s)\*\*[\w`]|[\w`]\*\*($|[\s.,;:])|`|^> |\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]|\]\(|^\|/m,
      );
      if (record.type === "text" && record.url.includes("#")) {
        expect(headings[record.url], `${record.url} has no heading in api/search-headings`).toBeDefined();
      }
      if (record.type === "heading") {
        expect(headings[record.url], record.url).toBe(record.content);
      }
    }
    expect(headings["/docs/install/setup#connect-a-runner"]).toBe("6. Connect a runner");
    const token = records.filter((record) => record.url === "/docs/runners/pools#make-a-join-token" && record.type === "text");
    expect(token.map((record) => record.content).join("\n")).toContain("Select the pool, then New token under Join tokens.");
  });

  it("F-058/c1: the configuration reference page lists every setting of docs/configuration.md, with its default", async () => {
    const html = await readFile(path.join(out, "docs", "reference", "configuration", "index.html"), "utf8");
    const rows = settingsOf(parseConfigurationReference(await readFile(path.join(app, "..", "..", "docs", "configuration.md"), "utf8")));
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      const start = html.indexOf(`<tr id="${row.name}"`);
      expect(start, `${row.name} has no row on the page`).toBeGreaterThan(-1);
      const cell = /<td class="setting-default"[^>]*>([\s\S]*?)<\/td>/.exec(html.slice(start))?.[1] ?? "";
      const shown = cell.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const expected = row.defaultValue.replace(/[`*]/g, "").replace(/^\((required|none)\)$/, "$1");
      expect(shown, row.name).toBe(expected);
    }
  });

  it("F-058/c1: the agent, using, security, reference and contributing pages are written, built, and linked from their section", async () => {
    const metaSchema = z.looseObject({ pages: z.array(z.string()) });
    for (const section of ["agents-and-models", "using-ostra", "security", "reference", "contributing"]) {
      const { pages } = await readJson(path.join(app, "content", section, "meta.json"), metaSchema);
      expect(pages.length, section).toBeGreaterThan(1);
      const first = await readFile(path.join(out, "docs", section, pages[0] ?? "", "index.html"), "utf8");
      for (const page of pages) {
        const html = await readFile(path.join(out, "docs", section, page, "index.html"), "utf8");
        expect(html, `docs/${section}/${page} is still a skeleton`).not.toContain("This page is a skeleton");
        expect(first, `docs/${section}'s navigation doesn't link ${page}`).toMatch(new RegExp(`href="[^"]*/docs/${section}/${page}/?"`));
      }
    }
  });
});
