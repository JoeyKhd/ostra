import { conversationText, createScenarioBrain, startAnthropicStub, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario, StubBrain, StubReply, StubServer } from "@ostra/adapter-sdk/testing";

// The model the suite's OpenCode talks to (ticket 38, spec section 8: "OpenCode runs the same suite
// against the stub models"). A local stub in Anthropic's format, behind the runner's real key proxy,
// that plays a script named by a marker in the prompt, `[[stub:<script> <args>]]`: each model call
// is one step. So a turn takes seconds, does the same every run, and can be made to last, to go
// silent, to spend, or to say something the server can't store. Its token counts are the stub's own,
// priced as the catalog's `claude-haiku-4-5`.

/** The model the stub serves: a catalog model with a known price, so the spend cap counts dollars. */
export const STUB_MODEL_ID = "claude-haiku-4-5";

const write = (file: string, content: string): StubReply => ({ toolCalls: [{ name: "write", arguments: { path: file, content } }] });
const read = (delayMs: number): StubReply => ({ toolCalls: [{ name: "read", arguments: { path: "README.md" } }], delayMs });

/** About 60,000 characters: the stub bills a token per four bytes. */
const LONG_ANSWER = "The failure suite spends on purpose here. ".repeat(1500);

/** The file's content: one line naming the case, so a commit always changes something. */
const contentOf = (file: string): string => `${file}: written by ostra's failure suite.\n`;

const number = (text: string | undefined, fallback: number): number => {
  const value = Number.parseInt(text ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

/** The scripts the suite's tickets name. */
export type ScriptName = "write" | "slow" | "busy" | "stall" | "spend" | "unstorable" | "recall";

/** What `recall` says when the conversation it was shown holds the earlier turn's file. */
export const rememberWords = (earlier: string): string => `I remember ${earlier} from an earlier turn.`;

/** What `recall` says when it doesn't. */
export const forgotWords = (earlier: string): string => `I don't remember ${earlier}.`;

const scenarios: Readonly<Record<ScriptName, Scenario>> = {
  /** `write <file>`: writes the file, then says so. */
  write: ({ step, args }) => {
    if (step === 0) return write(args, contentOf(args));
    return step === 1 ? { text: `Wrote ${args}.` } : undefined;
  },
  /** `slow <file> <steps> <ms>`: `steps` reads of the README, each `ms` after the last, then the write. */
  slow: ({ step, args }) => {
    const [file = "SLOW.md", stepsText, msText] = args.split(/\s+/);
    const steps = number(stepsText, 5);
    if (step < steps) return read(number(msText, 3000));
    if (step === steps) return write(file, contentOf(file));
    return step === steps + 1 ? { text: `Wrote ${file}, slowly.` } : undefined;
  },
  /** `busy`: a read every 10 s, without end: events keep coming, so only the maximum duration stops it, and it spends little. */
  busy: ({ step }) => (step < 400 ? read(10_000) : undefined),
  /** `stall`: the model never answers and the stream says nothing: no agent event, ever. */
  stall: ({ step }) => (step === 0 ? { text: "never sent", delayMs: 900_000, keepalive: false } : undefined),
  /**
   * `spend <file>`: a write, then reads without end, each with a long answer (about 15,000 output
   * tokens, 0.075 USD at the model's price): a few calls reach a cap of cents, which the key proxy
   * enforces by refusing the next call.
   */
  spend: ({ step, args }) => {
    if (step === 0) return write(args, contentOf(args));
    return step < 200 ? { ...read(200), text: LONG_ANSWER } : undefined;
  },
  /**
   * `unstorable <file>`: writes the file, then answers with a lone UTF-16 surrogate, which Postgres'
   * jsonb refuses (SQLSTATE class 22). A NUL would not do: core stores it as U+FFFD (`storableEvent`).
   */
  unstorable: ({ step, args }) => {
    if (step === 0) return write(args, contentOf(args));
    return step === 1 ? { text: `Wrote ${args}. A broken character: \ud800 and the end.` } : undefined;
  },
  /**
   * `recall <file> <earlier> <steps> <ms>`: `slow`'s reads and write, then an answer that says
   * whether the conversation before this turn's message holds `earlier`, an earlier turn's file:
   * the context a restored session must bring back (ticket 41). The marked message itself names
   * `earlier`, so only the messages before it count.
   */
  recall: ({ step, args, request, since }) => {
    const [file = "RECALL.md", earlier = "", stepsText, msText] = args.split(/\s+/);
    const steps = number(stepsText, 0);
    if (step < steps) return read(number(msText, 3000));
    if (step === steps) return write(file, contentOf(file));
    if (step !== steps + 1) return undefined;
    const before = request.messages.slice(0, Math.max(0, request.messages.length - since.length - 1));
    const remembered = earlier !== "" && conversationText(before).includes(earlier);
    return { text: `Wrote ${file}. ${remembered ? rememberWords(earlier) : forgotWords(earlier)}` };
  },
};

/** The prompt's marker for `script` with its arguments. */
export const marker = (script: ScriptName, args: string): string => stubMarker(script, args);

/** The key the stub accepts: the provider's token in the panel. It is the stub's, not a real secret. */
export const STUB_KEY = "sk-failure-suite-stub-model";

/** Linear stores a description's brackets escaped (`\[\[stub:…\]\]`): the marker is read with them unescaped. */
export const unescapeMarkers = (text: string): string => text.replaceAll(String.raw`\[\[`, "[[").replaceAll(String.raw`\]\]`, "]]");

/** The suite's brain: the scripts above, with a marker Linear escaped read unescaped. */
export const suiteBrain = (): StubBrain => {
  const brain = createScenarioBrain(scenarios);
  return (request) => brain({ ...request, messages: request.messages.map((message) => ({ ...message, text: unescapeMarkers(message.text) })) });
};

export const startStubModel = (): Promise<StubServer> =>
  startAnthropicStub({
    realKey: STUB_KEY,
    models: [STUB_MODEL_ID],
    brain: suiteBrain(),
    host: "127.0.0.1",
  });
