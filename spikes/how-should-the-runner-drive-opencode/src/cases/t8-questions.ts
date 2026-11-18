// T8 Questions: with `elicitation.form`, OpenCode's question arrives as
// `elicitation/create`, and the answer reaches the model. Also recorded: what
// happens without the capability (expected: the question is cancelled).

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { agentText, textPrompt, type ElicitationResponder } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, newSession, stubCallsFor, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";
import { QUESTION_OPTIONS } from "../harness/scenarios.ts";

/**
 * The answer: a free-text token in the question's custom-answer field. It is
 * none of the options the model offered (QUESTION_OPTIONS), so finding it in
 * the tool result means the member's answer, not an echo of the question.
 */
const ANSWER = `azure-${randomBytes(3).toString("hex")}`;

const requestedSchema = z.looseObject({ requestedSchema: z.looseObject({ properties: z.record(z.string(), z.unknown()).optional() }).optional() });

/** Fills every custom-answer field (`<key>_custom`) with the token, and leaves the option fields empty. */
export const answerFreeText: ElicitationResponder = (request) => {
  const parsed = requestedSchema.safeParse(request);
  const properties = parsed.success ? (parsed.data.requestedSchema?.properties ?? {}) : {};
  const content: Record<string, string> = {};
  for (const key of Object.keys(properties)) if (key.endsWith("_custom")) content[key] = ANSWER;
  return Promise.resolve({ action: "accept", content });
};

export const t8Questions = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number | boolean> = {};
  try {
    await withTask(ctx, { name: "t8", upstream: { kind: "stub", format: "openai" }, answerElicitation: answerFreeText }, async (task) => {
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("question")} pick a colour`)), 120_000, "question turn");
      const asked = task.driver.events.find((e) => e.kind === "elicitation_requested");
      const answered = task.driver.events.find((e) => e.kind === "elicitation_resolved");
      await ctx.save("t8-elicitation.json", { asked, answered });
      const mode = asked?.kind === "elicitation_requested" ? asked.request.mode : undefined;
      const customField = asked?.kind === "elicitation_requested" && JSON.stringify(asked.request).includes("_custom");
      checks.push(
        check(
          "the driver advertises elicitation.form, and the question arrives as elicitation/create",
          mode === "form",
          asked === undefined ? "no elicitation/create arrived" : `mode=${mode ?? "?"}; a custom-answer field offered: ${String(customField)}`,
        ),
      );
      const toolResults = stubCallsFor(ctx, task, "openai").flatMap((c) => c.messages.filter((m) => m.role === "tool"));
      const reached = toolResults.some((m) => m.text.includes(ANSWER));
      const offered = QUESTION_OPTIONS.some((o) => ANSWER.includes(o));
      const text = agentText(task.driver.events, sessionId);
      checks.push(
        check(
          "the answer reaches the model",
          answered !== undefined && customField && !offered && reached && response.stopReason === "end_turn",
          `a free-text token that is none of the options (${QUESTION_OPTIONS.join(", ")}) ${reached ? "found" : "NOT found"} in the tool result the model received; stopReason=${response.stopReason}; agent said "${text.slice(0, 80).replace(ANSWER, "<token>")}"`,
        ),
      );
    });
  } catch (error) {
    checks.push(fail("the question round trip", errorMessage(error)));
  }

  // Without the capability: record, don't judge.
  try {
    await withTask(ctx, { name: "t8-noelicit", upstream: { kind: "stub", format: "openai" }, advertiseElicitation: false }, async (task) => {
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("question")} pick a colour`)), 120_000, "question turn");
      const toolResults = stubCallsFor(ctx, task, "openai").flatMap((c) => c.messages.filter((m) => m.role === "tool"));
      recorded["without elicitation.form: elicitation requests"] = task.driver.events.filter((e) => e.kind === "elicitation_requested").length;
      recorded["without elicitation.form: stopReason"] = response.stopReason;
      recorded["without elicitation.form: tool result"] = (toolResults.at(-1)?.text ?? "none").replace(/\s+/g, " ").slice(0, 160);
    });
  } catch (error) {
    recorded["without elicitation.form"] = `error: ${errorMessage(error)}`;
  }
  return [{ id: "T8", title: "Questions: with elicitation.form, OpenCode's question arrives as elicitation/create and the answer reaches the model.", checks, recorded }];
};
