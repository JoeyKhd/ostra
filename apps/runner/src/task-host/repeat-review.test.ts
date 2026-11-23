import { fakeMarker, fakeToolArgs, sampleReview, toolSetsByKind } from "@ostra/adapter-sdk/testing";
import { PROTOCOL_MINOR, repoFullNameSchema, REVIEW_ALREADY_MINOR, reviewResultText, reviewRunIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "../testing/task-host-harness.ts";

// Milestone 10 (ticket 06, F-151, protocol minor 9): this runner says minor 9 in `hello` and speaks
// the lower of its own and the server's, with minor 8's codecs for an older core. Against a minor-9
// core, a review task's repeat `submit_review` (the member asked it to check again) is a completed
// call in the already words, so the thread never draws it failed. Against a minor-8 core, which knows
// no `already` and refuses a repeat as cores did before, the two speak 8 with no protocol error and
// the agent hears that core's refusal. Either way the review task's saves list no repos. On the
// scripted fake agent, on `host`; neither change reads the executor.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("repeat-review");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness(shared, options);
  return harness;
};

const memoryWithTools = { block: "## Memory\n\nNo notes yet.", indexNoteIds: [], alwaysNoteIds: [], omitted: 0, tools: true };
const submit = fakeMarker("submit-review", fakeToolArgs(sampleReview(repoFullNameSchema.parse("ostra-test/test1"))));

/** The agent's words in the session, in order. */
const said = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join("\n");

/** How each of the session's `submit_review` calls ended, in order: `completed` or `failed`. */
const reviewCalls = (h: Harness, spec: TaskSpec): readonly string[] => {
  const ids = h.ofKind(spec, "tool.called").flatMap((event) => (event.title.endsWith("submit_review") ? [event.toolCallId] : []));
  return h.eventsOf(spec).flatMap((event) =>
    (event.kind === "tool.completed" || event.kind === "tool.failed") && ids.includes(event.toolCallId) ? [event.kind === "tool.completed" ? "completed" : "failed"] : [],
  );
};

/** A review task's first turn hands in its review; the member's next message asks it to check again. */
const reviewTwice = async (h: Harness, beforeRepeat: () => void): Promise<TaskSpec> => {
  const { spec } = h.taskFor(submit, { kind: "review", tools: [...toolSetsByKind.review], memory: memoryWithTools });
  h.dispatch(spec);
  await h.waitForKind(spec, "session.saved", 1);
  expect(said(h, spec)).toContain(`submit_review: ${reviewResultText({ reviewRunId: reviewRunIdSchema.parse("review-run-1") })}`);
  beforeRepeat();
  h.steer(spec, submit);
  await h.waitForKind(spec, "session.saved", 2);
  return spec;
};

describe("a repeat review against a minor-8 and a minor-9 core (ticket 06)", () => {
  it("F-151/c7: against a minor-9 core, the runner says minor 9 in hello and speaks it, and a repeat submit_review is a completed call in the already words that records nothing", async () => {
    expect(PROTOCOL_MINOR).toBe(10);
    const h = await start();
    // The round's review is in: core answers the run before, `already`, by the sidecar's minor.
    const spec = await reviewTwice(h, () => {
      h.server.team.reviewIn = true;
    });
    expect(said(h, spec)).toContain("submit_review: This round's review is already handed in, and it stands as it was. Nothing more is needed.");
    expect(reviewCalls(h, spec)).toEqual(["completed", "completed"]);
    expect(h.server.team.reviews).toHaveLength(1);
    expect(h.server.team.calls.map((call) => call.minor)).toEqual([String(REVIEW_ALREADY_MINOR), String(REVIEW_ALREADY_MINOR)]);
    expect(h.logs.filter((record) => record.message === "review submitted").map((record) => record.fields["already"])).toEqual([undefined, true]);
    expect(h.gateway.hellos.length).toBeGreaterThan(0);
    expect(h.gateway.hellos.every((hello) => hello.protocolMinor === 9)).toBe(true);
    expect(h.gateway.protocolErrors).toEqual([]);
    expect(h.ofKind(spec, "session.saved").map((saved) => saved.repos)).toEqual([[], []]);
  }, 180_000);

  it("F-151/c7: against a minor-8 core, the runner still says minor 9 in hello, the two speak 8 with no protocol error, the review task's saves list no repos, and the repeat gets that core's refusal", async () => {
    const h = await start({ serverMinor: 8 });
    // A minor-8 core knows no `already`: a repeat is refused `not-in-review`, an error, as before.
    const spec = await reviewTwice(h, () => {
      h.server.team.refusals.review = { code: "not-in-review" };
    });
    expect(said(h, spec)).toContain(`submit_review: ${reviewResultText({ code: "not-in-review" })}`);
    expect(reviewCalls(h, spec)).toEqual(["completed", "failed"]);
    expect(h.server.team.reviews).toHaveLength(1);
    expect(h.gateway.hellos.length).toBeGreaterThan(0);
    expect(h.gateway.hellos.every((hello) => hello.protocolMinor === 9)).toBe(true);
    // Every frame the runner sent parsed at minor 8, `session.saved` with no repos among them.
    expect(h.gateway.protocolErrors).toEqual([]);
    expect(h.ofKind(spec, "session.saved").map((saved) => saved.repos)).toEqual([[], []]);
    expect(h.everyEventOnce()).toBe(true);
  }, 180_000);
});
