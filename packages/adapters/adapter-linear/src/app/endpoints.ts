import { MANIFEST_NEW_APP_URL } from "./manifest.ts";
import { LINEAR_API_URL, LINEAR_AUTHORIZE_URL, LINEAR_REVOKE_URL, LINEAR_TOKEN_URL } from "./oauth.ts";

// Where the app flow reaches Linear (F-005): the GraphQL API, the consent page, the token and
// revoke endpoints, and the new-app form the manifest link opens. They follow OSTRA_LINEAR_API_URL:
// Linear's own for an address on api.linear.app, and for any other (a fake Linear in tests, the only
// one that sets it) the same paths on that address's origin, where the fake Linear serves them. So a
// browser run connects through the fake end to end (milestone 2's tickets 33 and 35).

export type LinearAppEndpoints = {
  /** The GraphQL endpoint. */
  readonly graphqlUrl: string;
  /** The consent page. */
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  /** The new-app form the manifest link fills in. */
  readonly newAppUrl: string;
};

const LINEAR_API_ORIGIN = new URL(LINEAR_API_URL).origin;

/** The app flow's endpoints for a GraphQL address: Linear's own, or a fake Linear's at its origin. */
export const linearAppEndpoints = (apiUrl: string = LINEAR_API_URL): LinearAppEndpoints => {
  const origin = new URL(apiUrl).origin;
  if (origin === LINEAR_API_ORIGIN) {
    return { graphqlUrl: apiUrl, authorizeUrl: LINEAR_AUTHORIZE_URL, tokenUrl: LINEAR_TOKEN_URL, revokeUrl: LINEAR_REVOKE_URL, newAppUrl: MANIFEST_NEW_APP_URL };
  }
  const at = (linearUrl: string): string => `${origin}${new URL(linearUrl).pathname}`;
  return { graphqlUrl: apiUrl, authorizeUrl: at(LINEAR_AUTHORIZE_URL), tokenUrl: at(LINEAR_TOKEN_URL), revokeUrl: at(LINEAR_REVOKE_URL), newAppUrl: at(MANIFEST_NEW_APP_URL) };
};
