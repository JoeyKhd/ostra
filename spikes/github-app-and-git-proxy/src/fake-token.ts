import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Fake installation tokens for the local stand-in, in the shape of GitHub's
// stateless ones: `ghs_<APPID>_<JWT>`, about 520 characters, with dots
// (research/platform-auth-github.md §2.4). The stand-in verifies them with an
// HMAC key and refuses an expired one, so the harness can test re-minting.
// Not secrets, but the agent must never see them, exactly as if they were.

export const FAKE_APP_ID = 424242;
const TARGET_LENGTH = 520;

const TOKEN = /^ghs_(\d+)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

const ClaimsSchema = z.object({ iss: z.number().int(), exp: z.number(), jti: z.string().min(1) }).loose();

export type FakeToken = { readonly token: string; readonly expiresAt: string; readonly jti: string };

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const sign = (key: string, data: string): string => createHmac('sha256', key).update(data).digest('base64url');

export const mintFakeToken = (key: string, validForMs: number): FakeToken => {
  const now = Date.now();
  const jti = randomBytes(8).toString('hex');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // exp in milliseconds, so a token can be made to expire within seconds.
  const claims = { iss: FAKE_APP_ID, iat: now, exp: now + validForMs, jti, repositories: ['spike-repo'], permissions: { contents: 'write' } };
  const build = (pad: string): string => {
    const payload = b64url(JSON.stringify({ ...claims, pad }));
    return `ghs_${String(FAKE_APP_ID)}_${header}.${payload}.${sign(key, `${header}.${payload}`)}`;
  };
  const short = build('');
  const token = build('p'.repeat(Math.max(0, Math.ceil(((TARGET_LENGTH - short.length) * 3) / 4))));
  return { token, expiresAt: new Date(now + validForMs).toISOString(), jti };
};

export type FakeTokenCheck =
  | { readonly ok: true; readonly jti: string }
  | { readonly ok: false; readonly reason: 'malformed' | 'signature' | 'expired' };

export const verifyFakeToken = (key: string, token: string): FakeTokenCheck => {
  const m = TOKEN.exec(token);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(key, `${m[2]}.${m[3]}`));
  const got = Buffer.from(m[4]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: 'signature' };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(m[3], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const claims = ClaimsSchema.safeParse(json);
  if (!claims.success || String(claims.data.iss) !== m[1]) return { ok: false, reason: 'malformed' };
  if (claims.data.exp <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, jti: claims.data.jti };
};
