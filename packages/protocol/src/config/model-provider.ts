import { z } from "zod";

import { apiFormatSchema, authSchemeSchema, httpUrlSchema } from "../common.ts";

// A model provider's settings (ADR 0033, F-088): what an admin enters in the panel, and what the
// server stores beside the token's secret reference. ostra owns this format: strict.

export const modelProviderConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  /** The API's base URL, such as `https://api.example.com/v1`. */
  baseUrl: httpUrlSchema,
  /** Detected by "Test connection"; the admin can correct it. */
  apiFormat: apiFormatSchema,
  authScheme: authSchemeSchema,
  /** The most sessions that may use this provider at once, or `null` for no cap. */
  sessionsAtOnce: z.number().int().positive().max(100_000).nullable(),
  /** Whether personal runners may use it (ADR 0030, Q47). Off by default. */
  allowOnPersonalRunners: z.boolean().default(false),
});
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

/** The form that adds a provider: the settings and its token, which goes to the secret store. */
export const addModelProviderInputSchema = modelProviderConfigSchema.extend({
  /** The provider's token. Stored through the secret store, never logged, never shown again. */
  token: z.string().min(1).max(65_536),
});
export type AddModelProviderInput = z.infer<typeof addModelProviderInputSchema>;
