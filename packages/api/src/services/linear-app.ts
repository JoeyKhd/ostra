import {
  authorizeUrl,
  checkAppToken,
  checkPublicUrl,
  exchangeCode,
  LINEAR_API_URL,
  LINEAR_APP_SCOPES,
  LINEAR_AUTHORIZE_URL,
  LINEAR_REVOKE_URL,
  LINEAR_TOKEN_URL,
  linearAppManifest,
  OSTRA_RESOURCE_TYPES,
  revokeToken,
} from "@ostra/adapter-linear";
import type { LinearOAuthError } from "@ostra/adapter-linear";
import type { LinearAppKit, LinearKitError } from "@ostra/domain";

// The calls to Linear the connection flow makes (F-005, spec section 11, items 2 and 3), as the
// domain's `LinearAppKit`: ticket 08's pure functions and small requests (the manifest link, the
// address pre-check, the authorize URL with `actor=app` and S256 PKCE, the code exchange, the check
// that a token is the app's own user, the revoke), with Linear's answers in the words the use cases
// speak. A token or a secret goes in one header or one form field and nowhere else.

/** Where Linear's endpoints are. A test points them at the fake Linear server. */
export type LinearEndpoints = {
  /** The consent page. */
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  /** The GraphQL endpoint. */
  readonly graphqlUrl: string;
};

export const linearEndpoints: LinearEndpoints = {
  authorizeUrl: LINEAR_AUTHORIZE_URL,
  tokenUrl: LINEAR_TOKEN_URL,
  revokeUrl: LINEAR_REVOKE_URL,
  graphqlUrl: LINEAR_API_URL,
};

/** What ostra asks for at authorize time (spec section 11, item 3). */
export const linearScopes: readonly string[] = LINEAR_APP_SCOPES;

/** The webhook resource types the manifest subscribes to (spec section 11, item 3). */
export const linearWebhookEvents: readonly string[] = OSTRA_RESOURCE_TYPES;

const failure = (error: LinearOAuthError): LinearKitError => {
  switch (error.code) {
    case "unavailable":
      return { code: "unavailable", message: error.message };
    case "not-an-app-user":
      return { code: "not-app-user", message: error.message };
    case "invalid-grant":
    case "invalid-client":
    case "grant-disabled":
    case "different-app-user":
    case "unauthorized":
    case "invalid-response":
      return { code: "refused", message: error.message };
    default:
      return error.code satisfies never;
  }
};

export type LinearAppKitOptions = { readonly endpoints?: LinearEndpoints };

/** The kit the panel's connection flow uses, over Linear's endpoints (or a fake's). */
export const createLinearAppKit = (options: LinearAppKitOptions = {}): LinearAppKit => {
  const endpoints = options.endpoints ?? linearEndpoints;
  return {
    scopes: linearScopes,
    webhookEvents: linearWebhookEvents,

    checkPublicUrl: (url) => {
      const checked = checkPublicUrl(url);
      return checked.ok ? { public: true } : { public: false, reason: checked.reason };
    },

    manifestUrl: (input) => {
      const link = linearAppManifest(input);
      if (!link.ok) {
        // The panel's own address is what's wrong here (a callback that isn't an http(s) URL).
        throw new Error(`Linear's app manifest could not be made: ${link.problems.join("; ")}`);
      }
      return link.url;
    },

    authorizeUrl: (input) => authorizeUrl({ ...input, authorizeUrl: endpoints.authorizeUrl }),

    exchangeCode: async (input) => {
      const exchanged = await exchangeCode({ ...input, tokenUrl: endpoints.tokenUrl });
      return exchanged.ok
        ? { ok: true, value: { accessToken: exchanged.value.accessToken, refreshToken: exchanged.value.refreshToken, expiresAt: exchanged.value.expiresAt } }
        : { ok: false, error: failure(exchanged.error) };
    },

    checkAppToken: async (accessToken) => {
      const checked = await checkAppToken({ accessToken, apiUrl: endpoints.graphqlUrl });
      return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: failure(checked.error) };
    },

    revokeToken: async (token) => {
      const revoked = await revokeToken({ token, revokeUrl: endpoints.revokeUrl });
      return revoked.ok ? { ok: true, value: null } : { ok: false, error: failure(revoked.error) };
    },
  };
};
