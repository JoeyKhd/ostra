import { silentLogger } from "@ostra/adapter-sdk";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import { manualClock } from "@ostra/adapter-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { createCatalogSource } from "./catalog-source.ts";
import { createModelsDevCatalogSource } from "./models-dev.ts";

const entry = (catalogId: string): CatalogEntry => ({
  catalogId,
  name: catalogId,
  aliases: [catalogId],
  contextWindow: 1000,
  maxOutputTokens: 100,
  inputPricePerMTok: 1,
  outputPricePerMTok: 2,
  logoPath: null,
});

const bundled = [entry("bundled/one")];
const fresh = [entry("fresh/one"), entry("fresh/two")];

const setup = (over: { readonly fetchEnabled?: boolean; readonly fetchLatest?: () => Promise<readonly CatalogEntry[]> } = {}) => {
  const clock = manualClock();
  const fetchLatest = vi.fn(over.fetchLatest ?? (() => Promise.resolve(fresh)));
  const loadBundled = vi.fn(() => Promise.resolve(bundled));
  const source = createCatalogSource({
    fetchEnabled: over.fetchEnabled ?? true,
    loadBundled,
    fetchLatest,
    clock,
    logger: silentLogger,
    ttlMs: 1000,
    retryAfterFailureMs: 100,
  });
  return { clock, fetchLatest, loadBundled, source };
};

describe("the catalog source (F-088)", () => {
  it("fetches once and serves the copy until it is stale", async () => {
    const { source, fetchLatest, clock } = setup();
    expect(await source.entries()).toEqual(fresh);
    expect(await source.entries()).toEqual(fresh);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    clock.advance(1001);
    await source.entries();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between callers that arrive together", async () => {
    const { source, fetchLatest } = setup();
    await Promise.all([source.entries(), source.entries(), source.entries()]);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("makes no request at all when the fetch is off, and serves the bundled copy", async () => {
    const { source, fetchLatest, loadBundled, clock } = setup({ fetchEnabled: false });
    expect(await source.entries()).toEqual(bundled);
    clock.advance(10 * 24 * 60 * 60 * 1000);
    expect(await source.entries()).toEqual(bundled);
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(loadBundled).toHaveBeenCalledTimes(1);
  });

  it("serves the bundled copy when the first fetch fails, and tries again after a short wait", async () => {
    let fail = true;
    const { source, fetchLatest, clock } = setup({
      fetchLatest: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(fresh)),
    });
    expect(await source.entries()).toEqual(bundled);
    expect(await source.entries()).toEqual(bundled);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    fail = false;
    clock.advance(101);
    expect(await source.entries()).toEqual(fresh);
  });

  it("keeps the last good copy when a later fetch fails", async () => {
    let fail = false;
    const { source, clock } = setup({ fetchLatest: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(fresh)) });
    expect(await source.entries()).toEqual(fresh);
    fail = true;
    clock.advance(1001);
    expect(await source.entries()).toEqual(fresh);
  });

  it("never throws, even when the bundled copy is unreadable", async () => {
    const source = createCatalogSource({
      fetchEnabled: false,
      loadBundled: () => Promise.reject(new Error("no file")),
      fetchLatest: () => Promise.reject(new Error("never called")),
      clock: manualClock(),
      logger: silentLogger,
    });
    expect(await source.entries()).toEqual([]);
  });
});

describe("the models.dev source", () => {
  const payload = { acme: { id: "acme", name: "Acme", models: { "acme-1": { id: "acme-1", name: "Acme One", limit: { context: 8000, output: 800 }, cost: { input: 1, output: 2 } } } } };

  /** A fake fetch that records what it was asked. */
  const fakeFetch = (body: unknown) => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return Promise.resolve(Response.json(body));
    };
    return { calls, fetchFn };
  };

  it("asks models.dev with a plain GET that carries nothing about the install", async () => {
    const { calls, fetchFn } = fakeFetch(payload);
    const source = createModelsDevCatalogSource({ fetchEnabled: true, clock: manualClock(), logger: silentLogger, fetchFn });
    const entries = await source.entries();
    expect(entries.map((candidate) => candidate.catalogId)).toEqual(["acme/acme-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://models.dev/api.json");
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(Object.keys(calls[0]?.init?.headers ?? {})).toEqual(["accept"]);
    expect(calls[0]?.init).not.toHaveProperty("body");
    expect(calls[0]?.init).not.toHaveProperty("credentials");
  });

  it("refuses a copy that doesn't match, and serves the bundled one", async () => {
    const { fetchFn } = fakeFetch({ not: "a catalog" });
    const source = createModelsDevCatalogSource({ fetchEnabled: true, clock: manualClock(), logger: silentLogger, fetchFn });
    const entries = await source.entries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((candidate) => candidate.catalogId === "acme/acme-1")).toBe(false);
  });

  it("makes no request when the setting is off", async () => {
    const { calls, fetchFn } = fakeFetch(payload);
    const source = createModelsDevCatalogSource({ fetchEnabled: false, clock: manualClock(), logger: silentLogger, fetchFn });
    expect((await source.entries()).length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});
