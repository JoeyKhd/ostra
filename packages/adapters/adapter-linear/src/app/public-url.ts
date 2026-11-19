import { isIP } from "node:net";

// Ported from spikes/linear-agent-mode/src/manifest.ts (the address pre-check).
//
// ostra's check of the address it puts in the manifest as the webhook URL. Linear's published rule
// is "https, and not a loopback host, private-network host, or linear.app"
// (linear.app/developers/oauth-app-manifests). This is a stricter subset, so a bad address is
// reported by ostra, with the reason, before an admin pastes the link into Linear. An address that
// fails it means no webhook: the connection polls (spec section 11, item 2).

export type PublicUrlProblem = "invalid-url" | "not-https" | "loopback" | "private-network" | "single-label-host" | "local-suffix" | "linear-host";

export type PublicUrlCheck = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly problem: PublicUrlProblem; readonly reason: string };

/** Why an address can't take Linear's webhooks, in a person's words. */
export const explainPublicUrlProblem = (problem: PublicUrlProblem): string => {
  switch (problem) {
    case "invalid-url":
      return "it isn't a valid absolute URL";
    case "not-https":
      return "Linear delivers webhooks only to https:// addresses";
    case "loopback":
      return "a loopback address can't be reached from Linear";
    case "private-network":
      return "a private-network address can't be reached from Linear";
    case "single-label-host":
      return "a host name with no dot is a local name, not a public one";
    case "local-suffix":
      return "a .local, .internal, .lan or .home.arpa name is local, not public";
    case "linear-host":
      return "Linear doesn't accept its own domain as a webhook address";
    default:
      return problem satisfies never;
  }
};

type AddressKind = "loopback" | "private-network" | "public";

const classifyIpv4 = (host: string): AddressKind => {
  const [a = 0, b = 0] = host.split(".").map(Number);
  if (a === 127) return "loopback";
  if (a === 0 || a === 10) return "private-network";
  if (a === 172 && b >= 16 && b <= 31) return "private-network";
  if (a === 192 && b === 168) return "private-network";
  if (a === 169 && b === 254) return "private-network";
  // Carrier-grade NAT, 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return "private-network";
  return "public";
};

const classifyIpv6 = (host: string): AddressKind => {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return "loopback";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return classifyIpv4(mapped[1]);
  // The same, as the URL parser writes it: `::ffff:a00:1` is 10.0.0.1.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return classifyIpv4(`${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`);
  }
  // Unique local fc00::/7 and link-local fe80::/10.
  if (/^(fc|fd|fe[89ab])/.test(lower)) return "private-network";
  return "public";
};

const LOCAL_SUFFIXES: readonly string[] = [".local", ".internal", ".lan", ".home.arpa"];

const refuse = (problem: PublicUrlProblem): PublicUrlCheck => ({ ok: false, problem, reason: explainPublicUrlProblem(problem) });

/** Whether Linear can deliver webhooks to this address. */
export const checkPublicUrl = (raw: string): PublicUrlCheck => {
  if (!URL.canParse(raw)) return refuse("invalid-url");
  const url = new URL(raw);
  if (url.protocol !== "https:") return refuse(url.protocol === "http:" ? "not-https" : "invalid-url");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const lower = host.toLowerCase().replace(/\.$/, "");
  const family = isIP(host);
  if (family === 4 || family === 6) {
    const kind = family === 4 ? classifyIpv4(host) : classifyIpv6(host);
    return kind === "public" ? { ok: true, origin: url.origin } : refuse(kind);
  }
  if (lower === "localhost" || lower.endsWith(".localhost")) return refuse("loopback");
  if (!lower.includes(".")) return refuse("single-label-host");
  if (LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return refuse("local-suffix");
  if (lower === "linear.app" || lower.endsWith(".linear.app")) return refuse("linear-host");
  return { ok: true, origin: url.origin };
};
