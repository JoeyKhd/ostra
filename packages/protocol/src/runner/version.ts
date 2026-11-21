import type { z } from "zod";

import { describeIssues, parseJson, utf8ByteLength } from "../json.ts";
import { runnerLimits } from "./limits.ts";

// Versions of the runner protocol (ADR 0034, ADR 0022, F-061). Ported from
// spikes/runner-transport/src/protocol/messages.ts ("versions" and the codec per minor).
//
// - The URL carries the major: `/runner/v1/*`.
// - `hello` and `welcome` negotiate the minor. The server accepts a peer one minor behind or
//   ahead, and both sides speak the lower of the two.
// - Each side keeps a codec for its own minor and the one before, and encodes down to the
//   negotiated minor, because every message but `hello` refuses unknown fields.

/** The protocol's major version, in the URL. */
export const PROTOCOL_MAJOR = 1;

/**
 * This build's minor. Milestone 1 shipped minor 0. Milestone 2 shipped minor 1: sessions across
 * turns, the bulk path, the `release` command, restores and limits. Milestone 3 ships minor 2:
 * approval rules and task rules, questions, plan first, checks, snapshots, services, the
 * profile's skills and MCP servers, and why a token was refused. A minor-1 peer still works inside
 * the window: it's never sent `question-answer`, `plan-answer`, `snapshot-build`, the new spec
 * sections or a token refusal's `reason`, and it sends no new event. Milestone 4 ships minor 3:
 * project memory (`memory.used`, the spec's `memory` section and the sidecar's memory endpoints),
 * the closing turn, a git identity per repo, and the server's held turns, review checks and related
 * PRs. A minor-2 peer still works inside the window: it never receives the spec's `memory`,
 * `agent.closingTurn` or a repo's `gitIdentity` (core folds the memory block into
 * `agent.instructions`), and it sends no `memory.used`. Milestone 5 ships minor 4: the `resume`
 * command, a box's size and image in the dispatch, a snapshot build's push and builder,
 * `box.waiting` and `box.scheduled`, and what a runner offers and how it was installed in `hello`
 * and `status`. A minor-3 peer still works inside the window: it never receives `resume`, the
 * dispatch's `box` or the build's `push` and `builder`, and it sends no `box.waiting`,
 * `box.scheduled`, `resources`, `capabilities` or `install`. A `kubernetes` runner needs minor 4
 * (`refuseHelloExecutor`). Milestone 6 ships minor 5: the refine, review and onboarding tasks'
 * spec sections (`review`, `tools`, `commitPaths`), automatic turns (`automatic` on the dispatch,
 * the steer and the spec, and `question.auto_answered`), the onboarding commit's
 * `commit.filtered`, the rounds' and the follow-ups' intents, and the sidecar's draft, review and
 * environment-proposal endpoints. A minor-4 peer still works inside the window: it's never sent
 * the new spec sections, `automatic` or a new intent, and it's never offered a refine, review or
 * onboarding task or an automatic round (`isTaskOfferable`). A minor-3 peer is outside the window
 * and refused at `hello`. Milestone 7 ships minor 6 (F-138): an agent's subagents, as
 * `subagent.started` and `subagent.status`, and the subagent on `agent.message`, `agent.thought`,
 * `tool.called`, `plan.updated` and `approval.requested`; and the spec's `agent.repoSkills`
 * (F-021, 2026-11-21), whether the repos' own skills reach the agent. A minor-5 peer still works
 * inside the window: a minor-6 runner sends it neither event and no subagent field, so its
 * subagents' calls show flat, and a minor-5 runner sends none; it's never sent `agent.repoSkills`,
 * nor offered a task whose project keeps the repos' own skills off (`isTaskOfferable`). A minor-4
 * peer is outside the window. Milestone 8 ships minor 7 (ADR 0068): the environment's app
 * processes, the after-turn screenshots, a service's preview and the `app` tools in the spec; the
 * dispatch's purpose, `app.start`, `app.stop`, `screenshot.take` and the `preview.*` commands;
 * `app.process`, `app.browser`, `attachment.added` and `preview.list`; the preview connection
 * (`preview.ts`); what a runner can preview in `hello` and `status`; and the credentials' names of a
 * library MCP server's plain headers (`plainHeaders`, F-145, 2026-11-21), so the environment check
 * searches for the secret ones only. A minor-6 peer still works inside the window: it's never sent
 * any of them (so it searches for every header, as before), never offered a task with app processes
 * or the app tools (`isTaskOfferable`), and no view of its tasks opens (`isPreviewable`), so the pane
 * says the runner needs upgrading. A minor-5 peer is outside the window.
 */
export const PROTOCOL_MINOR = 7;

/** The URL prefix of every runner endpoint. */
export const RUNNER_PATH_PREFIX = `/runner/v${String(PROTOCOL_MAJOR)}`;

/** The minors a server at `serverMinor` accepts: one behind to one ahead. */
export type MinorWindow = { readonly min: number; readonly max: number };

export const minorWindow = (serverMinor: number): MinorWindow => ({
  min: Math.max(0, serverMinor - 1),
  max: serverMinor + 1,
});

/**
 * The words a runner outside the window is refused with (F-061), on either carrier: its minor, the
 * window, and the version to install. The runner shows them as they are, in its log and in
 * `ostra runner status`, and the panel lists it as outdated.
 */
export const versionRefusalMessage = (input: {
  readonly peerMajor: number;
  readonly peerMinor: number;
  readonly window: MinorWindow;
  /** The server's release, which the runner installs: `serverVersion` in `GET /runner/v1/info`. */
  readonly serverVersion: string;
}): string => {
  const major = String(PROTOCOL_MAJOR);
  return (
    `This runner speaks protocol ${String(input.peerMajor)}.${String(input.peerMinor)}; this server accepts ` +
    `${major}.${String(input.window.min)} to ${major}.${String(input.window.max)}. Update it to v${input.serverVersion}. ` +
    `Fix: install the runner version this server names (GET ${RUNNER_PATH_PREFIX}/info), then start the runner again.`
  );
};

export type Negotiation =
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly reason: "major" | "minor"; readonly window: MinorWindow };

/** The server's answer to a peer's `hello` versions (ADR 0034). */
export const negotiate = (serverMinor: number, peerMajor: number, peerMinor: number): Negotiation => {
  const window = minorWindow(serverMinor);
  if (peerMajor !== PROTOCOL_MAJOR) {
    return { ok: false, reason: "major", window };
  }
  if (!Number.isInteger(peerMinor) || peerMinor < window.min || peerMinor > window.max) {
    return { ok: false, reason: "minor", window };
  }
  return { ok: true, minor: Math.min(serverMinor, peerMinor) };
};

// ---------- codecs ----------

/**
 * One minor's shape of a frame set. `decode` validates a frame written in that minor and lifts it
 * to the current type. `encode` writes a current frame in that minor's shape, dropping or filling
 * the fields that minor doesn't know.
 */
export type MinorCodec<Frame> = {
  readonly minor: number;
  readonly decode: z.ZodType<Frame>;
  readonly encode: (frame: Frame) => unknown;
};

export type FrameParseError = {
  /** `too-large`: over the frame cap. `not-json`: not JSON text. `invalid`: JSON, but not a frame. */
  readonly reason: "too-large" | "not-json" | "invalid";
  /** Paths and rules only, never values: safe to log. */
  readonly detail: string;
};

export type FrameParse<Frame> =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: FrameParseError };

export type VersionedCodec<Frame> = {
  /** The minors this codec set can read and write, oldest first. */
  readonly minors: readonly number[];
  /** Parses one frame's text written at `minor`. Never throws. */
  readonly parse: (text: string, minor: number) => FrameParse<Frame>;
  /** Parses an already-decoded JSON value written at `minor` (the HTTP carrier's arrays). */
  readonly parseValue: (value: unknown, minor: number) => FrameParse<Frame>;
  /** A current frame as the JSON value a peer at `minor` reads. */
  readonly encodeValue: (frame: Frame, minor: number) => unknown;
  /** A current frame as the text a peer at `minor` reads. */
  readonly encode: (frame: Frame, minor: number) => string;
};

/**
 * Builds a codec set from one codec per kept minor. A minor between two kept ones uses the newest
 * codec at or below it; a minor below the oldest uses the oldest.
 */
export const createVersionedCodec = <Frame>(
  codecs: readonly MinorCodec<Frame>[],
): VersionedCodec<Frame> => {
  const sorted = [...codecs].sort((a, b) => a.minor - b.minor);
  const oldest = sorted[0];
  if (oldest === undefined) {
    throw new Error("a versioned codec needs at least one minor");
  }
  const codecFor = (minor: number): MinorCodec<Frame> => {
    let chosen = oldest;
    for (const codec of sorted) {
      if (codec.minor <= minor) {
        chosen = codec;
      }
    }
    return chosen;
  };
  const parseValue = (value: unknown, minor: number): FrameParse<Frame> => {
    const result = codecFor(minor).decode.safeParse(value);
    return result.success
      ? { ok: true, frame: result.data }
      : { ok: false, error: { reason: "invalid", detail: describeIssues(result.error) } };
  };
  const encodeValue = (frame: Frame, minor: number): unknown => codecFor(minor).encode(frame);
  return {
    minors: sorted.map((codec) => codec.minor),
    parse: (text, minor) => {
      const bytes = utf8ByteLength(text);
      if (bytes > runnerLimits.frameMaxBytes) {
        return {
          ok: false,
          error: { reason: "too-large", detail: `${String(bytes)} bytes, over ${String(runnerLimits.frameMaxBytes)}` },
        };
      }
      const json = parseJson(text);
      if (!json.ok) {
        return { ok: false, error: { reason: "not-json", detail: "the frame is not JSON" } };
      }
      return parseValue(json.value, minor);
    },
    parseValue,
    encodeValue,
    encode: (frame, minor) => JSON.stringify(encodeValue(frame, minor)),
  };
};
