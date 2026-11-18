import { randomBytes } from "node:crypto";
import { z } from "zod";
import { OSTRA_SCOPES } from "./manifest.ts";
import { sha256Base64Url } from "./util.ts";

// The authorization-code flow with `actor=app` (research/trackers.md section 1.2): the token that comes
// back belongs to the app's own user in the workspace, not to the admin who clicked Authorize.

export type Pkce = { readonly verifier: string; readonly challenge: string };

export const createPkce = (): Pkce => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256Base64Url(verifier) };
};

export const randomState = (): string => randomBytes(24).toString("base64url");

export type AuthorizeUrlInput = {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
};

export const buildAuthorizeUrl = (input: AuthorizeUrlInput): string => {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OSTRA_SCOPES.join(","));
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

// Vendor-owned format: unknown fields are tolerated.
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const scopesOf = (token: TokenResponse): readonly string[] => {
  if (token.scope === undefined) return [];
  return Array.isArray(token.scope) ? token.scope : token.scope.split(/[\s,]+/).filter((s) => s.length > 0);
};

export type ExchangeInput = {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
};

export type ExchangeResult =
  | { readonly ok: true; readonly token: TokenResponse }
  | { readonly ok: false; readonly reason: "http-error" | "bad-response"; readonly status: number };

export const exchangeCode = async (input: ExchangeInput): Promise<ExchangeResult> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.verifier,
  });
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, reason: "http-error", status: response.status };
  const json: unknown = await response.json();
  const parsed = tokenResponseSchema.safeParse(json);
  return parsed.success
    ? { ok: true, token: parsed.data }
    : { ok: false, reason: "bad-response", status: response.status };
};
