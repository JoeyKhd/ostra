import { taskEventSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";

// Postgres' jsonb can't hold the NUL character (SQLSTATE 22P05), and an agent's tool output can
// carry one, from a binary file it read or a program's output. Such an event is stored with each NUL
// replaced by U+FFFD, the replacement character: the rest of the event is kept as it was.

const NUL = "\u0000";
const REPLACEMENT = "�";
/** How JSON writes a NUL. A literal backslash-u0000 in the text matches too, and only costs a re-parse. */
const ESCAPED_NUL = String.raw`\u0000`;

const withoutNul = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replaceAll(NUL, REPLACEMENT);
  }
  if (Array.isArray(value)) {
    return value.map(withoutNul);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replaceAll(NUL, REPLACEMENT), withoutNul(item)]));
  }
  return value;
};

/** The event as jsonb can store it. Most events have no NUL and come back as they are. */
export const storableEvent = (event: TaskEvent): TaskEvent => {
  if (!JSON.stringify(event).includes(ESCAPED_NUL)) {
    return event;
  }
  return taskEventSchema.parse(withoutNul(event));
};
