import { z } from "zod";

// A network rule of an environment (F-052, ADR 0073): one destination an environment's boxes may
// reach, and the TCP ports they reach it on. A destination is a public host name — an exact name,
// or `*.` and a suffix for a whole subdomain level — or a CIDR an endpoint is reached at by
// address. ostra owns this format: an unknown field is refused, and what a person types (case, a
// trailing dot, port order) is normalised before it is stored.

/** One TCP port a rule opens: 1 to 65 535. */
export const networkRulePortSchema = z.number().int().min(1).max(65_535);

/** 1 to 16 TCP ports, sorted, no repeats (the one place a rule's ports are made canonical). */
const networkRulePortsSchema = z
  .array(networkRulePortSchema)
  .min(1)
  .max(16)
  .refine((ports) => new Set(ports).size === ports.length, "each port once")
  .transform((ports) => [...ports].sort((a, b) => a - b));

const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A host name a rule may name: an exact name (`registry.npmjs.org`) or `*.` and a suffix
 * (`*.githubusercontent.com`), two labels at least. Case and a trailing dot are normalised before
 * the pattern is checked, so `EXAMPLE.com.` is stored as `example.com`. The pattern refuses what no
 * DNS name can be: a bare `*`, a single label, an IP literal, a scheme, a path, a port, an
 * underscore and a trailing dot.
 */
export const networkRuleHostSchema = z
  .string()
  .min(1)
  .max(253)
  .trim()
  .toLowerCase()
  .transform((host) => host.replace(/\.$/, ""))
  .pipe(z.string().regex(HOST_PATTERN, "a public host name, or * and a suffix"));

const parseIpv4 = (text: string): boolean => {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

const parseIpv6 = (text: string): boolean => {
  if (text === "") {
    return false;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return false;
  }
  const head = halves[0] ?? "";
  const tail = halves[1] ?? "";
  const left = head === "" ? [] : head.split(":");
  const right = halves.length === 2 && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  // `::` itself is all zeroes; a written address needs exactly eight groups.
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return false;
  }
  return [...left, ...right].every((group) => /^[0-9a-fA-F]{1,4}$/.test(group));
};

/**
 * An IPv4 or IPv6 network an endpoint is reached at by address, with its prefix always written:
 * `10.0.0.0/8`, `2001:db8::/32`. The address is parsed by splitting its octets or groups; a
 * missing prefix, a bit count out of range and any malformed part are refused. No netmask
 * dependency.
 */
export const cidrSchema = z
  .string()
  .min(3)
  .max(64)
  .refine((value) => {
    const parts = value.split("/");
    const address = parts[0];
    const bitsText = parts[1];
    if (parts.length !== 2 || address === undefined || bitsText === undefined || !/^\d{1,3}$/.test(bitsText)) {
      return false;
    }
    const bits = Number(bitsText);
    if (address.includes(":")) {
      return bits <= 128 && parseIpv6(address);
    }
    return bits <= 32 && parseIpv4(address);
  }, "an address and a prefix, such as 10.0.0.0/8");

/** One destination a rule names: a host, or a CIDR, and the ports it opens. */
export const networkRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host"), host: networkRuleHostSchema, ports: networkRulePortsSchema }),
  z.strictObject({ kind: z.literal("cidr"), cidr: cidrSchema, ports: networkRulePortsSchema }),
]);
export type NetworkRule = z.infer<typeof networkRuleSchema>;

/** An environment's whole list: at most 100 rules, each `(kind, value)` once. */
export const networkRulesSchema = z
  .array(networkRuleSchema)
  .max(100)
  .refine((rules) => new Set(rules.map((rule) => `${rule.kind}=${rule.kind === "host" ? rule.host : rule.cidr}`)).size === rules.length, "each rule once");
export type NetworkRules = z.infer<typeof networkRulesSchema>;
