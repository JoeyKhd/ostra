import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ticketMixCheck } from "../src/harness/criteria.ts";
import { applyMutant } from "../src/runner/checks.ts";
import { ACCEPTANCE_DIR, SAMPLE_REPO } from "../src/runner/workspace.ts";
import { replaceOnce } from "../src/tickets/apply.ts";
import { VariantSchema } from "../src/tickets/schema.ts";
import { buildSolution, dryRunVariant, EXPECTATIONS } from "../src/tickets/solutions.ts";
import { REQUIRED_MIX, TICKETS } from "../src/tickets/tickets.ts";

describe("the ticket set", () => {
  it("has the mix the pass bar asks for, with unique IDs", () => {
    expect(TICKETS).toHaveLength(10);
    expect(new Set(TICKETS.map((t) => t.id)).size).toBe(10);
    for (const [kind, count] of Object.entries(REQUIRED_MIX)) expect(TICKETS.filter((t) => t.kind === kind)).toHaveLength(count);
    expect(ticketMixCheck().status).toBe("PASS");
  });

  it("gives every ticket a title and a body", () => {
    for (const ticket of TICKETS) {
      expect(ticket.title.length).toBeGreaterThan(10);
      expect(ticket.body.length).toBeGreaterThan(100);
    }
  });

  it("gives every behaviour ticket a hidden acceptance file", async () => {
    for (const ticket of TICKETS) {
      if (ticket.acceptance.kind === "behavior") await expect(access(path.join(ACCEPTANCE_DIR, ticket.acceptance.file))).resolves.toBeUndefined();
    }
  });

  it("gives every ticket a reference solution, and a script for each variant the dry-run casts", async () => {
    for (const ticket of TICKETS) {
      const good = await buildSolution(ticket.id, "good");
      expect(good?.steps.length, ticket.id).toBeGreaterThan(0);
      expect(good?.summary.length, ticket.id).toBeGreaterThan(20);
      for (const index of [1, 2, 3]) expect(await buildSolution(ticket.id, dryRunVariant(ticket.id, index)), `${ticket.id} run ${String(index)}`).toBeDefined();
    }
  });

  it("casts four runs that go wrong and the rest good, each variant with an expectation", () => {
    const cast = TICKETS.flatMap((t) => [1, 2, 3].map((i) => dryRunVariant(t.id, i)));
    expect(cast).toHaveLength(30);
    expect(cast.filter((v) => v !== "good")).toHaveLength(4);
    for (const variant of VariantSchema.options) expect(EXPECTATIONS[variant]).toBeDefined();
  });
});

describe("the seeded faults for the add-tests tickets", () => {
  it("each occur exactly once in the pristine module and change it", async () => {
    for (const ticket of TICKETS) {
      if (ticket.acceptance.kind !== "mutation") continue;
      const original = await readFile(path.join(SAMPLE_REPO, ticket.acceptance.target), "utf8");
      expect(ticket.acceptance.mutants.length).toBeGreaterThanOrEqual(6);
      for (const mutant of ticket.acceptance.mutants) expect(applyMutant(original, mutant), mutant.id).not.toBe(original);
    }
  });

  it("refuses a fault whose text is absent or ambiguous", () => {
    expect(() => applyMutant("a b", { id: "x", what: "absent", find: "zzz", replace: "y" })).toThrow(/0 times/);
    expect(() => applyMutant("a a", { id: "x", what: "twice", find: "a", replace: "b" })).toThrow(/2 times/);
  });
});

describe("replaceOnce", () => {
  it("replaces a single occurrence and refuses zero or several, as the agent's edit tool does", () => {
    expect(replaceOnce("one two", "two", "2")).toBe("one 2");
    expect(() => replaceOnce("one", "two", "2")).toThrow();
    expect(() => replaceOnce("two two", "two", "2")).toThrow();
  });
});
