import { describe, expect, it } from "vitest";
import { checkPush, parsePushCommands, type PushCommand } from "../src/sidecar/git-proxy.ts";

/** Builds a git-receive-pack command list as pkt-lines, ending with a flush. */
const pktLines = (commands: readonly string[]): Buffer => {
  const parts: Buffer[] = [];
  for (const [index, command] of commands.entries()) {
    const payload = index === 0 ? `${command}\0report-status side-band-64k` : command;
    const line = `${payload}\n`;
    const length = (line.length + 4).toString(16).padStart(4, "0");
    parts.push(Buffer.from(length + line, "utf8"));
  }
  parts.push(Buffer.from("0000", "utf8"));
  return Buffer.concat(parts);
};

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const TASK = "refs/heads/ostra/t-123";
const HIDDEN = "refs/ostra/wip/t-123";

describe("parsePushCommands", () => {
  it("reads the command list up to the flush", () => {
    const parsed = parsePushCommands(pktLines([`${A} ${B} ${TASK}`]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.commands).toEqual<PushCommand[]>([{ oldId: A, newId: B, ref: TASK }]);
  });
  it("rejects a signed push", () => {
    const parsed = parsePushCommands(pktLines(["push-cert something"]));
    expect(parsed.ok).toBe(false);
  });
});

describe("checkPush (ADR 0030, ADR 0031 line 3)", () => {
  const policy = { allowedRefs: [TASK, HIDDEN] };
  it("allows the task branch and the hidden ref", () => {
    expect(checkPush([{ oldId: A, newId: B, ref: TASK }], policy)).toBeUndefined();
    expect(checkPush([{ oldId: ZERO, newId: B, ref: HIDDEN }], policy)).toBeUndefined();
  });
  it("refuses any other ref", () => {
    expect(checkPush([{ oldId: A, newId: B, ref: "refs/heads/main" }], policy)?.code).toBe("ref_refused");
    expect(checkPush([{ oldId: A, newId: B, ref: "refs/heads/ostra/other" }], policy)?.code).toBe("ref_refused");
  });
  it("keeps the ref name out of the log code", () => {
    const refusal = checkPush([{ oldId: A, newId: B, ref: "refs/heads/secret-name" }], policy);
    expect(refusal?.code).not.toContain("secret-name");
    expect(refusal?.message).toContain("secret-name");
  });
  it("refuses a delete (new id all zeros)", () => {
    expect(checkPush([{ oldId: A, newId: ZERO, ref: TASK }], policy)?.code).toBe("delete_refused");
  });
  it("refuses an empty command list", () => {
    expect(checkPush([], policy)?.code).toBe("no_commands");
  });
});
