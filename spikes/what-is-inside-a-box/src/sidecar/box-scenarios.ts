// The scripts the stub model plays in a box (the stub runs inside the
// sidecar, behind the key proxy, when the handoff says `model.kind: "stub"`).
// Shell commands use `node -e`, which the base image has, so they run the
// same in a box and in the loopback rehearsal on Windows. Arguments are
// checked against strict patterns and passed as separate argv entries, never
// spliced into the script.

import type { Scenario } from "../lib/stub-models/scenario.ts";
import type { StubReply } from "../lib/stub-models/types.ts";

const DIGITS = /^\d{1,6}$/;
const BAD_ARGS: StubReply = { text: "stub: bad args" };

const sleepCommand = (seconds: number): string => `node -e "setTimeout(()=>{},Number(process.argv[1])*1000)" ${String(seconds)} ostra-box-sleep`;

/** A server that keeps running in the background, and a grandchild that leaves the process group. */
const treeCommand = `node -e "require('http').createServer().listen(0);require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)','ostra-box-orphan'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)" ostra-box-server`;

export const boxScenarios: Readonly<Record<string, Scenario>> = {
  hello: ({ step }) => (step === 0 ? { text: "hello from the box" } : undefined),

  /** args: <seconds>. One shell step that runs that long: the 20-minute turn over the bridge. */
  long: ({ step, args }) => {
    if (!DIGITS.test(args)) return step === 0 ? BAD_ARGS : undefined;
    const seconds = Number(args);
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(seconds), timeout: (seconds + 120) * 1000, description: "wait" } }] };
    }
    if (step === 1) return { text: `waited ${String(seconds)} s` };
    return undefined;
  },

  /** One edit under an `ask` rule. The harness holds the approval while the attack checklist runs. */
  approval: ({ step }) => {
    if (step === 0) return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, approved" } }] };
    if (step === 1) return { text: "edit step finished" };
    return undefined;
  },

  /** Background processes, then a long step to stop the task in. */
  tree: ({ step }) => {
    if (step === 0) return { toolCalls: [{ name: "shell", arguments: { command: treeCommand, background: true, description: "start helpers" } }] };
    if (step === 1) return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(600), timeout: 900_000, description: "wait" } }] };
    if (step === 2) return { text: "tree done" };
    return undefined;
  },
};

export const boxAuxiliary = (): StubReply => ({ text: "Box task" });
