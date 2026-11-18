// Nobody sits at these runs, so a question the agent asks gets the same neutral
// answer every time. Declining it is not an option: OpenCode ends the whole turn
// (`cancelled`) when a question is declined, which would score a run as dead for
// asking. In ostra a member answers. Here each question is counted in the
// record, and the reviewer sees what the agent did with the answer.

import { z } from "zod";
import type { ElicitationResponder } from "../lib/acp-driver.ts";

export const UNATTENDED_ANSWER = "No one is available to answer right now. Use your best judgement, say in your summary what you assumed, and carry on.";

const requestedSchema = z.looseObject({ requestedSchema: z.looseObject({ properties: z.record(z.string(), z.unknown()).optional() }).optional() });

/** Fills every custom-answer field (`<key>_custom`) of the question's form with the standard answer. */
export const answerUnattended: ElicitationResponder = (request) => {
  const parsed = requestedSchema.safeParse(request);
  const properties = parsed.success ? (parsed.data.requestedSchema?.properties ?? {}) : {};
  const content: Record<string, string> = {};
  for (const key of Object.keys(properties)) if (key.endsWith("_custom")) content[key] = UNATTENDED_ANSWER;
  return Promise.resolve({ action: "accept", content });
};
