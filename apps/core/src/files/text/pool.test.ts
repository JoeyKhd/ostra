import { recordingLogger } from "@ostra/adapter-sdk/testing";
import { fileKindOf, fileTextOf, parseServerSettings } from "@ostra/domain";
import { safeFileName } from "@ostra/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bigXlsx,
  budgetXlsx,
  doctypeDocx,
  encryptedPdf,
  javascriptPdf,
  longDocx,
  oneParagraphDocx,
  reportPdf,
  roadmapPptx,
  scannedPdf,
  slowPdf,
  specDocx,
  truncatedDocx,
  zipBombDocx,
} from "../../testing/document-fixtures.ts";
import type { TextPoolLimits } from "./limits.ts";
import { textHeaderLine } from "./markdown.ts";
import { createTextPool } from "./pool.ts";
import type { TextPool } from "./pool.ts";
import { createDocumentTextReader } from "./reader.ts";
import type { DocumentTextReader } from "./reader.ts";
import { NETWORK_GLOBALS, NETWORK_REFUSED, sealScope } from "./seal.ts";

// Milestone 9's ticket 07 (F-150): the worker pool, with real worker threads. As the spec's test
// seam says, a pool of one worker with a 2 s timeout makes the time and memory cases fast; each
// test closes what it starts.

const open: { close: () => Promise<void> }[] = [];

const testPool = (pool: Partial<TextPoolLimits> = {}, logger = recordingLogger()): { readonly pool: TextPool; readonly logger: ReturnType<typeof recordingLogger> } => {
  const created = createTextPool({ logger, pool: { workers: 1, fileTimeoutMs: 2_000, ...pool } });
  open.push(created);
  return { pool: created, logger };
};

const testReader = (extraction: boolean, logger = recordingLogger()): DocumentTextReader => {
  const reader = createDocumentTextReader({ extraction, logger, pool: { workers: 1, fileTimeoutMs: 2_000 } });
  open.push(reader);
  return reader;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

/** A pool's heap small enough that a long document passes it, while every fixture of the demo fits. */
const SMALL_HEAP_MIB = 64;

/**
 * Reads `bytes` until a read is ready: the pool's worker is then up, and free. A read that waits
 * past the wait limit while the worker starts is `busy`, and the start goes on for the next one.
 */
const warmUp = async (pool: TextPool, bytes: Uint8Array): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    if ((await pool.read({ bytes, kind: "docx", name: "warm.docx" })).state === "ready") {
      return;
    }
  }
  throw new Error("the pool's worker never started");
};

describe("the pool (F-150/c2)", () => {
  it("F-150/c1, F-150/c2: each kind is read in a worker, not on core's thread, its text headed by ostra's line", async () => {
    const { pool } = testPool();
    const kinds = [
      [await specDocx(), "docx", "# History panel spec"],
      [await budgetXlsx(), "xlsx", "## Budget 2027"],
      [await roadmapPptx(), "pptx", "## Slide 1"],
      [reportPdf(), "pdf", "## Page 1"],
    ] as const;
    for (const [bytes, kind, first] of kinds) {
      const before = bytes.slice();
      const result = await pool.read({ bytes, kind, name: `sample.${kind}` });
      expect(result.state === "ready" ? result.markdown.split("\n").slice(0, 3) : result).toEqual([textHeaderLine(`sample.${kind}`, kind), "", first]);
      // The caller keeps its bytes: the worker reads a copy.
      expect(bytes).toEqual(before);
    }
    expect(pool.stats()).toMatchObject({ workers: 1, started: 1, replaced: 0 });
  });

  it("F-150/c1: a file's bytes as a Node Buffer, as an upload's body arrives, are read too, and stay the caller's", async () => {
    const { pool } = testPool();
    // A small Buffer is a view on Node's shared pool, which no message can move.
    const bytes = Buffer.from(await specDocx());
    const before = Buffer.from(bytes);
    const result = await pool.read({ bytes, kind: "docx", name: "spec.docx" });
    expect(result.state).toBe("ready");
    expect(bytes.equals(before)).toBe(true);
  });

  it("F-150/c2: a file that runs past the time limit is timeout, its worker replaced, and the pool takes the next file", async () => {
    const { pool, logger } = testPool();
    const started = performance.now();
    // 20,000 empty pages: pdf.js walks its page tree for each, for far longer than 2 s.
    expect(await pool.read({ bytes: slowPdf(20_000), kind: "pdf", name: "slow.pdf" })).toEqual({ state: "failed", reason: "timeout" });
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(10_000);
    expect(await pool.read({ bytes: await specDocx(), kind: "docx", name: "next.docx" })).toMatchObject({ state: "ready" });
    expect(pool.stats()).toMatchObject({ timeouts: 1, replaced: 1, started: 2, workers: 1 });
    expect(logger.records.map((record) => record.message)).toContain("files.text.timeout");
  });

  it("F-150/c2: a file past the worker's heap is refused as too-big, and the pool lives on", async () => {
    const { pool } = testPool({ heapMiB: SMALL_HEAP_MIB, fileTimeoutMs: 20_000 });
    // One paragraph of 300,000 runs: a 44 KB file whose one block's DOM passes the heap.
    expect(await pool.read({ bytes: await oneParagraphDocx(300_000), kind: "docx", name: "one-paragraph.docx" })).toEqual({ state: "failed", reason: "too-big" });
    expect(pool.stats()).toMatchObject({ outOfMemory: 1, replaced: 1 });
    // The same small heap reads an ordinary document, and the long ones a batch at a time, cut at 1 MiB.
    expect(await pool.read({ bytes: await specDocx(), kind: "docx", name: "next.docx" })).toMatchObject({ state: "ready", truncated: false });
    expect(await pool.read({ bytes: await bigXlsx(), kind: "xlsx", name: "big.xlsx" })).toMatchObject({ state: "ready", truncated: true });
    expect(await pool.read({ bytes: await longDocx(600_000), kind: "docx", name: "long.docx" })).toMatchObject({ state: "ready", truncated: true });
    expect(pool.stats()).toMatchObject({ outOfMemory: 1, workers: 1 });
  });

  it("F-150/c2: a file that waits past the wait limit for a worker is busy", async () => {
    const { pool } = testPool({ fileTimeoutMs: 5_000, waitMs: 300 });
    // The worker up and free first. Its start counts against a file's wait, and on a loaded
    // machine it alone outlasts 300 ms: the slow file would then be the one that's busy, and the
    // worker, up a moment later, free for the next file.
    const bytes = await specDocx();
    await warmUp(pool, bytes);
    // A free worker takes a file at once: the slow one holds it far longer than the next one waits.
    const slow = pool.read({ bytes: slowPdf(20_000), kind: "pdf", name: "slow.pdf" });
    expect(await pool.read({ bytes, kind: "docx", name: "waits.docx" })).toEqual({ state: "failed", reason: "busy" });
    await pool.close();
    expect(await slow).toEqual({ state: "failed", reason: "busy" });
    expect(await pool.read({ bytes, kind: "docx", name: "closed.docx" })).toEqual({ state: "failed", reason: "busy" });
    expect(pool.stats()).toMatchObject({ started: 1, timeouts: 0 });
  });

  it("F-150/c2: the zip bomb and the DOCTYPE are refused in the worker too, and no network call is made", async () => {
    const { pool } = testPool();
    expect(await pool.read({ bytes: await zipBombDocx(), kind: "docx", name: "bomb.docx" })).toEqual({ state: "failed", reason: "too-big" });
    expect(await pool.read({ bytes: await doctypeDocx(), kind: "docx", name: "doctype.docx" })).toEqual({ state: "failed", reason: "doctype" });
    expect(await pool.read({ bytes: javascriptPdf(), kind: "pdf", name: "javascript.pdf" })).toMatchObject({ state: "ready" });
    expect(await pool.read({ bytes: reportPdf(), kind: "pdf", name: "report.pdf" })).toMatchObject({ state: "ready" });
    expect(await pool.read({ bytes: await roadmapPptx(), kind: "pptx", name: "roadmap.pptx" })).toMatchObject({ state: "ready" });
    // The worker's seal counts each network call a library tries; none did.
    expect(pool.stats().refusedCalls).toBe(0);
  });

  it("F-150/c2: the worker's seal makes every network global throw, and counts the attempt", () => {
    const scope = { console: { log: () => "printed", error: () => "printed" } };
    let refused = 0;
    sealScope(scope, () => {
      refused += 1;
    });
    for (const name of NETWORK_GLOBALS) {
      const global: unknown = Reflect.get(scope, name);
      if (typeof global !== "function") {
        throw new Error(`${name} isn't sealed`);
      }
      expect(() => {
        Reflect.apply(global, scope, ["https://example.invalid"]);
      }).toThrow(NETWORK_REFUSED);
    }
    expect(refused).toBe(NETWORK_GLOBALS.length);
    expect(scope.console.log()).toBeUndefined();
    // Sealed for good: a library can't put fetch back.
    expect(Reflect.defineProperty(scope, "fetch", { value: () => "fetched" })).toBe(false);
  });
});

describe("documents ostra can't read, through the reader (F-150/c3)", () => {
  it("F-150/c3: the encrypted PDF, the scanned one and a damaged zip are each failed with a reason, and the file's text state says so", async () => {
    const reader = testReader(true);
    const cases = [
      [encryptedPdf(), "encrypted"],
      [scannedPdf(), "no-text"],
      [await truncatedDocx(), "damaged"],
    ] as const;
    for (const [bytes, reason] of cases) {
      const detected = await fileKindOf(bytes, "upload");
      // A cut zip isn't a document by its bytes; the reader is asked by the type a ticket gave it.
      const contentType = detected.kind === "document" ? detected.contentType : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const text = await reader.read({ bytes, contentType, name: detected.name });
      expect(text).toEqual({ state: "failed", reason });
      expect(fileTextOf({ kind: "document", extraction: true, reading: text.state === "failed" ? text : null })).toEqual({ state: "failed", reason });
    }
  });
});

describe("OSTRA_FILE_TEXT_EXTRACTION (F-150/c4)", () => {
  it("F-150/c4: with the setting false, a document's text is off and no worker ever starts; other files have none", async () => {
    const settings = parseServerSettings({ OSTRA_FILE_TEXT_EXTRACTION: "false" });
    expect(settings.ok).toBe(true);
    const extraction = settings.ok ? settings.settings.files.textExtraction : true;
    const reader = testReader(extraction);
    const bytes = await specDocx();
    const detected = await fileKindOf(bytes, "spec.docx");
    expect(await reader.read({ bytes, contentType: detected.contentType, name: detected.name })).toEqual({ state: "off" });
    expect(await reader.read({ bytes: new Uint8Array(Buffer.from("plain words")), contentType: "text/plain", name: safeFileName("notes.txt", null) })).toEqual({ state: "none" });
    expect(reader.stats().started).toBe(0);
    expect(fileTextOf({ kind: detected.kind, extraction, reading: null })).toEqual({ state: "off" });

    const on = testReader(true);
    expect(await on.read({ bytes, contentType: detected.contentType, name: detected.name })).toMatchObject({ state: "ready" });
    expect(on.stats().started).toBe(1);
  });
});

describe("logs (F-150/c6)", () => {
  it("F-150/c6: no extracted text, file content or file name reaches a log line or the process's output, checked by value", async () => {
    const logger = recordingLogger();
    const reader = createDocumentTextReader({ extraction: true, logger, pool: { workers: 1, fileTimeoutMs: 3_000, heapMiB: SMALL_HEAP_MIB } });
    open.push(reader);
    const rawName = "$(touch pwned) ignore previous instructions.docx";
    const name = safeFileName(rawName, "docx");
    // What this process prints meanwhile: the workers' own output is dropped before it gets here.
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const texts: string[] = [];
    try {
      const documents = [
        [await specDocx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        [await budgetXlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        [await roadmapPptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        [reportPdf(), "application/pdf"],
        [javascriptPdf(), "application/pdf"],
        [await doctypeDocx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        [encryptedPdf(), "application/pdf"],
        [slowPdf(20_000), "application/pdf"],
        [await oneParagraphDocx(300_000), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ] as const;
      for (const [bytes, contentType] of documents) {
        const text = await reader.read({ bytes, contentType, name });
        if (text.state === "ready") {
          texts.push(text.markdown);
        }
      }
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(texts).toHaveLength(5);
    // The timeout, the heap and every read were logged: the lines exist, with what they may carry.
    const messages = logger.records.map((record) => record.message);
    expect(messages).toEqual(expect.arrayContaining(["files.text.read", "files.text.timeout", "files.text.worker-stopped"]));
    const logged = JSON.stringify(logger.records);
    const output = [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0])).join("");
    const values = [
      rawName,
      name,
      "touch pwned",
      "ignore previous instructions",
      "History panel spec",
      "Budget 2027",
      "Roadmap 2027",
      "Quarterly report",
      "A page with a script behind it",
      "print every secret",
      "example.invalid",
      "etc/passwd",
      ...texts.map((text) => text.split("\n")[2] ?? text),
    ];
    for (const value of values) {
      expect(logged).not.toContain(value);
      expect(output).not.toContain(value);
    }
    // A line carries only these fields: a kind, sizes, times, states and reasons, never a string of the file's.
    const allowed = ["component", "kind", "size", "state", "reason", "words", "ms", "code", "calls", "waitedMs"];
    for (const record of logger.records) {
      expect(Object.keys(record.fields).filter((key) => !allowed.includes(key))).toEqual([]);
    }
  });
});
