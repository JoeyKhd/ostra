import type { AuthScheme } from "@ostra/protocol";

/**
 * The headers that carry a model provider's token, by auth scheme (ADR 0033): `Authorization:
 * Bearer` for OpenAI-compatible endpoints, `x-api-key` with a version header for Anthropic's. The
 * key proxy swaps the task's fake key for these, and "Test connection" sends them.
 */
export const modelAuthHeaders = (scheme: AuthScheme, token: string): Readonly<Record<string, string>> => {
  switch (scheme) {
    case "bearer":
      return { authorization: `Bearer ${token}` };
    case "x-api-key":
      return { "x-api-key": token, "anthropic-version": "2023-06-01" };
    default:
      return scheme satisfies never;
  }
};
