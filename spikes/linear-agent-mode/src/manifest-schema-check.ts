import { z } from "zod";
import { oauthAppManifestSchema } from "./manifest.ts";
import { isRecord } from "./util.ts";

// The spike's manifest schema is a hand-written Zod copy of Linear's published JSON schema, and the fake Linear
// "accepts" or "refuses" a manifest with that same copy, so on its own the copy can only agree with itself. This
// compares it with a snapshot of the published schema (snapshots/linear-oauth-app-manifest.schema.json, read from
// https://linear.app/.well-known/oauth-app-manifest.schema.json on 2026-11-18): which fields are required, which
// values an enum allows, which object is closed to extra keys, and the length and size limits.
//
// It shows the copy and the snapshot agree. It does not show that Linear's server enforces the snapshot.

type Facts = Map<string, string>;

const LIMIT_KEYS = ["minLength", "maxLength", "minItems", "maxItems"] as const;

const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;

const collect = (node: unknown, path: string, out: Facts): void => {
  if (!isRecord(node)) return;
  const required = stringList(node["required"]);
  if (required !== null) out.set(`${path} required`, JSON.stringify([...required].sort()));
  const allowed = stringList(node["enum"]);
  if (allowed !== null) out.set(`${path} enum`, JSON.stringify([...allowed].sort()));
  if ("const" in node) out.set(`${path} const`, JSON.stringify(node["const"]));
  if (node["additionalProperties"] === false) out.set(`${path} closed`, "true");
  for (const key of LIMIT_KEYS) {
    const limit = node[key];
    if (typeof limit === "number") out.set(`${path} ${key}`, String(limit));
  }
  const properties = node["properties"];
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) collect(child, `${path}.${name}`, out);
  }
  collect(node["items"], `${path}[]`, out);
};

const factsOf = (schema: unknown): Facts => {
  const out: Facts = new Map();
  collect(schema, "manifest", out);
  return out;
};

/** The spike's Zod schema, as the JSON schema it describes. */
export const ourJsonSchema = (): unknown => z.toJSONSchema(oauthAppManifestSchema, { io: "input", unrepresentable: "any" });

/** What differs between the published schema and the Zod copy, one line each. Empty: they agree on every fact above. */
export const compareWithPublishedSchema = (published: unknown, ours: unknown): readonly string[] => {
  const want = factsOf(published);
  const have = factsOf(ours);
  const differences: string[] = [];
  for (const [fact, value] of want) {
    const found = have.get(fact);
    if (found !== value) differences.push(`${fact}: published ${value}, the copy has ${found ?? "nothing"}`);
  }
  for (const [fact, value] of have) {
    if (!want.has(fact)) differences.push(`${fact}: the copy has ${value}, published has nothing`);
  }
  return differences;
};

/** How many facts the comparison covers, so a pass cannot be an empty comparison. */
export const countFacts = (schema: unknown): number => factsOf(schema).size;
