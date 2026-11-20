import { t } from "@/lib/messages";

// F-120 (registry.md): the Registry page's address and prefix as an admin types them, and the
// check's result in words. The server checks them again (`setRegistry`); these say why inline.

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const SEGMENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/**
 * The address to send, or `null` when it isn't one: a host with an optional port. `https://` pasted
 * in is dropped; `http://` is kept only for `localhost` (the dev registry), and refused elsewhere.
 */
export const parseAddress = (text: string): string | null => {
  const trimmed = text.trim().toLowerCase().replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) {
    const host = trimmed.slice("http://".length);
    return /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host) ? trimmed : null;
  }
  const host = trimmed.replace(/^https:\/\//, "");
  return HOST.test(host) ? host : null;
};

/** The prefix to send, without its trailing `/`, or `null`: path segments of the distribution spec's name rule. */
export const parsePrefix = (text: string): string | null => {
  const trimmed = text.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return null;
  return trimmed.split("/").every((segment) => SEGMENT.test(segment)) ? trimmed : null;
};

/** The prefix as the page shows it: ending in `/`. */
export const prefixShown = (prefix: string): string => (prefix === "" ? "" : `${prefix.replace(/\/+$/, "")}/`);

/** `registry.acme.dev/ostra/<project>:<snapshot>`, from the inputs as typed. */
export const imageNameOf = (address: string, prefix: string): string => {
  const host = (parseAddress(address) ?? (address.trim() === "" ? "registry.example.com" : address.trim())).replace(/^https?:\/\//, "");
  const path = parsePrefix(prefix) ?? (prefix.trim() === "" ? "ostra" : prefix.trim().replace(/\/+$/, ""));
  return `${host}/${path}/<project>:<snapshot>`;
};

/** `sha256:9f3c1e…b82a`: the first 6 and last 4 hex characters. */
export const shortDigest = (digest: string): string => {
  const [algorithm, hex] = digest.split(":");
  if (algorithm === undefined || hex === undefined || hex.length <= 10) return digest;
  return `${algorithm}:${hex.slice(0, 6)}…${hex.slice(-4)}`;
};

export type CheckResult = { readonly result: "push-and-pull" | "pull-only" | "refused"; readonly status: number | null; readonly detail: string };

/** The check's result as one line (registry.md, "Check"). A refusal with no status is an unreachable registry. */
export const checkLine = (check: CheckResult, prefix: string, url: string): string => {
  switch (check.result) {
    case "push-and-pull":
      return t("registryPage.resultAllowed", { prefix: prefixShown(prefix) });
    case "pull-only":
      return t("registryPage.resultPullOnly", { prefix: prefixShown(prefix) });
    case "refused":
      return check.status === null ? t("registryPage.resultUnreachable", { url, message: check.detail }) : t("registryPage.resultRefused", { message: check.detail });
    default:
      return check.result satisfies never;
  }
};

/** The panel's short status: its dot's tone and its words. */
export const checkStatus = (check: CheckResult | null, set: boolean): { readonly tone: "green" | "grey" | "red"; readonly text: string } => {
  if (!set) return { tone: "grey", text: t("registryPage.statusNotSet") };
  if (check === null) return { tone: "grey", text: t("registryPage.statusNotChecked") };
  switch (check.result) {
    case "push-and-pull":
      return { tone: "green", text: t("registryPage.statusAllowed") };
    case "pull-only":
      return { tone: "grey", text: t("registryPage.statusPullOnly") };
    case "refused":
      return { tone: "red", text: t("registryPage.statusRefused") };
    default:
      return check.result satisfies never;
  }
};
