// A `multipart/form-data` body's parts by name (RFC 7578), for the HTTP carrier's frames (Q306):
// the `body` part's JSON and each frame's JPEG. The body is read whole first, within its cap, so this
// reads bytes already held. It refuses a body it can't read, a part with no name, a name twice, and
// more parts than `maxParts`. A part's bytes are never logged.

const boundaryPattern = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i;
const namePattern = /^content-disposition:\s*form-data;(?:.*;)?\s*name="([^"]{1,64})"/im;

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

export const parseMultipart = (body: Buffer, contentType: string, maxParts: number): ReadonlyMap<string, Buffer> | null => {
  const found = boundaryPattern.exec(contentType);
  const boundary = found?.[1] ?? found?.[2];
  if (!/^multipart\/form-data/i.test(contentType) || boundary === undefined) {
    return null;
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = new Map<string, Buffer>();
  let at = body.indexOf(delimiter);
  if (at === -1) {
    return null;
  }
  for (;;) {
    at += delimiter.length;
    // The closing delimiter is followed by `--`.
    if (body[at] === 0x2d && body[at + 1] === 0x2d) {
      return parts;
    }
    if (!body.subarray(at, at + 2).equals(CRLF)) {
      return null;
    }
    const headersStart = at + 2;
    const headersEnd = body.indexOf(HEADERS_END, headersStart);
    if (headersEnd === -1 || headersEnd - headersStart > 4_096) {
      return null;
    }
    const name = namePattern.exec(body.subarray(headersStart, headersEnd).toString("latin1"))?.[1];
    const contentStart = headersEnd + HEADERS_END.length;
    const next = body.indexOf(Buffer.concat([CRLF, delimiter]), contentStart);
    if (name === undefined || next === -1 || parts.has(name) || parts.size >= maxParts) {
      return null;
    }
    parts.set(name, body.subarray(contentStart, next));
    at = next + CRLF.length;
  }
};
