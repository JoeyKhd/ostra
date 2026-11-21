import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import { extractText } from "./extract.ts";
import { isDocumentKind } from "./kinds.ts";
import type { TextReadLimits } from "./limits.ts";
import type { WorkerAnswer, WorkerRequest } from "./messages.ts";
import { textFailed } from "./result.ts";
import { sealScope } from "./seal.ts";

// The text worker (F-150/c2): one of the pool's threads, with its own heap limit, reading one
// document at a time and answering its text or the reason. It imports only the readers and their
// three libraries (no schema library, no core module), so it starts small. The pool checks what it
// answers (`messages.ts`); here a request is narrowed by hand, since it comes from the pool alone.

let refusedCalls = 0;
sealScope(globalThis, () => {
  refusedCalls += 1;
});

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const limitsOf = (value: unknown): TextReadLimits | null => {
  const zipEntriesMax: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "zipEntriesMax") : undefined;
  const zipInflatedBytesMax: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "zipInflatedBytesMax") : undefined;
  const textMaxBytes: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "textMaxBytes") : undefined;
  return isNumber(zipEntriesMax) && isNumber(zipInflatedBytesMax) && isNumber(textMaxBytes) ? { zipEntriesMax, zipInflatedBytesMax, textMaxBytes } : null;
};

/** A request from the pool, or `null` when it isn't one. */
const requestOf = (message: unknown): WorkerRequest | null => {
  if (typeof message !== "object" || message === null || Reflect.get(message, "type") !== "read") {
    return null;
  }
  const id: unknown = Reflect.get(message, "id");
  const bytes: unknown = Reflect.get(message, "bytes");
  const kind: unknown = Reflect.get(message, "kind");
  const name: unknown = Reflect.get(message, "name");
  const limits = limitsOf(Reflect.get(message, "limits"));
  if (!isNumber(id) || !(bytes instanceof Uint8Array) || !isDocumentKind(kind) || typeof name !== "string" || limits === null) {
    return null;
  }
  return { type: "read", id, bytes, kind, name, limits };
};

const answer = (port: MessagePort, message: WorkerAnswer): void => {
  port.postMessage(message);
};

const serve = (port: MessagePort): void => {
  port.on("message", (message: unknown) => {
    const request = requestOf(message);
    if (request === null) {
      return;
    }
    const before = refusedCalls;
    void extractText({ bytes: request.bytes, kind: request.kind, name: request.name }, request.limits)
      .catch(() => textFailed("damaged"))
      .then((result) => {
        answer(port, { type: "result", id: request.id, result, refusedCalls: refusedCalls - before });
      });
  });
  answer(port, { type: "ready" });
};

if (parentPort !== null) {
  serve(parentPort);
}
