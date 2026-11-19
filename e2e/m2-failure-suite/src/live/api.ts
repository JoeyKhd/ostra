import { randomUUID } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

// The panel's own API, called as the panel calls it (ticket 38): tRPC over HTTP at `/api/trpc`,
// with the signed-in admin's session cookie from the browser context. A case starts a task from a
// ticket and reopens it through the same procedures, access checks and transactions as a click.

const resultSchema = z.object({ result: z.object({ data: z.unknown() }) });
const errorSchema = z.object({ error: z.looseObject({ message: z.string(), data: z.looseObject({ code: z.string() }).optional() }) });

export type PanelApi = {
  readonly mutate: (procedure: string, input: unknown) => Promise<unknown>;
  readonly query: (procedure: string, input: unknown) => Promise<unknown>;
};

const unwrap = async (procedure: string, response: { readonly status: () => number; readonly json: () => Promise<unknown> }): Promise<unknown> => {
  const body: unknown = await response.json().catch(() => null);
  const ok = resultSchema.safeParse(body);
  if (ok.success) return ok.data.result.data;
  const error = errorSchema.safeParse(body);
  // A refusal: its tRPC code and message, never the input.
  if (error.success) throw new Error(`${procedure} refused (${error.data.error.data?.code ?? String(response.status())}): ${error.data.error.message}`);
  throw new Error(`${procedure} answered ${String(response.status())}`);
};

export const panelApi = (request: APIRequestContext, panelUrl: string): PanelApi => ({
  mutate: async (procedure, input) => unwrap(procedure, await request.post(`${panelUrl}/api/trpc/${procedure}`, { data: input, timeout: 120_000 })),
  query: async (procedure, input) =>
    unwrap(procedure, await request.get(`${panelUrl}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { timeout: 120_000 })),
});

/** A fresh client message ID, as the composer makes one. */
export const clientMessageId = (): string => randomUUID();
