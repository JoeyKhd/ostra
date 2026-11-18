// A small queue a producer pushes into and one consumer awaits: how the hub's synchronous
// deliveries (called on its tick) become the values a subscription's generator yields. A consumer
// that falls behind by more than `capacity` items is told so (`overflowed`) rather than holding
// the server's memory: its stream ends, and it reconnects and resumes by sequence number.

export type QueueNext<T> =
  | { readonly kind: "item"; readonly item: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export type AsyncQueue<T> = {
  /** Adds an item. `false` once the queue has overflowed: the item was dropped. */
  readonly push: (item: T) => boolean;
  /** The next item, or `timeout` after `timeoutMs` with none, or `aborted` when the signal fires. */
  readonly next: (signal: AbortSignal, timeoutMs: number) => Promise<QueueNext<T>>;
  readonly overflowed: () => boolean;
  readonly size: () => number;
};

export const createAsyncQueue = <T>(capacity: number): AsyncQueue<T> => {
  const items: T[] = [];
  let overflow = false;
  let waiter: ((value: QueueNext<T>) => void) | null = null;

  return {
    overflowed: () => overflow,
    size: () => items.length,
    push: (item) => {
      if (overflow) {
        return false;
      }
      if (waiter !== null) {
        const resolve = waiter;
        waiter = null;
        resolve({ kind: "item", item });
        return true;
      }
      if (items.length >= capacity) {
        overflow = true;
        items.length = 0;
        return false;
      }
      items.push(item);
      return true;
    },
    next: (signal, timeoutMs) => {
      const queued = items.shift();
      if (queued !== undefined) {
        return Promise.resolve({ kind: "item", item: queued });
      }
      if (overflow) {
        return Promise.resolve({ kind: "timeout" });
      }
      if (signal.aborted) {
        return Promise.resolve({ kind: "aborted" });
      }
      return new Promise<QueueNext<T>>((resolve) => {
        const finish = (value: QueueNext<T>): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          waiter = null;
          resolve(value);
        };
        const onAbort = (): void => {
          finish({ kind: "aborted" });
        };
        const timer = setTimeout(() => {
          finish({ kind: "timeout" });
        }, timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        waiter = (value) => {
          finish(value);
        };
      });
    },
  };
};
