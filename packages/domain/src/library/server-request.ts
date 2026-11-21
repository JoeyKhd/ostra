import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretStoreAdapter } from "@ostra/adapter-sdk";
import { HTTP_HEADER_VALUE } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

import type { StoredServerEntry, StoredServerInput, StoredServerInputs } from "./stored.ts";

// F-145 (ADR 0069, ADR 0030, tickets 27 and 28): a library server's address and headers as they're
// sent, from its version's entry and the admin's inputs: a plain input as kept, a secret one read
// from the secret store. The test call, the update check's fresh test call and a task's
// credentials (for the sidecar's MCP proxy alone) all build it here, so they send the same thing.
// Nothing here is logged; the agent never holds any of it.

/** The remote's URL with its variables put in, each value as a URL part; `null` unless it's an https address. */
export const remoteUrlWith = (template: string, variables: ReadonlyMap<string, string>): string | null => {
  const url = template.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const value = variables.get(name);
    return value === undefined ? whole : encodeURIComponent(value);
  });
  if (/\{[^{}]+\}/.test(url) || !URL.canParse(url)) {
    return null;
  }
  return new URL(url).protocol === "https:" ? url : null;
};

/** An input's value as it's sent: a plain one as kept, a secret one read from the secret store. */
const valueOf = async (secretStore: SecretStoreAdapter, organizationId: OrganizationId, input: StoredServerInput): Promise<string | null> => {
  if (input.kind === "plain") {
    return input.value;
  }
  const ref = secretRefSchema.safeParse(input.ref);
  const value = ref.success ? await secretStore.get(organizationId, ref.data) : null;
  return value?.ok === true ? value.value : null;
};

export type ServerRequest =
  | { readonly ok: true; readonly url: string; readonly headers: Readonly<Record<string, string>> }
  /** `secret-unreadable`: the secret store didn't give an input back; `bad-address`: not an https address once filled; `bad-header`: a value a header can't hold. */
  | { readonly ok: false; readonly error: "secret-unreadable" | "bad-address" | "bad-header" };

/** The server's URL and headers: the entry's fixed headers, then the admin's, each value one a header can hold. */
export const serverRequestOf = async (
  secretStore: SecretStoreAdapter,
  organizationId: OrganizationId,
  entry: StoredServerEntry,
  inputs: StoredServerInputs,
): Promise<ServerRequest> => {
  const variables = new Map<string, string>();
  for (const [name, stored] of Object.entries(inputs.variables)) {
    const value = await valueOf(secretStore, organizationId, stored);
    if (value === null) {
      return { ok: false, error: "secret-unreadable" };
    }
    variables.set(name, value);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.fixedHeaders)) {
    headers[name] = value.trim();
  }
  for (const [name, stored] of Object.entries(inputs.headers)) {
    const value = await valueOf(secretStore, organizationId, stored);
    if (value === null) {
      return { ok: false, error: "secret-unreadable" };
    }
    headers[name] = value.trim();
  }
  // An empty value isn't sent at all; any other must be one a header can hold.
  const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ""));
  if (Object.values(sent).some((value) => value.length > 8192 || !HTTP_HEADER_VALUE.test(value))) {
    return { ok: false, error: "bad-header" };
  }
  const url = remoteUrlWith(entry.remoteUrl, variables);
  return url === null ? { ok: false, error: "bad-address" } : { ok: true, url, headers: sent };
};
