import type { ApiFormat } from "@ostra/protocol";

/** What a model provider adapter can do (ADR 0025, ADR 0033). */
export type ModelProviderCapabilities = {
  /** The API formats it can test and talk to. */
  readonly apiFormats: readonly ApiFormat[];
  /** The endpoint lists its models, so "Test connection" can show them. */
  readonly modelList: boolean;
  /** Streamed answers report token usage, so the key proxy counts without estimating (F-089). */
  readonly usageInStream: boolean;
};
