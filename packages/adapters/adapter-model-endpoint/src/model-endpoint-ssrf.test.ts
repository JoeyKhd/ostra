import http from "node:http";
import type { AddressInfo } from "node:net";

import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { ModelEndpointAdapter } from "./model-endpoint-adapter.ts";

// The adapter refuses a private base URL by default, on every call that reaches out, and connects
// to the address it vetted (so a name that answers differently the second time gains nothing).

const TOKEN = "sk-ssrf-test-token-0123456789";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A model server on loopback that records the Host header of each request. */
const listen = async (): Promise<{ readonly port: number; readonly hits: string[] }> => {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.headers.host ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "m1", object: "model" }] }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address: AddressInfo | string | null = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, hits };
};

describe("the model endpoint adapter, against private targets", () => {
  it("refuses a loopback base URL by default, in testConnection and listModels, without reaching it", async () => {
    const target = await listen();
    const adapter = new ModelEndpointAdapter({ timeoutMs: 2000 }, memoryAdapterContext());
    const baseUrl = `http://127.0.0.1:${String(target.port)}/v1`;
    const tested = await adapter.testConnection({ baseUrl, token: TOKEN });
    expect(tested.ok).toBe(false);
    if (!tested.ok) {
      expect(tested.error.code).toBe("invalid-input");
      expect(tested.error.message).toContain("private address refused");
    }
    const listed = await adapter.listModels({ baseUrl, token: TOKEN, apiFormat: "openai-compatible" });
    expect(listed).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(target.hits).toEqual([]);
  });

  it("gives the same answer for a closed port and an open one, so it is not a port probe", async () => {
    const adapter = new ModelEndpointAdapter({ timeoutMs: 2000 });
    const open = await listen();
    const answers = await Promise.all(
      [open.port, 1].map((port) => adapter.testConnection({ baseUrl: `http://127.0.0.1:${String(port)}/v1`, token: TOKEN })),
    );
    expect(answers[0]).toEqual(answers[1]);
  });

  it("refuses the metadata service, an internal name and a private range", async () => {
    const adapter = new ModelEndpointAdapter({ timeoutMs: 2000 });
    for (const baseUrl of [
      "http://169.254.169.254/latest",
      "http://metadata.google.internal/v1",
      "http://192.168.1.10/v1",
      "http://[::ffff:7f00:1]/v1",
      "http://localhost:8787/v1",
    ]) {
      expect(await adapter.testConnection({ baseUrl, token: TOKEN })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    const target = await listen();
    const adapter = new ModelEndpointAdapter({ resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]) });
    expect(await adapter.testConnection({ baseUrl: `http://models.example.com:${String(target.port)}/v1`, token: TOKEN })).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
    expect(target.hits).toEqual([]);
  });

  it("connects to the address it vetted, after one lookup, with the URL's own host in the Host header", async () => {
    // Private targets are allowed here only so the vetted address can be this test's loopback server.
    // A second lookup would answer with an unroutable address and fail: it is never made.
    const target = await listen();
    let lookups = 0;
    const adapter = new ModelEndpointAdapter({
      allowPrivateNetwork: true,
      resolve: () => {
        lookups += 1;
        return Promise.resolve(lookups === 1 ? [{ address: "127.0.0.1", family: 4 as const }] : [{ address: "192.0.2.1", family: 4 as const }]);
      },
    });
    const tested = await adapter.testConnection({
      baseUrl: `http://models.example.com:${String(target.port)}/v1`,
      token: TOKEN,
      authScheme: "bearer",
    });
    expect(tested).toMatchObject({ ok: true, value: { apiFormat: "openai-compatible", models: [{ endpointModelId: "m1" }] } });
    expect(lookups).toBe(1);
    expect(target.hits).toEqual([`models.example.com:${String(target.port)}`]);
  });

  it("reaches a private target when the network is allowed", async () => {
    const target = await listen();
    const adapter = new ModelEndpointAdapter({ allowPrivateNetwork: true });
    expect(await adapter.testConnection({ baseUrl: `http://127.0.0.1:${String(target.port)}/v1`, token: TOKEN })).toMatchObject({ ok: true });
    expect(target.hits).toHaveLength(1);
  });
});
