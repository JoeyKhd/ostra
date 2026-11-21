import { templatePaths, WEBHOOK_SIGNATURE_HEADER } from "@ostra/domain/webhook-template";
import type { WebhookAuth } from "@ostra/domain/webhook-template";

import type { PayloadRow } from "./automation-draft";

// A webhook automation's sample request (F-139; the editor's "Try it"): a body that fills the
// template's fields and passes the filter, and the `curl` that sends it, signed with `openssl` or
// carrying the secret as a bearer token. The secret is never in it: `$OSTRA_WEBHOOK_SECRET` holds it.
// Every value is quoted for a POSIX shell, so a filter's text can't break out of its quotes.

/** The variable the sample reads the secret from. */
export const SECRET_VARIABLE = "OSTRA_WEBHOOK_SECRET";

/** `value` at `path` (`body.a.0.b`) in `into`, making objects and arrays on the way. */
const place = (into: Record<string, unknown>, path: string, value: string): void => {
  const parts = path.split(".").slice(1);
  let at: unknown = into;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    const nextIsIndex = /^\d+$/.test(parts[index + 1] ?? "");
    const fresh = (): unknown => (last ? value : nextIsIndex ? [] : {});
    if (Array.isArray(at)) {
      const slot = Number(part);
      const item: unknown = at[slot];
      if (item === undefined || last) at[slot] = fresh();
      at = at[slot];
    } else if (typeof at === "object" && at !== null) {
      const own: unknown = Reflect.get(at, part);
      if (own === undefined || typeof own !== "object" || last) Reflect.set(at, part, fresh());
      at = Reflect.get(at, part);
    }
  });
};

/** A body that fills the template's fields and passes the filter's conditions. */
export const sampleBody = (templates: readonly string[], rows: readonly PayloadRow[]): string => {
  const body: Record<string, unknown> = {};
  const paths = templates.flatMap((template) => templatePaths(template)).filter((path) => path !== "body");
  for (const path of paths) place(body, path, "example");
  for (const row of rows) {
    const path = row.path.trim();
    if (path === "" || path === "body" || !/^body(\.[A-Za-z0-9_-]{1,64})+$/.test(path)) continue;
    switch (row.op) {
      case "equals":
      case "contains":
        place(body, path, row.value === "" ? "example" : row.value);
        break;
      case "exists":
        place(body, path, "example");
        break;
      case "not-equals":
        break;
      default:
        row.op satisfies never;
    }
  }
  return JSON.stringify(Object.keys(body).length === 0 ? { alert: { title: "Disk full on db-1" } } : body);
};

/** A string as one POSIX shell word, in single quotes. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The `curl` that sends the sample, for the automation's way of proving the secret. */
export const sampleCurl = (input: { readonly url: string; readonly auth: WebhookAuth; readonly body: string; readonly keyed: boolean }): string => {
  const key = input.keyed ? [`  -H 'idempotency-key: sample-1' \\`] : [];
  switch (input.auth) {
    case "signature":
      return [
        `body=${shellQuote(input.body)}`,
        `sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$${SECRET_VARIABLE}" | sed 's/^.* //')`,
        `curl -sS -X POST ${shellQuote(input.url)} \\`,
        `  -H 'content-type: application/json' \\`,
        `  -H "${WEBHOOK_SIGNATURE_HEADER}: sha256=$sig" \\`,
        ...key,
        `  --data-binary "$body"`,
      ].join("\n");
    case "bearer":
      return [
        `curl -sS -X POST ${shellQuote(input.url)} \\`,
        `  -H 'content-type: application/json' \\`,
        `  -H "authorization: Bearer $${SECRET_VARIABLE}" \\`,
        ...key,
        `  --data-binary ${shellQuote(input.body)}`,
      ].join("\n");
    default:
      return input.auth satisfies never;
  }
};
