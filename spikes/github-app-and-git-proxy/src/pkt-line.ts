// Git's pkt-line framing (gitprotocol-common), and the head of a
// git-receive-pack request body (gitprotocol-pack, "Reference Update Request"):
//
//   [shallow <oid>]*  <old-oid> <new-oid> <refname>\0<capabilities>  (<old> <new> <ref>)*  0000  [push options 0000]  PACK...
//
// The proxy reads only up to the first flush-pkt, decides, and forwards
// nothing at all if it refuses.

const MAX_PKT_LEN = 65520;
export const MAX_COMMAND_HEAD_BYTES = 1024 * 1024;

export const encodePkt = (payload: string | Uint8Array): Buffer => {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length + 4;
  if (length > MAX_PKT_LEN) throw new RangeError('pkt-line payload too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
};

export const FLUSH_PKT = Buffer.from('0000', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export type PktReadResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'packet'; readonly packet: PktPacket; readonly next: number };

export const readPkt = (buf: Buffer, offset: number): PktReadResult => {
  if (buf.length - offset < 4) return { kind: 'need-more' };
  const lenHex = buf.toString('ascii', offset, offset + 4);
  if (!/^[0-9a-f]{4}$/i.test(lenHex)) return { kind: 'error', reason: 'bad-pkt-length' };
  const len = Number.parseInt(lenHex, 16);
  switch (len) {
    case 0:
      return { kind: 'packet', packet: { kind: 'flush' }, next: offset + 4 };
    case 1:
      return { kind: 'packet', packet: { kind: 'delim' }, next: offset + 4 };
    case 2:
      return { kind: 'packet', packet: { kind: 'response-end' }, next: offset + 4 };
    case 3:
      return { kind: 'error', reason: 'bad-pkt-length' };
    default:
      break;
  }
  if (len > MAX_PKT_LEN) return { kind: 'error', reason: 'bad-pkt-length' };
  if (buf.length - offset < len) return { kind: 'need-more' };
  return { kind: 'packet', packet: { kind: 'data', payload: buf.subarray(offset + 4, offset + len) }, next: offset + len };
};

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isZeroOid = (oid: string): boolean => /^0+$/.test(oid);

export type RefUpdateCommand = {
  readonly oldId: string;
  readonly newId: string;
  readonly ref: string;
  readonly kind: 'create' | 'update' | 'delete';
};

export type ReceivePackHead = {
  readonly shallow: readonly string[];
  readonly commands: readonly RefUpdateCommand[];
  readonly capabilities: readonly string[];
  // Bytes of the body up to and including the flush-pkt that ends the command list.
  readonly headLength: number;
};

export type ReceivePackHeadResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'parsed'; readonly head: ReceivePackHead };

const stripLf = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);

export const parseReceivePackHead = (buf: Buffer): ReceivePackHeadResult => {
  const shallow: string[] = [];
  const commands: RefUpdateCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset > MAX_COMMAND_HEAD_BYTES) return { kind: 'error', reason: 'command-list-too-long' };
    const read = readPkt(buf, offset);
    if (read.kind === 'need-more') {
      return buf.length > MAX_COMMAND_HEAD_BYTES ? { kind: 'error', reason: 'command-list-too-long' } : read;
    }
    if (read.kind === 'error') return read;
    offset = read.next;
    const packet = read.packet;
    switch (packet.kind) {
      case 'flush':
        return { kind: 'parsed', head: { shallow, commands, capabilities, headLength: offset } };
      case 'delim':
      case 'response-end':
        return { kind: 'error', reason: 'unexpected-special-pkt' };
      case 'data':
        break;
      default:
        packet satisfies never;
        return { kind: 'error', reason: 'unexpected-pkt' };
    }
    let line = stripLf(packet.payload.toString('utf8'));
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(' ')
          .filter((c) => c.length > 0);
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith('push-cert')) return { kind: 'error', reason: 'signed-push-unsupported' };
    if (line.startsWith('shallow ')) {
      if (commands.length > 0) return { kind: 'error', reason: 'shallow-after-command' };
      const oid = line.slice('shallow '.length);
      if (!OID.test(oid)) return { kind: 'error', reason: 'bad-oid' };
      shallow.push(oid);
      continue;
    }
    const parts = line.split(' ');
    const [oldId, newId, ref] = parts;
    if (parts.length !== 3 || oldId === undefined || newId === undefined || ref === undefined) {
      return { kind: 'error', reason: 'bad-command' };
    }
    if (!OID.test(oldId) || !OID.test(newId)) return { kind: 'error', reason: 'bad-oid' };
    if (isZeroOid(oldId) && isZeroOid(newId)) return { kind: 'error', reason: 'bad-command' };
    const kind = isZeroOid(newId) ? 'delete' : isZeroOid(oldId) ? 'create' : 'update';
    commands.push({ oldId, newId, ref, kind });
  }
};

// A report-status answer (gitprotocol-pack, "Report Status") that refuses
// every command, wrapped in side-band-64k when the client asked for it, so
// stock git prints "! [remote rejected] <ref> (<reason>)".
export const encodeRefusal = (
  head: ReceivePackHead,
  reasonFor: (command: RefUpdateCommand) => string,
  humanMessage: string,
): Buffer | null => {
  const caps = new Set(head.capabilities);
  if (!caps.has('report-status') && !caps.has('report-status-v2')) return null;
  const report = Buffer.concat([
    encodePkt('unpack ok\n'),
    ...head.commands.map((c) => encodePkt(`ng ${c.ref} ${reasonFor(c)}\n`)),
    FLUSH_PKT,
  ]);
  if (!caps.has('side-band-64k') && !caps.has('side-band')) return report;
  const max = caps.has('side-band-64k') ? 65515 : 995;
  const frames: Buffer[] = [encodePkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${humanMessage}\n`, 'utf8')]))];
  for (let i = 0; i < report.length; i += max) {
    frames.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + max)])));
  }
  frames.push(FLUSH_PKT);
  return Buffer.concat(frames);
};
