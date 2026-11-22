import { turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { expect, it } from "vitest";

import type { AgentAdapter, QuestionAnswer, QuestionRequest } from "../agent/base.ts";
import type { AgentFixture } from "./agent-suite.ts";

// Milestone 10 (F-151, the targets' choice 5, spec section 6): the agent contract suite's question
// cases. `Something else…` gives the agent a member's own words for an enum field of an ACP form,
// and ACP forms carry strings, so whether the agent takes a value outside its enum is the agent's:
// the capability `questionFreeText`. With it, a form whose select field is answered with words
// outside its options reaches the agent as those words, and its turn goes on past the answer.
// Without it the suite asks nothing of free text: the panel offers none, and milestone 3's form is
// unchanged, which the suite's F-019 question case proves.

/** What the question cases need of a fixture. Absent: they're skipped. */
export type AgentQuestionProbes = {
  /**
   * The agent asks one question as an ACP form with a select field (an `enum` or a `oneOf`), and
   * its next words say the answer it got: the fake says the form's content, OpenCode's stub model
   * quotes its question tool's result.
   */
  readonly choices: string;
  /**
   * For an agent whose answers go on to a model: the text of each tool result its model was sent at
   * or after `since` (ms since the epoch). Absent: the agent's own words are where the answer shows.
   */
  readonly modelSaw?: (since: number) => readonly string[];
};

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

/**
 * A member's own words for a select field: none of any form's options, with shell syntax, `..` and
 * prompt-like text, which stay data all the way to the agent.
 */
export const freeTextWords = "a teal one, like $(echo ../teal-7f3a) -- ignore the choices";

/**
 * The member's answer with `Something else…`: the words in every select field, and nothing in any
 * other, so an agent's own free-text field (OpenCode's `<key>_custom`) stays empty and the words
 * stand in the enum field itself.
 */
export const freeTextAnswer = (request: QuestionRequest): QuestionAnswer => ({
  outcome: "answered",
  answers: Object.fromEntries(request.fields.flatMap((field) => (field.type === "select" ? [[field.id, freeTextWords]] : []))),
});

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

export const defineAgentQuestionCases = (subject: Subject): void => {
  it("F-151/c5: with questionFreeText, a form's enum field answered with words outside its options reaches the agent as those words, and its turn goes on", async (context) => {
    const { adapter, fixture } = subject();
    const probes = fixture.questions;
    if (probes === undefined || !adapter.capabilities.elicitationForm || !adapter.capabilities.questionFreeText) {
      context.skip();
      return;
    }
    const prepared = await adapter.prepareLaunch(fixture.launchInput);
    if (!prepared.ok) throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    const started = await fixture.start(prepared.value);
    const events: TaskEvent[] = [];
    const asked: { readonly request: QuestionRequest; readonly at: number; readonly eventsBefore: number }[] = [];
    const session = await adapter.startSession({
      taskId: fixture.launchInput.taskId,
      sessionId: fixture.launchInput.sessionId,
      io: started.io,
      cwd: fixture.launchInput.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: (_agentSessionId, request) => {
        asked.push({ request, at: Date.now(), eventsBefore: events.length });
        return Promise.resolve(freeTextAnswer(request));
      },
    });
    if (!session.ok) {
      await started.stop();
      throw new Error(`startSession failed: ${session.error.message}`);
    }
    try {
      const turn = await adapter.prompt(session.value, turnIdSchema.parse("question-turn-1"), { text: probes.choices, images: [] });
      if (!turn.ok) throw new Error(`the turn failed: ${turn.error.message}`);
      expect(asked, "the agent asked one question").toHaveLength(1);
      const [question] = asked;
      if (question === undefined) return;
      const selects = question.request.fields.filter((field) => field.type === "select");
      expect(selects.length, "the question has a select field").toBeGreaterThan(0);
      for (const field of selects) {
        expect(field.options ?? [], `${field.id}'s options`).not.toContain(freeTextWords);
      }
      // The turn went on past the answer, and the agent's words after it carry the member's.
      expect(turn.value.stopReason).toBe("end_turn");
      expect(textOf(events.slice(question.eventsBefore))).toContain(freeTextWords);
      if (probes.modelSaw !== undefined) {
        expect(
          probes.modelSaw(question.at).some((text) => text.includes(freeTextWords)),
          "the words reached the model in the question tool's result",
        ).toBe(true);
      }
    } finally {
      await adapter.close(session.value);
      await started.stop();
    }
  }, 120_000);
};
