import type pg from "pg";

// Every table of this spike lives in its own schema, so a Postgres you point
// it at (SPIKE_DATABASE_URL) never loses a table that isn't the spike's: the
// harness drops and recreates this one schema, nothing else.
export const SPIKE_SCHEMA = "spike_runner_transport";

/** Connection settings for every pool and client: the spike's schema first on the search path. */
export const pgConfig = (connectionString: string): pg.ClientConfig => ({
  connectionString,
  options: `-c search_path=${SPIKE_SCHEMA}`,
});
