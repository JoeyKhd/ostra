// Reads the raw message the fake SMTP server took, for the tests: the headers, the subject with its
// encoded words decoded, and the text and HTML parts with their transfer encoding undone. Just
// enough MIME for what nodemailer writes (a `multipart/alternative` of a text and an HTML part).
// It reads; it never sends, so it isn't part of the adapter's public surface.

export type ReadMail = {
  /** Header names in lower case, folded lines joined. The last of a repeated header wins. */
  readonly headers: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly messageId: string;
  readonly text: string;
  readonly html: string;
};

type Part = { readonly headers: Readonly<Record<string, string>>; readonly body: string };

const splitHead = (raw: string): Part => {
  const separator = raw.indexOf("\r\n\r\n");
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? "" : raw.slice(separator + 4);
  const headers: Record<string, string> = {};
  for (const line of head.replaceAll(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return { headers, body };
};

const decodeQuotedPrintable = (body: string): string =>
  Buffer.from(
    body
      .replaceAll(/=\r\n/g, "")
      .replaceAll(/=([0-9A-F]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
    "latin1",
  ).toString("utf8");

const decodeBody = (part: Part): string => {
  switch ((part.headers["content-transfer-encoding"] ?? "7bit").toLowerCase()) {
    case "quoted-printable":
      return decodeQuotedPrintable(part.body);
    case "base64":
      return Buffer.from(part.body.replaceAll(/\s+/g, ""), "base64").toString("utf8");
    default:
      return part.body;
  }
};

/** RFC 2047 encoded words in a header (`=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=`). */
const decodeWords = (value: string): string =>
  value
    .replaceAll(/(\?=)\s+(=\?)/g, "$1$2")
    .replaceAll(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_match, encoding: string, text: string) =>
      encoding.toLowerCase() === "b"
        ? Buffer.from(text, "base64").toString("utf8")
        : decodeQuotedPrintable(text.replaceAll("_", " ")),
    );

const boundaryOf = (contentType: string): string | undefined => /boundary="?([^";]+)"?/i.exec(contentType)?.[1];

/** The leaf parts of a message, however deep its multiparts go. */
const leaves = (part: Part): readonly Part[] => {
  const contentType = part.headers["content-type"] ?? "text/plain";
  const boundary = boundaryOf(contentType);
  if (!contentType.toLowerCase().startsWith("multipart/") || boundary === undefined) {
    return [part];
  }
  return part.body
    .split(`--${boundary}`)
    .slice(1)
    .filter((chunk) => !chunk.startsWith("--"))
    .flatMap((chunk) => leaves(splitHead(chunk.replace(/^\r\n/, "").replace(/\r\n$/, ""))));
};

export const readMail = (raw: string): ReadMail => {
  const message = splitHead(raw);
  const parts = leaves(message);
  const bodyOf = (type: string): string => {
    const found = parts.find((part) => (part.headers["content-type"] ?? "text/plain").toLowerCase().startsWith(type));
    return found === undefined ? "" : decodeBody(found);
  };
  return {
    headers: message.headers,
    subject: decodeWords(message.headers["subject"] ?? ""),
    messageId: message.headers["message-id"] ?? "",
    text: bodyOf("text/plain"),
    html: bodyOf("text/html"),
  };
};
