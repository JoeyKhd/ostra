// The scripts the stub model plays. A prompt names its script with a marker
// (`[[stub:<name> <args>]]`), and each model call in the turn is one step.
//
// The stub never remembers anything itself. When it answers a question about
// an earlier turn, it reads the answer out of the messages OpenCode sent it in
// that very request. So a right answer from the stub proves the fact reached
// the model's context after the move; a real model then shows it gets used.
//
// Arguments come from prompt text, so each is checked against a strict
// pattern before it reaches a tool call; shell commands are fixed strings.

import type { NormalizedMessage, StubReply, StubRequest } from "../lib/stub-models/types.ts";
import { conversationText, type Scenario } from "../lib/stub-models/scenario.ts";

const WORD = /^[a-z][a-z0-9-]{0,40}$/;
const IDENT = /^[a-z][A-Za-z0-9]{0,40}$/;
const MARKER = /^ostra-marker-[A-Za-z0-9-]{1,64}$/;

const BAD_ARGS: StubReply = { text: "stub: bad args" };

const words = (args: string): string[] => args.split(/\s+/).filter((w) => w !== "");

const checked = (args: string, patterns: readonly RegExp[]): string[] | undefined => {
  const given = words(args);
  if (given.length !== patterns.length) return undefined;
  return given.every((value, index) => patterns[index]?.test(value) === true) ? given : undefined;
};

/** The command turn 3 runs: it prints a number nobody can work out later. */
export const RESULT_COMMAND = `node -e "console.log('RESULT-'+(Date.now()%100000))"`;
export const RESULT_PATTERN = /RESULT-(\d{1,6})\b/;

/** The slow check in the interrupted turn: five minutes, tagged so the sweep can find it. */
export const slowCheckCommand = (marker: string): string => {
  if (!MARKER.test(marker)) throw new Error("slowCheckCommand: bad marker");
  return `node -e "setTimeout(()=>{},300000)" ${marker}`;
};

const toolErrors = (results: readonly NormalizedMessage[]): boolean => results.some((r) => r.isError || /error|not found|failed/i.test(r.text.slice(0, 200)));

/** Earlier messages only: never the question being asked. */
const earlier = (request: StubRequest): string => conversationText(request.messages.slice(0, -1));

/** The fact each question asks for, read from the context like a model would have to. */
const FACT_PATTERNS: Readonly<Record<string, RegExp>> = {
  // Shaped like the run's random facts (history.ts), so a path or word in
  // OpenCode's own system prompt can't be taken for one.
  q1: /(osprey[0-9a-f]{6})/,
  q2: /(docs\/guide-[0-9a-f]{6}\.md)/,
  q3: RESULT_PATTERN,
  q4: /(howdy[0-9a-f]{6})/,
  q5: /use port (4\d{3})/,
};

export const factFromContext = (question: string, context: string): string | undefined => {
  const pattern = FACT_PATTERNS[question];
  if (pattern === undefined) return undefined;
  return pattern.exec(context)?.[1];
};

/** Prints about 4 KB, like a short build log. */
const LOG_COMMAND = `node -e "for(let i=0;i<64;i++)console.log('build step '+i+': compiled module '+i+' in '+(i*3)+' ms, no warnings')"`;

/** A few hundred characters of filler, so a long session's archive has a realistic size per turn. */
const filler = (n: number): string =>
  `Turn ${String(n)} noted. ` + "I checked the workspace and nothing needs to change for this step; the branch is consistent and the tests I would run are unaffected. ".repeat(3);

export const scenarios: Readonly<Record<string, Scenario>> = {
  /** Turn 1: a fact the member states. */
  codename: ({ step }) => (step === 0 ? { text: "OK. I have noted the codename." } : undefined),

  /** Turn 2: a file the agent creates. args: <slug> */
  "create-doc": ({ step, args, lastToolResults }) => {
    const a = checked(args, [WORD]);
    if (a === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [slug = ""] = a;
    if (step === 0) return { toolCalls: [{ name: "write", arguments: { path: `docs/${slug}.md`, content: "A one-line summary of the project.\n" } }] };
    if (step === 1) return { text: toolErrors(lastToolResults) ? "I could not create the file." : `I created docs/${slug}.md.` };
    return undefined;
  },

  /** Turn 3: a tool output only the shell saw. */
  "print-result": ({ step, lastToolResults }) => {
    if (step === 0) return { toolCalls: [{ name: "shell", arguments: { command: RESULT_COMMAND, description: "print the result" } }] };
    if (step === 1) {
      const found = RESULT_PATTERN.exec(lastToolResults.map((r) => r.text).join("\n"));
      return { text: found === null ? "The command printed nothing I could read." : `It printed RESULT-${found[1] ?? ""}.` };
    }
    return undefined;
  },

  /** Turn 4: an edit the member asks for. args: <word> */
  "replace-readme": ({ step, args, lastToolResults }) => {
    const a = checked(args, [WORD]);
    if (a === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [word = ""] = a;
    if (step === 0) return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: word } }] };
    if (step === 1) return { text: toolErrors(lastToolResults) ? "The edit failed." : "Done: README.md is updated." };
    return undefined;
  },

  /** Turn 5: a decision the agent makes and states. The port is the stub's own choice. */
  "pick-port": ({ step, request }) => (step === 0 ? { text: `I will use port ${String(4000 + (request.requestId.charCodeAt(0) * 37 + request.requestId.charCodeAt(1)) % 1000)} because nothing else in the repo uses it.` } : undefined),

  /**
   * Turn 6, the one that gets interrupted: several steps, then a slow check
   * (cancelled while it runs), then a last edit that never happens. `chatty`
   * says a sentence before the first step, as real agents often do; `quiet`
   * goes straight to the tools.
   * args: <module> <name> <marker> <quiet|chatty>
   */
  "multi-step": ({ step, args }) => {
    const a = checked(args, [WORD, IDENT, MARKER, /^(quiet|chatty)$/]);
    if (a === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [mod = "", name = "", marker = "", voice = "quiet"] = a;
    switch (step) {
      case 0:
        return {
          ...(voice === "chatty" ? { text: "I'll work through the steps in order, starting with the new module." } : {}),
          toolCalls: [{ name: "write", arguments: { path: `src/${mod}.ts`, content: `export const ${name} = 1;\n` } }],
        };
      case 1:
        return { toolCalls: [{ name: "shell", arguments: { command: `git add src/${mod}.ts`, description: "stage the new file" } }] };
      case 2:
        return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "draft" } }] };
      case 3:
        return { toolCalls: [{ name: "shell", arguments: { command: "git rm -q old.txt", description: "delete old.txt" } }] };
      case 4:
        return {
          toolCalls: [
            { name: "write", arguments: { path: `scratch/${mod}-plan.md`, content: "Plan: finish the module after the slow check.\n" } },
            { name: "write", arguments: { path: "debug.log", content: "debug\n" } },
          ],
        };
      case 5:
        return { toolCalls: [{ name: "shell", arguments: { command: slowCheckCommand(marker), timeout: 600_000, description: "the slow check" } }] };
      case 6:
        return { toolCalls: [{ name: "edit", arguments: { path: `src/${mod}.ts`, oldString: `export const ${name} = 1;`, newString: `export const ${name} = 1;\nexport const ${name}Done = true;` } }] };
      case 7:
        return { text: "All steps are done." };
      default:
        return undefined;
    }
  },

  /** A question about an earlier turn. args: <question id> */
  answer: ({ step, args, request }) => {
    if (step !== 0) return undefined;
    const fact = factFromContext(args, earlier(request));
    return { text: fact === undefined ? "I don't know: that isn't in what I can see." : `It was ${fact}.` };
  },

  /**
   * Finish the interrupted edit: find that turn's arguments in the history,
   * and make the one edit that was left. Its oldString exists only if the
   * hidden ref brought the half-written file back.
   */
  finish: ({ step, request, lastToolResults }) => {
    const found = /\[\[stub:multi-step ([a-z][a-z0-9-]*) ([a-z][A-Za-z0-9]*) ostra-marker-[A-Za-z0-9-]+ (?:quiet|chatty)\]\]/.exec(earlier(request));
    if (found === null) return step === 0 ? { text: "I don't know which task was interrupted." } : undefined;
    const [, mod = "", name = ""] = found;
    if (step === 0) {
      return { toolCalls: [{ name: "edit", arguments: { path: `src/${mod}.ts`, oldString: `export const ${name} = 1;`, newString: `export const ${name} = 1;\nexport const ${name}Done = true;` } }] };
    }
    if (step === 1) return { text: toolErrors(lastToolResults) ? "The last edit failed." : "Finished the remaining step." };
    return undefined;
  },

  /** The rebuild template's first prompt. */
  "template-ack": ({ step }) => (step === 0 ? { text: "OK. I have read the task's history." } : undefined),

  /**
   * One turn of the 200-turn session, sized like real work: every fifth reads
   * a 24 KB file, every tenth instead runs a command that prints 4 KB, every
   * third greps, and each ends with a few hundred characters of text. args: <n>
   */
  tick: ({ step, args, lastToolResults }) => {
    const a = checked(args, [/^\d{1,4}$/]);
    if (a === undefined) return step === 0 ? BAD_ARGS : undefined;
    const n = Number(a[0]);
    if (step === 0 && n % 10 === 0) return { toolCalls: [{ name: "shell", arguments: { command: LOG_COMMAND, description: "print the build log" } }] };
    if (step === 0 && n % 5 === 0) return { toolCalls: [{ name: "read", arguments: { path: "src/big.ts" } }] };
    if (step === 0 && n % 3 === 0) return { toolCalls: [{ name: "grep", arguments: { pattern: `value${String(n % 600).padStart(3, "0")}`, path: "src" } }] };
    if (step === 0 || (step === 1 && lastToolResults.length > 0)) return { text: filler(n) };
    return undefined;
  },
};

/** Title and summary calls (no tools offered). */
export const auxiliary = (): StubReply => ({ text: "Moving a session" });

/**
 * OpenCode's compaction call (2.3.2), answered the way its prompt asks: the
 * prompt's own template, with the identifiers it was told to preserve (here,
 * the codename, if the conversation holds it). Only for the long session run
 * with compaction on; a real model may keep less.
 */
export const COMPACTION_PROMPTS: readonly string[] = [
  "You MUST summarize the conversation above into a structured summary",
  "Update the existing checkpoint in the conversation above into one consolidated summary",
];

export const isCompactionCall = (request: StubRequest): boolean => {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  return last !== undefined && COMPACTION_PROMPTS.some((p) => last.text.includes(p));
};

export const compactionSummary = (request: StubRequest): StubReply => {
  const codename = factFromContext("q1", conversationText(request.messages));
  return {
    text: [
      "## Objective",
      "- Check the workspace each turn and report.",
      "",
      "## Requirements",
      "- (none)",
      "",
      "## Decisions",
      "- (none)",
      "",
      "## Work State",
      "### Completed",
      "- Workspace checks so far",
      "",
      "### Active",
      "- (none)",
      "",
      "### Blocked",
      "- (none)",
      "",
      "## Next Move",
      "1. (none)",
      "",
      "## Relevant Files",
      "- (none)",
      "",
      "## Important Context",
      codename === undefined ? "- (none)" : `- The codename for this task is ${codename}.`,
    ].join("\n"),
  };
};
