import { mappedStatusId } from "@ostra/adapter-sdk";
import type { AdapterResult, StatusMapping, TrackerAdapter, TrackerStatus } from "@ostra/adapter-sdk";
import type { ExternalTicketId } from "@ostra/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LINEAR_MAX_COMPLEXITY } from "./complexity.ts";
import { LinearAdapter } from "./linear-adapter.ts";

// Live, against the test workspace `ostra-test`, team OST (spec section 8, ticket 07). It runs only
// with `linear.env` loaded (`set -a; . ~/.config/ostra-dev/linear.env; set +a`) and skips
// otherwise. It creates one ticket, works it the way ticket sync does, and archives it at the end,
// whatever happened. It prints no key: failures name codes, never the token.

const env = z.object({ LINEAR_API_KEY: z.string().min(1), LINEAR_TEST_TEAM_ID: z.string().min(1) }).safeParse(process.env);

const API_URL = "https://api.linear.app/graphql";
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const must = <T,>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

/** A test tool's own call, with the maintainer's key: what a person does in Linear, outside ostra. */
const raw = async (token: string, query: string, variables: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const body: unknown = await response.json();
  const parsed = z.looseObject({ data: z.unknown(), errors: z.array(z.unknown()).nullish() }).parse(body);
  if (!response.ok || (parsed.errors?.length ?? 0) > 0) {
    throw new Error(`Linear refused a test call (HTTP ${String(response.status)})`);
  }
  return parsed.data;
};

/** Uploads an image the way Linear's editor does, and answers its asset URL. */
const uploadImage = async (token: string): Promise<string> => {
  const data = await raw(
    token,
    'mutation ($size: Int!) { fileUpload(contentType: "image/png", filename: "ostra-live.png", size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }',
    { size: PNG.length },
  );
  const { uploadFile } = z
    .object({
      fileUpload: z.object({
        uploadFile: z.object({ uploadUrl: z.string(), assetUrl: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })) }),
      }),
    })
    .parse(data).fileUpload;
  const headers: Record<string, string> = { "content-type": "image/png", "cache-control": "public, max-age=31536000" };
  for (const header of uploadFile.headers) {
    headers[header.key] = header.value;
  }
  const put = await fetch(uploadFile.uploadUrl, { method: "PUT", headers, body: PNG });
  if (!put.ok) {
    throw new Error(`the image upload failed (HTTP ${String(put.status)})`);
  }
  return uploadFile.assetUrl;
};

/** The default mapping (spec section 3, step 2), as the domain's draft makes it. */
const defaultMapping = (statuses: readonly TrackerStatus[]): StatusMapping => {
  const started = statuses.filter((status) => status.category === "started");
  const plain = started.find((status) => !/review/i.test(status.name)) ?? started[0];
  const done = statuses.find((status) => status.category === "done");
  if (plain === undefined || done === undefined) {
    throw new Error("the test team has no started or done status");
  }
  const review = started.find((status) => /review/i.test(status.name)) ?? plain;
  return { started: plain.id, inReview: review.id, done: done.id };
};

describe.skipIf(!env.success)("the Linear adapter, live on ostra-test (team OST)", () => {
  const created: ExternalTicketId[] = [];
  const complexities: number[] = [];

  afterAll(async () => {
    vi.restoreAllMocks();
    if (!env.success) return;
    for (const id of created) {
      await raw(env.data.LINEAR_API_KEY, "mutation ($id: String!) { issueArchive(id: $id) { success } }", { id });
    }
  });

  it("works a ticket the way ticket sync does, and every query stays under Linear's complexity cap", async () => {
    if (!env.success) return;
    const token = env.data.LINEAR_API_KEY;
    const board = { externalId: env.data.LINEAR_TEST_TEAM_ID };
    // Every answer the adapter gets says what its query cost.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      const cost = Number(response.headers.get("x-complexity") ?? Number.NaN);
      if (Number.isFinite(cost)) complexities.push(cost);
      return response;
    });
    const adapter: TrackerAdapter = new LinearAdapter({ auth: { kind: "api-key", token } });
    expect(await adapter.health()).toEqual({ status: "ok" });

    const boards = must(await adapter.listBoards(), "listBoards");
    expect(boards.find((one) => one.externalId === board.externalId)?.key).toBe("OST");
    const statuses = must(await adapter.listStatuses(board), "listStatuses");
    const mapping = defaultMapping(statuses);

    // A ticket with an image, then a comment, as a person makes one.
    const before = Date.now() - 5000;
    const assetUrl = await uploadImage(token);
    const ticket = must(
      await adapter.createTicket(board, {
        title: "ostra live test: tickets and writes",
        description: `Fix the \`$(whoami)\` banner.\n\n![ostra-live.png](${assetUrl})`,
      }),
      "createTicket",
    );
    created.push(ticket.externalId);
    expect(ticket.key.startsWith("OST-")).toBe(true);
    const ref = { externalId: ticket.externalId };
    await raw(token, "mutation ($issueId: String!) { commentCreate(input: { issueId: $issueId, body: \"A person's comment\" }) { success } }", {
      issueId: ticket.externalId,
    });

    const context = must(await adapter.getTicketContext(board, ref), "getTicketContext");
    expect(context.ticket.description).toContain("Fix the `$(whoami)` banner.");
    expect(context.comments.map((comment) => comment.body)).toContain("A person's comment");
    expect(context.images).toHaveLength(1);
    const image = context.images[0];
    if (image === undefined) throw new Error("no image");
    const file = must(await adapter.downloadFile(image.url, 10 * 1024 * 1024), "downloadFile");
    expect(Buffer.from(file.bytes).equals(PNG)).toBe(true);
    expect(await adapter.downloadFile(image.url, 10)).toMatchObject({ ok: false, error: { code: "invalid-input" } });

    // Polling finds it, oldest change first, a page at a time.
    const listed = must(await adapter.listTickets({ board, updatedSince: before, order: "updatedAt", pageSize: 250 }), "listTickets");
    expect(listed.tickets.map((one) => one.externalId)).toContain(ticket.externalId);
    const times = listed.tickets.map((one) => one.updatedAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const firstPage = must(await adapter.listTickets({ board, order: "updatedAt", pageSize: 2 }), "listTickets, a small page");
    if (firstPage.nextCursor !== null) {
      const nextPage = must(await adapter.listTickets({ board, order: "updatedAt", pageSize: 2, cursor: firstPage.nextCursor }), "the next page");
      const ids = [...firstPage.tickets, ...nextPage.tickets].map((one) => one.externalId);
      expect(new Set(ids).size).toBe(ids.length);
      const all = must(await adapter.listTickets({ board, order: "updatedAt", pageSize: ids.length }), "listTickets, one page");
      expect(all.tickets.map((one) => one.externalId)).toEqual(ids);
    }

    // Through the default mapping; a step it's already at writes nothing.
    for (const target of ["started", "in-review", "done"] as const) {
      const current = must(await adapter.getTicket(board, ref), "getTicket").status.id;
      const moved = must(await adapter.moveTicket(board, ref, target, mapping), `moveTicket ${target}`);
      expect(moved.moved).toBe(current !== mappedStatusId(mapping, target));
      expect(moved.status.id).toBe(mappedStatusId(mapping, target));
      expect(must(await adapter.moveTicket(board, ref, target, mapping), `moveTicket ${target} again`).moved).toBe(false);
    }

    // The progress comment, edited in place.
    const { commentId } = must(await adapter.comment(board, ticket.key, "ostra is working on this"), "comment");
    must(await adapter.updateComment(board, ref, commentId, "ostra opened a PR"), "updateComment");
    const afterEdit = must(await adapter.getTicketContext(board, ref), "getTicketContext after the edit");
    expect(afterEdit.comments.filter((comment) => comment.id === commentId).map((comment) => comment.body)).toEqual(["ostra opened a PR"]);

    // The task link, twice: one attachment, with the second subtitle.
    const link = { url: `https://ostra.example.test/tasks/live-${ticket.externalId}`, title: "ostra task", subtitle: "Running" };
    const first = must(await adapter.linkTask(board, ref, link), "linkTask");
    const second = must(await adapter.linkTask(board, ref, { ...link, subtitle: "In review" }), "linkTask again");
    expect(second.attachmentId).toBe(first.attachmentId);
    const links = must(await adapter.getTicketContext(board, ref), "getTicketContext after the links").attachments.filter(
      (one) => one.url === link.url,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.subtitle).toBe("In review");

    // ostra-test has no GitHub integration (ticket 40).
    expect(must(await adapter.detectCodeHostIntegration(board), "detectCodeHostIntegration").installed).toBe(false);
    expect(complexities.length).toBeGreaterThan(0);
    expect(Math.max(...complexities)).toBeLessThan(LINEAR_MAX_COMPLEXITY);
  }, 120_000);
});
