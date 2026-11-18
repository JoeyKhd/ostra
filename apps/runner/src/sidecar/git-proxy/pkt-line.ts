// Git's pkt-line framing (gitprotocol-common), and the head of a git-receive-pack request body
// (gitprotocol-pack, "Reference Update Request"):
//
//   [shallow <oid>]*  <old-oid> <new-oid> <refname>\0<capabilities>  (<old> <new> <ref>)*  0000  [push options 0000]  PACK...
//
// The git proxy reads only up to the first flush-pkt, decides, and forwards nothing at all if it
// refuses. Ported from spikes/github-app-and-git-proxy/src/pkt-line.ts.

const MAX_PKT_LEN = 65520;
/** The longest command list the proxy reads before it decides. */
export const MAX_COMMAND_HEAD_BYTES = 1024 * 1024;

export const encodePkt = (payload: string | Uint8Array): Buffer => {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const length = body.length + 4;
  if (length > MAX_PKT_LEN) {
    throw new RangeError("pkt-line payload too long");
  }
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, "0"), "ascii"), body]);
};

export const FLUSH_PKT = Buffer.from("0000", "ascii");

export type PktPacket =
  | { readonly kind: "data"; readonly payload: Buffer }
  | { readonly kind: "flush" }
  | { readonly kind: "delim" }
  | { readonly kind: "response-end" };

export type PktReadResult =
  | { readonly kind: "need-more" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "packet"; readonly packet: PktPacket; readonly next: number };

export const readPkt = (buffer: Buffer, offset: number): PktReadResult => {
  if (buffer.length - offset < 4) {
    return { kind: "need-more" };
  }
  const lengthHex = buffer.toString("ascii", offset, offset + 4);
  if (!/^[0-9a-f]{4}$/i.test(lengthHex)) {
    return { kind: "error", reason: "bad-pkt-length" };
  }
  const length = Number.parseInt(lengthHex, 16);
  if (length === 0) {
    return { kind: "packet", packet: { kind: "flush" }, next: offset + 4 };
  }
  if (length === 1) {
    return { kind: "packet", packet: { kind: "delim" }, next: offset + 4 };
  }
  if (length === 2) {
    return { kind: "packet", packet: { kind: "response-end" }, next: offset + 4 };
  }
  if (length === 3 || length > MAX_PKT_LEN) {
    return { kind: "error", reason: "bad-pkt-length" };
  }
  if (buffer.length - offset < length) {
    return { kind: "need-more" };
  }
  return { kind: "packet", packet: { kind: "data", payload: buffer.subarray(offset + 4, offset + length) }, next: offset + length };
};

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isZeroOid = (oid: string): boolean => /^0+$/.test(oid);

export type RefUpdateCommand = {
  readonly oldId: string;
  readonly newId: string;
  readonly ref: string;
  readonly kind: "create" | "update" | "delete";
};

export type ReceivePackHead = {
  readonly shallow: readonly string[];
  readonly commands: readonly RefUpdateCommand[];
  readonly capabilities: readonly string[];
  /** Bytes of the body up to and including the flush-pkt that ends the command list. */
  readonly headLength: number;
};

export type ReceivePackHeadResult =
  | { readonly kind: "need-more" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "parsed"; readonly head: ReceivePackHead };

const stripLf = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

export const parseReceivePackHead = (buffer: Buffer): ReceivePackHeadResult => {
  const shallow: string[] = [];
  const commands: RefUpdateCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset > MAX_COMMAND_HEAD_BYTES) {
      return { kind: "error", reason: "command-list-too-long" };
    }
    const read = readPkt(buffer, offset);
    if (read.kind === "need-more") {
      return buffer.length > MAX_COMMAND_HEAD_BYTES ? { kind: "error", reason: "command-list-too-long" } : read;
    }
    if (read.kind === "error") {
      return read;
    }
    offset = read.next;
    const packet = read.packet;
    if (packet.kind === "flush") {
      return { kind: "parsed", head: { shallow, commands, capabilities, headLength: offset } };
    }
    if (packet.kind !== "data") {
      return { kind: "error", reason: "unexpected-special-pkt" };
    }
    let line = stripLf(packet.payload.toString("utf8"));
    if (commands.length === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(" ")
          .filter((capability) => capability.length > 0);
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith("push-cert")) {
      return { kind: "error", reason: "signed-push-unsupported" };
    }
    if (line.startsWith("shallow ")) {
      if (commands.length > 0) {
        return { kind: "error", reason: "shallow-after-command" };
      }
      const oid = line.slice("shallow ".length);
      if (!OID.test(oid)) {
        return { kind: "error", reason: "bad-oid" };
      }
      shallow.push(oid);
      continue;
    }
    const parts = line.split(" ");
    const [oldId, newId, ref] = parts;
    if (parts.length !== 3 || oldId === undefined || newId === undefined || ref === undefined) {
      return { kind: "error", reason: "bad-command" };
    }
    if (!OID.test(oldId) || !OID.test(newId)) {
      return { kind: "error", reason: "bad-oid" };
    }
    if (isZeroOid(oldId) && isZeroOid(newId)) {
      return { kind: "error", reason: "bad-command" };
    }
    const kind = isZeroOid(newId) ? "delete" : isZeroOid(oldId) ? "create" : "update";
    commands.push({ oldId, newId, ref, kind });
  }
};

/**
 * A report-status answer (gitprotocol-pack, "Report Status") that refuses every command, wrapped in
 * side-band-64k when the client asked for it, so stock git prints
 * `! [remote rejected] <ref> (<reason>)`. `null` when the client asked for no report.
 */
export const encodeRefusal = (
  head: ReceivePackHead,
  reasonFor: (command: RefUpdateCommand) => string,
  humanMessage: string,
): Buffer | null => {
  const capabilities = new Set(head.capabilities);
  if (!capabilities.has("report-status") && !capabilities.has("report-status-v2")) {
    return null;
  }
  const report = Buffer.concat([
    encodePkt("unpack ok\n"),
    ...head.commands.map((command) => encodePkt(`ng ${command.ref} ${reasonFor(command)}\n`)),
    FLUSH_PKT,
  ]);
  if (!capabilities.has("side-band-64k") && !capabilities.has("side-band")) {
    return report;
  }
  const max = capabilities.has("side-band-64k") ? 65515 : 995;
  const frames: Buffer[] = [encodePkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${humanMessage}\n`, "utf8")]))];
  for (let index = 0; index < report.length; index += max) {
    frames.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(index, index + max)])));
  }
  frames.push(FLUSH_PKT);
  return Buffer.concat(frames);
};

/**
 * The receive-pack advertisement of an empty repo, which the proxy answers itself for a repo the
 * task may not push to: git then sends its push, the proxy refuses it in git's own words, and no
 * request for that repo ever reaches the code host.
 */
export const emptyReceivePackAdvertisement = (agent: string): Buffer =>
  Buffer.concat([
    encodePkt("# service=git-receive-pack\n"),
    FLUSH_PKT,
    encodePkt(
      `${"0".repeat(40)} capabilities^{}\0report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=${agent}\n`,
    ),
    FLUSH_PKT,
  ]);
