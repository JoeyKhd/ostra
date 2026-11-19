import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CatalogEntry } from "@ostra/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogoServer, logoIdOf, PLAIN_MARK } from "./model-logos";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

const entry = (logoPath: string | null): CatalogEntry => ({
  catalogId: "model",
  name: "Model",
  aliases: [],
  contextWindow: null,
  maxOutputTokens: null,
  inputPricePerMTok: null,
  outputPricePerMTok: null,
  logoPath,
});
const catalog = (...paths: (string | null)[]) => ({ entries: () => Promise.resolve(paths.map(entry)) });

let dataDir = "";
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-logos-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const okFetch = () => vi.fn<typeof fetch>(() => Promise.resolve(new Response(svg)));

describe("logoIdOf", () => {
  it("accepts a well-formed file name only", () => {
    expect(logoIdOf("openai.svg")).toBe("openai");
    expect(logoIdOf("../x.svg")).toBeNull();
    expect(logoIdOf("openai.png")).toBeNull();
  });
});

describe("createLogoServer", () => {
  it("fetches a listed id once, keeps it, and serves it from disk after", async () => {
    const fetchImpl = okFetch();
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg"), dataDir, fetchEnabled: true, fetchImpl });
    expect(await server.logo("openai")).toEqual({ svg, found: true });
    expect(await server.logo("openai")).toEqual({ svg, found: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://models.dev/logos/openai.svg");
    expect(await readFile(path.join(dataDir, "model-logos", "openai.svg"), "utf8")).toBe(svg);
  });

  it("answers the plain mark, with no fetch, for an id the catalog doesn't list", async () => {
    const fetchImpl = okFetch();
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg", null), dataDir, fetchEnabled: true, fetchImpl });
    for (const id of ["anthropic", "made-up-1", "made-up-2"]) {
      expect(await server.logo(id)).toEqual({ svg: PLAIN_MARK, found: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads an encoded logoPath", async () => {
    const fetchImpl = okFetch();
    const server = createLogoServer({ catalog: catalog("/model-logos/a.b-c.svg"), dataDir, fetchEnabled: true, fetchImpl });
    expect((await server.logo("a.b-c")).found).toBe(true);
  });

  it("remembers a failed fetch for an hour, then tries again", async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error("offline")));
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg"), dataDir, fetchEnabled: true, fetchImpl, now: () => clock });
    expect((await server.logo("openai")).found).toBe(false);
    expect((await server.logo("openai")).found).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 60 * 60 * 1000 + 1;
    fetchImpl.mockImplementation(() => Promise.resolve(new Response(svg)));
    expect(await server.logo("openai")).toEqual({ svg, found: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a refusal or a non-SVG body as a failure too", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("<html></html>")));
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg"), dataDir, fetchEnabled: true, fetchImpl });
    await server.logo("openai");
    await server.logo("openai");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one fetch between requests that arrive together", async () => {
    const fetchImpl = okFetch();
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg"), dataDir, fetchEnabled: true, fetchImpl });
    await Promise.all([server.logo("openai"), server.logo("openai"), server.logo("openai")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never fetches with the catalog fetch off, but serves a kept logo", async () => {
    await mkdir(path.join(dataDir, "model-logos"), { recursive: true });
    await writeFile(path.join(dataDir, "model-logos", "openai.svg"), svg);
    const fetchImpl = okFetch();
    const server = createLogoServer({ catalog: catalog("/model-logos/openai.svg", "/model-logos/other.svg"), dataDir, fetchEnabled: false, fetchImpl });
    expect((await server.logo("openai")).found).toBe(true);
    expect((await server.logo("other")).found).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
