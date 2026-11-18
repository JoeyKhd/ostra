// The question set: five questions about earlier turns, one per kind of
// trace, and the request to finish the interrupted edit. A question counts
// when the answer holds the fact (case-insensitive). The agent is asked to
// answer from memory, without tools, and the box enforces it: every tool call
// during a question is rejected, and an answer counts only when no tool call
// completed during it, so q2 and q4 can't be read back off the disk.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { agentText, textPrompt, type AcpDriver } from "../lib/acp-driver.ts";
import type { SessionId } from "../lib/ids.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { withTimeout, type Box } from "./fixture.ts";
import type { Facts } from "./history.ts";

export type Question = { readonly id: string; readonly kind: string; readonly text: string; readonly expected: string | undefined };

const FROM_MEMORY = "Answer from what you remember of this task, in a few words, without running any tool.";

export const questionSet = (facts: Facts): readonly Question[] => [
  { id: "q1", kind: "a fact the member stated (turn 1)", text: `What is the codename for this task that I told you at the start? ${FROM_MEMORY}`, expected: facts.codename },
  { id: "q2", kind: "a file the agent created (turn 2)", text: `Which file did you create under docs/ earlier? Give its path. ${FROM_MEMORY}`, expected: facts.docSlug },
  { id: "q3", kind: "a tool output (turn 3)", text: `Earlier you ran a node command that printed RESULT- followed by a number. What was the number? ${FROM_MEMORY}`, expected: facts.printed },
  { id: "q4", kind: "an edit the member asked for (turn 4)", text: `Which word did I ask you to put in README.md in place of hello? ${FROM_MEMORY}`, expected: facts.readmeWord },
  { id: "q5", kind: "a decision the agent stated (turn 5)", text: `Which port did you pick for the dev server? ${FROM_MEMORY}`, expected: facts.port },
];

export type Answer = {
  readonly id: string;
  readonly kind: string;
  readonly correct: boolean;
  readonly stopReason: string;
  readonly answer: string;
  readonly expected: string | undefined;
  /** Tool calls the agent started during the question, and how many completed (rejected ones don't). */
  readonly toolCalls: number;
  readonly toolCallsCompleted: number;
  /** Permission requests the box rejected during the question. */
  readonly rejected: number;
};

/** Tool calls in a turn's events: started, and completed. */
export const toolCallsIn = (driver: AcpDriver, sessionId: SessionId, sinceSeq: number): { started: number; completed: number } => {
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const event of driver.events) {
    if (event.seq <= sinceSeq || event.kind !== "session_update" || event.sessionId !== sessionId) continue;
    const update = event.update;
    if (update.sessionUpdate === "tool_call") {
      started.add(update.toolCallId);
      if (update.status === "completed") completed.add(update.toolCallId);
    } else if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
      completed.add(update.toolCallId);
    }
  }
  return { started: started.size, completed: completed.size };
};

export type Score = { readonly correct: number; readonly of: number; readonly answers: readonly Answer[] };

export const askQuestions = async (box: Pick<Box, "blockTools">, driver: AcpDriver, sessionId: SessionId, facts: Facts, stub: boolean): Promise<Score> => {
  const answers: Answer[] = [];
  for (const question of questionSet(facts)) {
    const sinceSeq = driver.events.at(-1)?.seq ?? 0;
    const prompt = stub ? `${stubMarker("answer", question.id)} ${question.text}` : question.text;
    box.blockTools(true);
    let rejected = 0;
    let response;
    try {
      response = await withTimeout(driver.prompt(sessionId, textPrompt(prompt)), stub ? 60_000 : 300_000, `question ${question.id}`);
    } finally {
      // Off again whatever happened; the count is this question's.
      rejected = box.blockTools(false);
    }
    const answer = agentText(driver.events, sessionId, sinceSeq);
    const tools = toolCallsIn(driver, sessionId, sinceSeq);
    const holdsFact = question.expected !== undefined && answer.toLowerCase().includes(question.expected.toLowerCase());
    answers.push({
      id: question.id,
      kind: question.kind,
      correct: holdsFact && tools.completed === 0,
      stopReason: response.stopReason,
      answer,
      expected: question.expected,
      toolCalls: tools.started,
      toolCallsCompleted: tools.completed,
      rejected,
    });
  }
  return { correct: answers.filter((a) => a.correct).length, of: answers.length, answers };
};

export const FINISH_PROMPT =
  "Your earlier turn was interrupted while the slow check was running. Finish the task you were working on: do only the step that is still left, skip the slow check, and don't redo anything that is already done.";

export type Finish = {
  readonly stopReason: string;
  readonly finished: boolean;
  /** What was found on disk, per expectation. */
  readonly found: Readonly<Record<string, boolean>>;
};

const exists = async (file: string): Promise<boolean> => (await stat(file).catch(() => undefined)) !== undefined;
const readText = async (file: string): Promise<string> => (await readFile(file, "utf8").catch(() => "")).replaceAll("\r\n", "\n");

/** The key, in `finishedOnDisk`, of the edit the interrupted turn never made. */
export const LEFT_LINE = (facts: Facts): string => `src/${facts.module}.ts has the line that was left`;

/** What the interrupted turn should have left, once finished. */
export const finishedOnDisk = async (workspace: string, facts: Facts): Promise<Record<string, boolean>> => {
  const module = await readText(path.join(workspace, "src", `${facts.module}.ts`));
  return {
    [`src/${facts.module}.ts has its first line`]: module.includes(`export const ${facts.constName} = 1;`),
    [LEFT_LINE(facts)]: module.includes(`export const ${facts.constName}Done = true;`),
    "notes.txt says draft": (await readText(path.join(workspace, "notes.txt"))).includes("draft"),
    "old.txt is gone": !(await exists(path.join(workspace, "old.txt"))),
    [`scratch/${facts.module}-plan.md exists`]: await exists(path.join(workspace, "scratch", `${facts.module}-plan.md`)),
  };
};

export const finishEdit = async (driver: AcpDriver, sessionId: SessionId, workspace: string, facts: Facts, stub: boolean): Promise<Finish> => {
  const prompt = stub ? `${stubMarker("finish")} ${FINISH_PROMPT}` : FINISH_PROMPT;
  const response = await withTimeout(driver.prompt(sessionId, textPrompt(prompt)), stub ? 60_000 : 600_000, "finish the edit");
  const found = await finishedOnDisk(workspace, facts);
  return { stopReason: response.stopReason, finished: response.stopReason === "end_turn" && Object.values(found).every(Boolean), found };
};
