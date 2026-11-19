import type { AppManifest, AppManifestInput } from "@ostra/adapter-sdk";

// The GitHub App manifest flow (F-006, ADR 0040). Ported from
// spikes/github-app-and-git-proxy/src/github/manifest.ts, with the permissions GitHub accepted.

// The permissions v1 needs. `checks: write` and `actions: read` are asked for from day one, so no
// install re-approves later. `email_addresses` is left out: GitHub refused the manifest with it
// ("Default permission records resource is not included in the list"), and linking a member's
// account needs only their login and ID. `workflows` is left out too: it is optional by policy,
// so a push that touches `.github/workflows/` fails by default.
export const appPermissions = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  actions: "read",
  issues: "read",
  statuses: "read",
  metadata: "read",
} as const satisfies Record<string, "read" | "write">;

export const appEvents = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "check_run",
  "check_suite",
  "status",
  "push",
  "workflow_run",
] as const;

/**
 * A public App's homepage (F-136, ADR 0065): ostra's own project page. Anyone can open a public
 * App's page to install it, so it doesn't name the install's address. A private App's is the panel's.
 */
export const OSTRA_PROJECT_URL = "https://github.com/JoeyKhd/ostra";

/** Where GitHub sends a member back after they sign in to link their account (F-119). */
export const GITHUB_LINK_CALLBACK_PATH = "/api/github/link/callback";

const privateIpv4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/;

/**
 * Whether GitHub can reach a webhook URL. It refuses a hook URL that isn't reachable from the
 * public internet, even with `active: false` ("Hook url is not supported because it isn't
 * reachable over the public Internet (127.0.0.1)", 2026-11-18).
 */
export const isPublicWebhookUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (host.startsWith("[") || privateIpv4.test(host)) {
    return false;
  }
  // A single-label name ("ostra", "core") is a private host.
  return host.includes(".");
};

export const buildAppManifest = (input: AppManifestInput, webUrl: string): AppManifest => {
  const base = webUrl.replace(/\/+$/, "");
  const withHook = isPublicWebhookUrl(input.webhookUrl);
  const homepage = input.homepageUrl.replace(/\/+$/, "");
  // Private by default (Q281): GitHub won't make a public App private again once another account installed it.
  const isPublic = input.public === true;
  return {
    manifest: {
      name: input.name,
      url: isPublic ? OSTRA_PROJECT_URL : input.homepageUrl,
      ...(withHook ? { hook_attributes: { url: input.webhookUrl, active: true }, default_events: [...appEvents] } : {}),
      redirect_url: input.redirectUrl,
      // The OAuth callbacks: "Sign in with GitHub", and the verified link of a member's account (F-119,
      // ADR 0052). An App made before milestone 3 needs the second added once (ticket 51).
      callback_urls: [`${homepage}/api/auth/callback/github`, `${homepage}${GITHUB_LINK_CALLBACK_PATH}`],
      // "Private GitHub Apps can only be installed on the user or organization account of the app owner."
      public: isPublic,
      default_permissions: { ...appPermissions },
    },
    createUrl:
      input.ownerLogin === null
        ? `${base}/settings/apps/new`
        : `${base}/organizations/${encodeURIComponent(input.ownerLogin)}/settings/apps/new`,
  };
};
