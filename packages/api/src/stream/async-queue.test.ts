import { describe, expect, it } from "vitest";

import { createAsyncQueue } from "./async-queue.ts";

const forever = new AbortController().signal;

describe("the async queue", () => {
  it("hands items out in order, and an item pushed while waiting goes straight to the waiter", async () => {
    const queue = createAsyncQueue<number>(10);
    queue.push(1);
    queue.push(2);
    expect(await queue.next(forever, 50)).toEqual({ kind: "item", item: 1 });
    expect(await queue.next(forever, 50)).toEqual({ kind: "item", item: 2 });
    const waiting = queue.next(forever, 1000);
    queue.push(3);
    expect(await waiting).toEqual({ kind: "item", item: 3 });
  });

  it("times out with nothing to give, and wakes when its signal fires", async () => {
    const queue = createAsyncQueue<number>(10);
    expect(await queue.next(forever, 20)).toEqual({ kind: "timeout" });
    const controller = new AbortController();
    const waiting = queue.next(controller.signal, 5000);
    controller.abort();
    expect(await waiting).toEqual({ kind: "aborted" });
  });

  it("overflows rather than holding unbounded memory: the consumer is told, and later items are dropped", async () => {
    const queue = createAsyncQueue<number>(3);
    expect([1, 2, 3, 4].map((item) => queue.push(item))).toEqual([true, true, true, false]);
    expect(queue.overflowed()).toBe(true);
    expect(queue.size()).toBe(0);
    expect(queue.push(5)).toBe(false);
    expect(await queue.next(forever, 20)).toEqual({ kind: "timeout" });
  });
});
