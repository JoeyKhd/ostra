import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mintFakeToken, verifyFakeToken } from '../src/fake-token.ts';

const key = 'k'.repeat(32);

void test("has GitHub's stateless shape and length: ghs_<APPID>_<JWT>, about 520 characters", () => {
  const { token } = mintFakeToken(key, 60_000);
  assert.match(token, /^ghs_\d+_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // GitHub's suggested pattern (research/platform-auth-github.md §2.4).
  assert.match(token, /^ghs_[A-Za-z0-9.\-_]{36,}$/);
  assert.ok(token.length >= 515 && token.length <= 530, String(token.length));
});

void test('verifies a fresh token, and refuses an expired, forged or altered one', () => {
  const fresh = mintFakeToken(key, 60_000);
  const check = verifyFakeToken(key, fresh.token);
  assert.deepEqual(check, { ok: true, jti: fresh.jti });
  assert.deepEqual(verifyFakeToken(key, mintFakeToken(key, -1).token), { ok: false, reason: 'expired' });
  assert.deepEqual(verifyFakeToken('other'.repeat(8), fresh.token), { ok: false, reason: 'signature' });
  assert.deepEqual(verifyFakeToken(key, `${fresh.token.slice(0, -2)}xx`), { ok: false, reason: 'signature' });
  assert.deepEqual(verifyFakeToken(key, 'ghs_not-a-token'), { ok: false, reason: 'malformed' });
});
