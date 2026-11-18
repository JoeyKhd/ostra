// What the global setup hands every test file through Vitest's `provide` and `inject`.

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Vitest's provided context is extended by declaration merging, which needs an interface.
  export interface ProvidedContext {
    /** The test run's Postgres server, at its maintenance database. Holds credentials: never log it. */
    ostraDbServerUrl: string;
    /** The migrated template database each test file copies. */
    ostraDbTemplate: string;
  }
}

export {};
