import { isIP } from "node:net";
import { z } from "zod";

// Linear's OAuth app manifest (https://linear.app/developers/oauth-app-manifests, schema at
// https://linear.app/.well-known/oauth-app-manifest.schema.json, read 2026-11-18).
// Linear owns the format: the schema below follows the published one. ostra owns the values it puts in.

export const MANIFEST_SCHEMA_URL = "https://linear.app/.well-known/oauth-app-manifest.schema.json";
export const MANIFEST_NEW_APP_URL = "https://linear.app/settings/api/applications/new";

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

/** What ostra subscribes to (research/trackers.md section 4.3): the plain-API streams plus agent mode. */
export const OSTRA_RESOURCE_TYPES = [
  "AgentSessionEvent",
  "AppUserNotification",
  "Attachment",
  "Comment",
  "Issue",
  "IssueLabel",
  "OAuthAuthorization",
  "PermissionChange",
] as const satisfies readonly LinearResourceType[];

/** Scopes are not part of the manifest: they are asked for at authorize time (trackers.md section 1.2). */
export const OSTRA_SCOPES = ["read", "write", "app:assignable", "app:mentionable"] as const;

export const WEBHOOK_PATH = "/integrations/linear/webhook";
export const CALLBACK_PATH = "/integrations/linear/callback";

// --- the public address Linear must be able to reach ---------------------------------------

export type PublicUrlProblem =
  | "invalid-url"
  | "not-https"
  | "loopback"
  | "private-network"
  | "single-label-host"
  | "linear-host";

export type PublicUrlCheck =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly problem: PublicUrlProblem };

export const explainPublicUrlProblem = (problem: PublicUrlProblem): string => {
  switch (problem) {
    case "invalid-url":
      return "not a valid absolute URL";
    case "not-https":
      return "Linear only delivers webhooks to https:// URLs";
    case "loopback":
      return "a loopback host cannot be reached from Linear";
    case "private-network":
      return "a private-network host cannot be reached from Linear";
    case "single-label-host":
      return "a host with no dot is a local name, not a public one";
    case "linear-host":
      return "Linear does not accept its own domain as a webhook host";
    default:
      return problem satisfies never;
  }
};

type AddressKind = "loopback" | "private-network" | "public";

const classifyIpv4 = (host: string): AddressKind => {
  const octets = host.split(".").map((part) => Number(part));
  const [a = 0, b = 0] = octets;
  if (a === 127) return "loopback";
  if (a === 0 || a === 10) return "private-network";
  if (a === 172 && b >= 16 && b <= 31) return "private-network";
  if (a === 192 && b === 168) return "private-network";
  if (a === 169 && b === 254) return "private-network";
  if (a === 100 && b >= 64 && b <= 127) return "private-network";
  return "public";
};

const classifyIpv6 = (host: string): AddressKind => {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return "loopback";
  if (/^(fc|fd|fe[89ab])/.test(h)) return "private-network";
  return "public";
};

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"] as const;

/**
 * ostra's pre-check of the address it will put in the manifest. Linear's published rule is
 * "https, and not a loopback or private-network host"; this is a conservative subset of it,
 * so a bad address is reported by ostra before an admin pastes it into Linear.
 */
export const checkPublicUrl = (raw: string): PublicUrlCheck => {
  if (!URL.canParse(raw)) return { ok: false, problem: "invalid-url" };
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    return { ok: false, problem: url.protocol === "http:" ? "not-https" : "invalid-url" };
  }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const lower = host.toLowerCase();
  const family = isIP(host);
  if (family === 4 || family === 6) {
    const kind = family === 4 ? classifyIpv4(host) : classifyIpv6(host);
    if (kind !== "public") return { ok: false, problem: kind };
  } else {
    if (lower === "localhost" || lower.endsWith(".localhost")) return { ok: false, problem: "loopback" };
    if (!lower.includes(".")) return { ok: false, problem: "single-label-host" };
    if (LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return { ok: false, problem: "private-network" };
    if (lower === "linear.app" || lower.endsWith(".linear.app")) return { ok: false, problem: "linear-host" };
  }
  return { ok: true, origin: url.origin };
};

// --- the manifest ---------------------------------------------------------------------------

// The published schema sets no length limit on these URLs (only a pattern and format: uri), so the copy sets none.
const httpUrl = z
  .string()
  .refine((value) => URL.canParse(value) && /^https?:\/\//i.test(value), "must be an absolute http(s) URL");

const clientName = z
  .string()
  .min(2)
  .max(80)
  .refine((value) => !/linear/i.test(value), 'must not contain "Linear"')
  .refine((value) => !/https?:\/\//i.test(value), "must not contain a URL");

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const oauthAppManifestSchema = z
  .strictObject({
    $schema: z.literal(MANIFEST_SCHEMA_URL).optional(),
    schemaVersion: z.literal("1.0.0"),
    distribution: z.enum(["private", "public"]).optional(),
    display: z
      .strictObject({
        description: z.string().max(1000).optional(),
        iconUrl: httpUrl.optional(),
      })
      .optional(),
    developer: z.strictObject({ name: z.string().min(2).max(80) }),
    oauth: z.strictObject({
      client_name: clientName,
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
  })
  .superRefine((manifest, ctx) => {
    if (manifest.distribution === "public" && manifest.oauth.client_uri === undefined) {
      ctx.addIssue({ code: "custom", path: ["oauth", "client_uri"], message: "required when distribution is public" });
    }
    if (manifest.webhook !== undefined) {
      const check = checkPublicUrl(manifest.webhook.url);
      if (!check.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["webhook", "url"],
          message: explainPublicUrlProblem(check.problem),
        });
      }
    }
  });

export type OAuthAppManifest = z.infer<typeof oauthAppManifestSchema>;

export type ManifestInput = {
  readonly publicUrl: string;
  readonly developerName: string;
  readonly description?: string;
};

export type ManifestLinks = {
  /** `?manifest=<url-encoded JSON>`: one parameter, validated by Linear against the published schema. */
  readonly json: string;
  /** The dot-notation form, readable in a log. The JSON form wins when both are present. */
  readonly params: string;
};

export type ManifestResult =
  | { readonly ok: true; readonly manifest: OAuthAppManifest; readonly links: ManifestLinks }
  | { readonly ok: false; readonly problems: readonly string[] };

const appNameFor = (origin: string): string => {
  const candidate = `ostra (${new URL(origin).host})`;
  // client_name may not contain "Linear": a host like linear.acme.com falls back to the bare name.
  return clientName.safeParse(candidate).success ? candidate : "ostra";
};

export const manifestLinks = (manifest: OAuthAppManifest): ManifestLinks => {
  const json = `${MANIFEST_NEW_APP_URL}?manifest=${encodeURIComponent(JSON.stringify(manifest))}`;
  const params = new URLSearchParams();
  if (manifest.distribution !== undefined) params.set("distribution", manifest.distribution);
  if (manifest.display?.description !== undefined) params.set("display.description", manifest.display.description);
  params.set("developer.name", manifest.developer.name);
  params.set("oauth.client_name", manifest.oauth.client_name);
  if (manifest.oauth.client_uri !== undefined) params.set("oauth.client_uri", manifest.oauth.client_uri);
  for (const uri of manifest.oauth.redirect_uris) params.append("oauth.redirect_uris", uri);
  for (const grant of manifest.oauth.grant_types ?? []) params.append("oauth.grant_types", grant);
  if (manifest.webhook !== undefined) {
    params.set("webhook.enabled", String(manifest.webhook.enabled ?? true));
    params.set("webhook.url", manifest.webhook.url);
    for (const type of manifest.webhook.resourceTypes) params.append("webhook.resourceTypes", type);
  }
  return { json, params: `${MANIFEST_NEW_APP_URL}?${params.toString()}` };
};

export const buildManifest = (input: ManifestInput): ManifestResult => {
  const check = checkPublicUrl(input.publicUrl);
  if (!check.ok) {
    return {
      ok: false,
      problems: [`public URL: ${explainPublicUrlProblem(check.problem)} (${check.problem})`],
    };
  }
  const candidate = {
    $schema: MANIFEST_SCHEMA_URL,
    schemaVersion: "1.0.0",
    distribution: "private",
    display: {
      description: input.description ?? "Hands Linear tickets to coding agents that run on your own machines.",
    },
    developer: { name: input.developerName },
    oauth: {
      client_name: appNameFor(check.origin),
      client_uri: check.origin,
      redirect_uris: [`${check.origin}${CALLBACK_PATH}`],
      grant_types: ["authorization_code"],
    },
    webhook: {
      enabled: true,
      url: `${check.origin}${WEBHOOK_PATH}`,
      resourceTypes: [...OSTRA_RESOURCE_TYPES],
    },
  } satisfies z.input<typeof oauthAppManifestSchema>;
  const parsed = oauthAppManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { ok: true, manifest: parsed.data, links: manifestLinks(parsed.data) };
};

export type ParsedManifestLink =
  | { readonly ok: true; readonly manifest: OAuthAppManifest }
  | { readonly ok: false; readonly problems: readonly string[] };

const optionalEntry = (key: string, value: string | null): Record<string, string> =>
  value === null ? {} : { [key]: value };

/** What Linear does with the link: read the JSON form, else the dot-notation form, then validate. */
export const parseManifestLink = (link: string): ParsedManifestLink => {
  if (!URL.canParse(link)) return { ok: false, problems: ["not a URL"] };
  const url = new URL(link);
  if (`${url.origin}${url.pathname}` !== MANIFEST_NEW_APP_URL) {
    return { ok: false, problems: ["not a Linear new-app link"] };
  }
  const p = url.searchParams;
  const raw = p.get("manifest");
  let candidate: unknown;
  if (raw !== null) {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, problems: ["manifest parameter is not JSON"] };
    }
  } else {
    const description = p.get("display.description");
    const webhookUrl = p.get("webhook.url");
    const enabled = p.get("webhook.enabled");
    const grants = p.getAll("oauth.grant_types");
    candidate = {
      schemaVersion: "1.0.0",
      ...optionalEntry("distribution", p.get("distribution")),
      ...(description === null ? {} : { display: { description } }),
      developer: { name: p.get("developer.name") },
      oauth: {
        client_name: p.get("oauth.client_name"),
        ...optionalEntry("client_uri", p.get("oauth.client_uri")),
        redirect_uris: p.getAll("oauth.redirect_uris"),
        ...(grants.length === 0 ? {} : { grant_types: grants }),
      },
      ...(webhookUrl === null
        ? {}
        : {
            webhook: {
              url: webhookUrl,
              ...(enabled === null ? {} : { enabled: enabled === "true" }),
              resourceTypes: p.getAll("webhook.resourceTypes"),
            },
          }),
    };
  }
  const parsed = oauthAppManifestSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, manifest: parsed.data }
    : { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
};
