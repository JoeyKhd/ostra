// A deliberately thin answer to CALC-9: it passes, and says little. The
// dry-run's scripted model writes it as test/tokenizer.test.ts in the "weak"
// variant, so the mutation check is shown to fail a suite that proves nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenize } from "../../../sample-repo/src/tokenizer.ts";

describe("tokenize", () => {
  it("tokenizes a sum", () => {
    assert.equal(tokenize("1 + 2").length, 4);
  });
});
