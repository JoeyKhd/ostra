import { fileBoxPathOf, MESSAGE_FILES_FOLDER, SAFE_FILE_NAME_MAX_CHARS, safeFileNameSchema, TICKET_FILES_FOLDER } from "@ostra/protocol";
import type { MessageFileOrigin, SafeFileName } from "@ostra/protocol";

// Where each file goes in the box (ADR 0070, Q333, spec section 5.4): under the workspace root's
// `.ostra/`, a message's files in `attachments/<n>/`, where `<n>` is the message's number in the
// task's log, and the ticket's in `ticket/`. Names are the protocol's safe names, made unique in
// their folder as `name (2).ext`. Folders are compared without case: the `host` executor's disk on
// Windows and macOS holds `Spec.pdf` and `spec.pdf` as one file.

/** A name's stem and extension: `spec (2).docx` is `spec (2)` and `.docx`; a name without a dot has none. */
const splitName = (name: string): { readonly stem: string; readonly extension: string } => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: "" };
};

/** The `n`th name of a folder that holds `name` already: `spec (2).docx`, cut in its stem to fit. */
const numbered = (name: SafeFileName, n: number): SafeFileName => {
  const { stem, extension } = splitName(name);
  const suffix = ` (${String(n)})`;
  const room = SAFE_FILE_NAME_MAX_CHARS - suffix.length - extension.length;
  return safeFileNameSchema.parse(`${stem.slice(0, room).replace(/[. ]+$/, "")}${suffix}${extension}`);
};

/**
 * Each name in its folder, unique there without case, in order: the first `spec.pdf` keeps its
 * name, the next is `spec (2).pdf`. `taken` holds the names the folder already has (the ticket's
 * folder across reads of the ticket).
 */
export const uniqueNames = (names: readonly SafeFileName[], taken: readonly string[] = []): readonly SafeFileName[] => {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      candidate = numbered(name, n);
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

/**
 * The places of a message's files under `.ostra/` (ADR 0070): `attachments/<seq>/<name>` for a
 * member's, `ticket/<name>` for a ticket's, each name unique in its folder. `taken` holds the names
 * the folder already has: the ticket's earlier files, as a later read of the ticket adds to it.
 */
export const boxPathFor = (
  origin: MessageFileOrigin,
  seq: number,
  names: readonly SafeFileName[],
  taken: readonly string[] = [],
): readonly string[] =>
  uniqueNames(names, taken).map((name) =>
    origin === "member" ? fileBoxPathOf({ folder: MESSAGE_FILES_FOLDER, seq, name }) : fileBoxPathOf({ folder: TICKET_FILES_FOLDER, name }),
  );
