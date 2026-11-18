import { describeIssues } from "@ostra/protocol";
import type { z } from "zod";

import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult } from "../common/result.ts";

// Vendor data at the boundary (AGENTS.md): API responses, webhooks and agent events are checked
// with a Zod schema that tolerates unknown fields (`z.looseObject`), and the inferred type is
// trusted after that. The error names paths, never the vendor's values.

export const parseVendor = <S extends z.ZodType>(schema: S, data: unknown, what: string): AdapterResult<z.infer<S>> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : adapterError("invalid-response", `${what} did not match its schema: ${describeIssues(parsed.error)}`);
};
