import { z } from "zod";

import { checkPublicUrl } from "./public-url.ts";
import type { PublicUrlProblem } from "./public-url.ts";

// Ported from spikes/linear-agent-mode/src/manifest.ts (the manifest link).
//
// Linear's OAuth app manifest (linear.app/developers/oauth-app-manifests, schema at
// linear.app/.well-known/oauth-app-manifest.schema.json): one link that opens Linear's new-app form
// filled in, so an admin only clicks Create and copies three values back (spec section 3, step 1).
// Linear owns the format: the schema follows the published one. ostra owns the values it puts in.

export const MANIFEST_SCHEMA_URL = "https://linear.app/.well-known/oauth-app-manifest.schema.json";
export const MANIFEST_NEW_APP_URL = "https://linear.app/settings/api/applications/new";

/** Every resource type the published schema lists. */
export const LINEAR_RESOURCE_TYPES = [
  "AgentSessionEvent",
  "AppUserNotification",
  "Attachment",
  "Comment",
  "Customer",
  "CustomerNeed",
  "Cycle",
  "Document",
  "Initiative",
  "InitiativeUpdate",
  "Issue",
  "IssueLabel",
  "IssueSLA",
  "OAuthAuthorization",
  "PermissionChange",
  "Project",
  "ProjectLabel",
  "ProjectUpdate",
  "Reaction",
  "Release",
  "ReleaseNote",
  "User",
] as const;
export type LinearResourceType = (typeof LINEAR_RESOURCE_TYPES)[number];

/**
 * What ostra's app subscribes to (spec section 11, item 3): the plain API's streams, the app's own
 * revocation, and agent mode's events, so milestone 6 needn't recreate the app.
 */
export const OSTRA_RESOURCE_TYPES = [
  "Issue",
  "Comment",
  "Attachment",
  "IssueLabel",
  "OAuthAuthorization",
  "AgentSessionEvent",
] as const satisfies readonly LinearResourceType[];

const httpUrl = z.string().refine((value) => URL.canParse(value) && /^https?:\/\//i.test(value), "must be an absolute http(s) URL");

/** The schema's rule for an app's name: 2 to 80 characters, no "Linear", no URL. */
const clientNameSchema = z
  .string()
  .min(2)
  .max(80)
  .refine((value) => !/linear/i.test(value), 'must not contain "Linear"')
  .refine((value) => !/https?:\/\//i.test(value), "must not contain a URL");

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const oauthAppManifestSchema = z.strictObject({
  $schema: z.literal(MANIFEST_SCHEMA_URL).optional(),
  schemaVersion: z.literal("1.0.0"),
  distribution: z.enum(["private", "public"]).optional(),
  display: z.strictObject({ description: z.string().max(1000).optional(), iconUrl: httpUrl.optional() }).optional(),
  developer: z.strictObject({ name: z.string().min(2).max(80) }),
  oauth: z.strictObject({
    client_name: clientNameSchema,
    client_uri: httpUrl.optional(),
    redirect_uris: z.array(httpUrl).min(1).max(32).refine(unique, "must be unique"),
    grant_types: z
      .array(z.enum(["authorization_code", "client_credentials"]))
      .min(1)
      .refine(unique, "must be unique")
      .refine((types) => types.includes("authorization_code"), "must include authorization_code")
      .optional(),
  }),
  webhook: z
    .strictObject({
      url: z.string().max(1000),
      enabled: z.boolean().optional(),
      resourceTypes: z.array(z.enum(LINEAR_RESOURCE_TYPES)).min(1).max(22).refine(unique, "must be unique"),
    })
    .optional(),
});
export type OAuthAppManifest = z.infer<typeof oauthAppManifestSchema>;

export type LinearAppManifestInput = {
  /** The app's name in Linear, such as `ostra (ostra.acme.com)`. Falls back to `ostra` when Linear's rules refuse it. */
  readonly name: string;
  /** The OAuth callback: where Linear sends the admin back after the consent. */
  readonly callbackUrl: string;
  /** The connection's webhook URL, `…/webhooks/linear/<connectionId>`; `null` to poll. */
  readonly webhookUrl: string | null;
  /** The developer's name in Linear's form. Default `ostra`. */
  readonly developerName?: string;
  readonly description?: string;
  /** The new-app form the link opens. Default Linear's own; a fake Linear's in tests (`linearAppEndpoints`). */
  readonly newAppUrl?: string;
};

/** Whether the manifest carries the webhook, and why not when it doesn't. */
export type ManifestWebhook =
  | { readonly state: "included"; readonly url: string }
  /** No webhook URL was given: the connection polls. */
  | { readonly state: "none" }
  /** The address fails the pre-check: left out, and the connection polls from the start (spec section 11, item 2). */
  | { readonly state: "refused"; readonly problem: PublicUrlProblem; readonly reason: string };

export type LinearAppManifestLink =
  | { readonly ok: true; readonly url: string; readonly manifest: OAuthAppManifest; readonly webhook: ManifestWebhook }
  | { readonly ok: false; readonly problems: readonly string[] };

const DEFAULT_DESCRIPTION = "Hands Linear tickets to coding agents that run on your own machines.";

/** The app's name, or `ostra` when Linear's rules refuse it (a host with "linear" in it, say). */
export const linearAppName = (name: string): string => (clientNameSchema.safeParse(name.trim()).success ? name.trim() : "ostra");

/**
 * The link to Linear's new-app form, filled in from ostra's manifest. Private distribution, the
 * authorization-code grant only (a client-credentials token would replace the consented install,
 * and has no refresh token: context/research/linear-app-token-without-consent.md), the callback,
 * and the webhook when its address passes the pre-check.
 */
export const linearAppManifest = (input: LinearAppManifestInput): LinearAppManifestLink => {
  let webhook: ManifestWebhook = { state: "none" };
  if (input.webhookUrl !== null) {
    const check = checkPublicUrl(input.webhookUrl);
    webhook = check.ok ? { state: "included", url: input.webhookUrl } : { state: "refused", problem: check.problem, reason: check.reason };
  }
  const callback = URL.canParse(input.callbackUrl) ? new URL(input.callbackUrl) : null;
  const candidate = {
    $schema: MANIFEST_SCHEMA_URL,
    schemaVersion: "1.0.0",
    distribution: "private",
    display: { description: input.description ?? DEFAULT_DESCRIPTION },
    developer: { name: input.developerName ?? "ostra" },
    oauth: {
      client_name: linearAppName(input.name),
      ...(callback === null ? {} : { client_uri: callback.origin }),
      redirect_uris: [input.callbackUrl],
      grant_types: ["authorization_code"],
    },
    ...(webhook.state === "included" ? { webhook: { enabled: true, url: webhook.url, resourceTypes: [...OSTRA_RESOURCE_TYPES] } } : {}),
  } satisfies z.input<typeof oauthAppManifestSchema>;
  const parsed = oauthAppManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  return { ok: true, url: `${input.newAppUrl ?? MANIFEST_NEW_APP_URL}?manifest=${encodeURIComponent(JSON.stringify(parsed.data))}`, manifest: parsed.data, webhook };
};

/** Reads a manifest link back, as Linear does: for tests, and for the panel's preview. */
export const parseManifestLink = (link: string): { readonly ok: true; readonly manifest: OAuthAppManifest } | { readonly ok: false } => {
  if (!URL.canParse(link)) return { ok: false };
  const url = new URL(link);
  const raw = url.searchParams.get("manifest");
  if (`${url.origin}${url.pathname}` !== MANIFEST_NEW_APP_URL || raw === null) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const parsed = oauthAppManifestSchema.safeParse(json);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false };
};
