import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLUSH_PKT, encodePkt, encodeRefusal, parseReceivePackHead, readPkt } from '../src/pkt-line.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

const body = (...lines: string[]): Buffer => Buffer.concat([...lines.map((l) => encodePkt(l)), FLUSH_PKT, Buffer.from('PACK...')]);

void test('parses the command list and stops at the flush, before the pack', () => {
  const buf = body(`${A} ${B} refs/heads/ostra/t1\0report-status side-band-64k agent=git/2.53\n`, `${Z} ${B} refs/ostra/wip/t1\n`);
  const r = parseReceivePackHead(buf);
  assert.ok(r.kind === 'parsed');
  assert.deepEqual(
    r.head.commands.map((c) => [c.ref, c.kind]),
    [
      ['refs/heads/ostra/t1', 'update'],
      ['refs/ostra/wip/t1', 'create'],
    ],
  );
  assert.deepEqual(r.head.capabilities, ['report-status', 'side-band-64k', 'agent=git/2.53']);
  assert.equal(buf.subarray(r.head.headLength).toString(), 'PACK...');
});

void test('asks for more bytes when the list is split across chunks', () => {
  const buf = body(`${A} ${B} refs/heads/x\0report-status\n`);
  assert.equal(parseReceivePackHead(buf.subarray(0, 30)).kind, 'need-more');
  assert.equal(parseReceivePackHead(buf.subarray(0, 2)).kind, 'need-more');
});

void test('recognises deletes, shallow lines and the empty probe', () => {
  const del = parseReceivePackHead(body(`shallow ${A}\n`, `${A} ${Z} refs/heads/main\0report-status\n`));
  assert.equal(del.kind === 'parsed' && del.head.commands[0]?.kind, 'delete');
  assert.equal(del.kind === 'parsed' && del.head.shallow.length, 1);
  const probe = parseReceivePackHead(FLUSH_PKT);
  assert.equal(probe.kind === 'parsed' && probe.head.commands.length, 0);
});

void test('fails closed on malformed input and signed pushes', () => {
  assert.equal(parseReceivePackHead(Buffer.from('zzzz')).kind, 'error');
  assert.equal(parseReceivePackHead(Buffer.from('0003')).kind, 'error');
  assert.equal(parseReceivePackHead(body('not a command\n')).kind, 'error');
  assert.equal(parseReceivePackHead(body(`${A} nothex refs/heads/x\n`)).kind, 'error');
  assert.equal(parseReceivePackHead(body('push-cert\0report-status\n')).kind, 'error');
  assert.equal(parseReceivePackHead(body(`${Z} ${Z} refs/heads/x\n`)).kind, 'error');
});

void test('encodes a refusal git can print, in side-band when asked', () => {
  const r = parseReceivePackHead(body(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`));
  assert.ok(r.kind === 'parsed');
  const out = encodeRefusal(r.head, () => 'ostra: no', 'ostra: refused');
  assert.ok(out !== null);
  const first = readPkt(out, 0);
  assert.equal(first.kind === 'packet' && first.packet.kind === 'data' && first.packet.payload[0], 2);
  assert.ok(out.toString('utf8').includes('ng refs/heads/main ostra: no'));
  const plain = parseReceivePackHead(body(`${A} ${B} refs/heads/main\0\n`));
  assert.equal(plain.kind === 'parsed' && encodeRefusal(plain.head, () => 'x', 'x'), null);
});
