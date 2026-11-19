import { afterAll, beforeAll, expect, it } from "vitest";

import type { HealthReport } from "../common/result.ts";

// The cases every kind's contract suite starts with, and the shape every suite shares: a factory
// that builds the adapter and its fakes, run once per suite.

export type SuiteSubject<Adapter, Fixture> = {
  readonly adapter: Adapter;
  readonly fixture: Fixture;
  /** Cleans up the fakes (and, for a live run, what the suite created on the vendor). */
  readonly dispose?: () => Promise<void>;
};

export type ContractSuiteOptions<Adapter, Fixture> = {
  /** Shown in the suite's title: the adapter and the fakes it runs against. */
  readonly name: string;
  readonly create: () => Promise<SuiteSubject<Adapter, Fixture>>;
};

type CommonAdapter = {
  readonly kind: string;
  readonly name: string;
  readonly capabilities: object;
  readonly health: () => Promise<HealthReport>;
};

/** The suite's subject, set in `beforeAll`. Read it only inside a case. */
export const useSubject = <Adapter, Fixture>(
  options: ContractSuiteOptions<Adapter, Fixture>,
): (() => SuiteSubject<Adapter, Fixture>) => {
  let subject: SuiteSubject<Adapter, Fixture> | undefined;
  beforeAll(async () => {
    subject = await options.create();
  });
  afterAll(async () => {
    await subject?.dispose?.();
  });
  return () => {
    if (subject === undefined) {
      throw new Error("the suite's factory has not run");
    }
    return subject;
  };
};

/** Every kind: a kebab-case name, the right kind, every capability declared with the right type, a healthy check. */
export const defineCommonCases = <Adapter extends CommonAdapter>(
  subject: () => { readonly adapter: Adapter },
  kind: Adapter["kind"],
  capabilityTypes: Readonly<Record<keyof Adapter["capabilities"] & string, "boolean" | "string" | "array" | "object">>,
): void => {
  it("has a kebab-case name and its kind", () => {
    const { adapter } = subject();
    expect(adapter.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(adapter.kind).toBe(kind);
  });

  it("declares every capability, with its type", () => {
    const { adapter } = subject();
    const declared: unknown = adapter.capabilities;
    for (const [key, type] of Object.entries(capabilityTypes)) {
      const value: unknown = Reflect.get(Object(declared), key);
      if (type === "array") {
        expect(Array.isArray(value), `capability ${key} is a list`).toBe(true);
      } else if (type === "object") {
        expect(typeof value === "object" && value !== null && !Array.isArray(value), `capability ${key} is an object`).toBe(true);
      } else {
        expect(typeof value, `capability ${key} is a ${String(type)}`).toBe(type);
      }
    }
  });

  it("reports itself healthy against its fakes", async () => {
    expect(await subject().adapter.health()).toEqual({ status: "ok" });
  });
};
