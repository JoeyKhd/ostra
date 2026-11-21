// What the text worker seals before it reads anything (F-150/c2, F-150/c6): every way a library could
// reach the network from JavaScript (`fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`) throws,
// and the console says nothing, since a parser's warning can quote the document. Its process has no
// environment of core's (`env: {}` in `pool.ts`), and its stdout and stderr are dropped there.

/** The globals that would reach the network. */
export const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"] as const;

/** The console's methods that would print. */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table", "group", "groupCollapsed", "assert"] as const;

/** The error a sealed network global throws. */
export const NETWORK_REFUSED = "ostra's text reader makes no network call";

/**
 * Seals `scope` (the worker's `globalThis`): each network global throws, after `onRefused` counts
 * the attempt, and the console's methods do nothing.
 */
export const sealScope = (scope: object, onRefused: () => void): void => {
  const refuse = (): never => {
    onRefused();
    throw new Error(NETWORK_REFUSED);
  };
  for (const name of NETWORK_GLOBALS) {
    Object.defineProperty(scope, name, { value: refuse, writable: false, configurable: false, enumerable: false });
  }
  const console: unknown = Reflect.get(scope, "console");
  if (typeof console === "object" && console !== null) {
    for (const method of CONSOLE_METHODS) {
      Object.defineProperty(console, method, { value: () => undefined, writable: false, configurable: false });
    }
  }
};
