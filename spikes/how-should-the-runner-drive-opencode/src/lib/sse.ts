// Incremental Server-Sent Events parser. It is fed raw byte chunks exactly as
// they arrive and calls back once per complete event. It never buffers more
// than one unfinished line plus one unfinished event.

export type SseEvent = {
  readonly event: string | undefined;
  readonly data: string;
};

export type SseParser = {
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => void;
};

export const createSseParser = (onEvent: (event: SseEvent) => void): SseParser => {
  const decoder = new TextDecoder();
  let pending = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      onEvent({ event: eventName, data: dataLines.join("\n") });
    }
    eventName = undefined;
    dataLines = [];
  };

  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      default:
        break;
    }
  };

  const drain = (): void => {
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      processLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  };

  return {
    push: (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      drain();
    },
    end: () => {
      pending += decoder.decode();
      drain();
      if (pending !== "") processLine(pending);
      pending = "";
      dispatch();
    },
  };
};
