// The reference solution to CALC-10, written into the agent's workspace by the
// dry-run's scripted model as test/history.test.ts (see tokenizer.test.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHistory, DEFAULT_HISTORY_LIMIT, type HistoryEntry } from "../../../sample-repo/src/history.ts";

const entry = (n: number): HistoryEntry => ({ expression: `${String(n)} + 0`, result: n });

describe("createHistory", () => {
  it("starts empty", () => {
    const history = createHistory();
    assert.equal(history.size(), 0);
    assert.deepEqual(history.list(), []);
    assert.equal(history.last(), undefined);
  });

  it("lists entries oldest first", () => {
    const history = createHistory();
    history.add(entry(1));
    history.add(entry(2));
    history.add(entry(3));
    assert.deepEqual(history.list(), [entry(1), entry(2), entry(3)]);
    assert.equal(history.size(), 3);
  });

  it("returns the newest entry from last()", () => {
    const history = createHistory();
    history.add(entry(1));
    history.add(entry(2));
    assert.deepEqual(history.last(), entry(2));
  });

  it("empties with clear()", () => {
    const history = createHistory();
    history.add(entry(1));
    history.clear();
    assert.equal(history.size(), 0);
    assert.deepEqual(history.list(), []);
    assert.equal(history.last(), undefined);
  });

  it("keeps working after clear()", () => {
    const history = createHistory(2);
    history.add(entry(1));
    history.clear();
    history.add(entry(2));
    assert.deepEqual(history.list(), [entry(2)]);
  });

  it("drops the oldest entry when the limit is passed", () => {
    const history = createHistory(3);
    for (const n of [1, 2, 3, 4, 5]) history.add(entry(n));
    assert.equal(history.size(), 3);
    assert.deepEqual(history.list(), [entry(3), entry(4), entry(5)]);
    assert.deepEqual(history.last(), entry(5));
  });

  it("holds exactly the limit without dropping anything", () => {
    const history = createHistory(3);
    for (const n of [1, 2, 3]) history.add(entry(n));
    assert.deepEqual(history.list(), [entry(1), entry(2), entry(3)]);
  });

  it("works with a limit of 1", () => {
    const history = createHistory(1);
    history.add(entry(1));
    history.add(entry(2));
    assert.deepEqual(history.list(), [entry(2)]);
  });

  it("holds 100 entries by default", () => {
    assert.equal(DEFAULT_HISTORY_LIMIT, 100);
    const history = createHistory();
    for (let n = 1; n <= 150; n += 1) history.add(entry(n));
    assert.equal(history.size(), 100);
    assert.deepEqual(history.list()[0], entry(51));
  });

  it("hands out a copy: a later add does not change a list already held", () => {
    const history = createHistory();
    history.add(entry(1));
    const held = history.list();
    history.add(entry(2));
    assert.equal(held.length, 1);
    assert.notEqual(history.list(), history.list());
  });

  it("rejects a limit that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createHistory(bad), RangeError, `limit ${String(bad)}`);
    }
  });
});
