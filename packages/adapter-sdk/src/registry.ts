import type { AgentAdapter } from "./agent/base.ts";
import type { BlobStoreAdapter } from "./blob-store/base.ts";
import type { CodeHostAdapter } from "./code-host/base.ts";
import type { ExecutorAdapter } from "./executor/base.ts";
import type { ModelProviderAdapter } from "./model-provider/base.ts";
import type { NotificationAdapter } from "./notification/base.ts";
import type { SecretStoreAdapter } from "./secret-store/base.ts";
import type { TrackerAdapter } from "./tracker/base.ts";

// The registry (ADR 0025): adapters register by kind and name, and a lookup by kind returns that
// kind's base class, typed. The server and the runner each hold one.

/** Every kind's base class, by its `kind`. */
export type AdapterByKind = {
  readonly tracker: TrackerAdapter;
  readonly "code-host": CodeHostAdapter;
  readonly agent: AgentAdapter;
  readonly executor: ExecutorAdapter;
  readonly "model-provider": ModelProviderAdapter;
  readonly notification: NotificationAdapter;
  readonly "secret-store": SecretStoreAdapter;
  readonly "blob-store": BlobStoreAdapter;
};

export type AdapterKind = keyof AdapterByKind;
export type AnyAdapter = AdapterByKind[AdapterKind];

export const adapterKinds = [
  "tracker",
  "code-host",
  "agent",
  "executor",
  "model-provider",
  "notification",
  "secret-store",
  "blob-store",
] as const satisfies readonly AdapterKind[];

/** Each kind's capabilities, for the panel and the scheduler. */
export type CapabilitiesOf<K extends AdapterKind> = AdapterByKind[K]["capabilities"];

export type AdapterRegistry = {
  /** Registers an adapter under its kind and name. A second adapter with the same name is refused. */
  readonly register: <K extends AdapterKind>(adapter: AdapterByKind[K] & { readonly kind: K }) => void;
  readonly get: <K extends AdapterKind>(kind: K, name: string) => AdapterByKind[K] | undefined;
  readonly list: <K extends AdapterKind>(kind: K) => readonly AdapterByKind[K][];
};

type Stores = { readonly [K in AdapterKind]: Map<string, AdapterByKind[K]> };

export const createAdapterRegistry = (): AdapterRegistry => {
  const stores: Stores = {
    tracker: new Map(),
    "code-host": new Map(),
    agent: new Map(),
    executor: new Map(),
    "model-provider": new Map(),
    notification: new Map(),
    "secret-store": new Map(),
    "blob-store": new Map(),
  };
  const storeOf = <K extends AdapterKind>(kind: K): Stores[K] => stores[kind];
  return {
    register: (adapter) => {
      const store = storeOf(adapter.kind);
      if (store.has(adapter.name)) {
        throw new Error(`a ${adapter.kind} adapter named ${adapter.name} is already registered`);
      }
      store.set(adapter.name, adapter);
    },
    get: (kind, name) => storeOf(kind).get(name),
    list: (kind) => [...storeOf(kind).values()],
  };
};
